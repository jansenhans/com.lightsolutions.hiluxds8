'use strict';

const http = require('http');
const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

const ScriptBuilder = require('./lib/I4ScriptBuilder');
const Deployer = require('./lib/I4Deployer');

const REBUILD_DEBOUNCE_MS = 3000;
const REBUILD_INTERVAL_MS = 5 * 60 * 1000; // catch zone moves and drift
const DEPLOY_RETRY_DELAY_MS = 10000;
const NOTIFY_AFTER_CONSECUTIVE_FAILURES = 3; // ~15 min of real outage
const NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const LIGHT_DRIVER = 'hilux-ds8';
const BUTTON_DRIVER = 'hilux-i4-button';
const GROUP_DRIVER = 'hilux-group';
const PUSH_PORT = 4820; // local HTTP receiver for light-state push
const GROUP_REFRESH_DEBOUNCE_MS = 700; // lets a nudged poll land first

function num(value, fallback) {
  return typeof value === 'number' && !Number.isNaN(value) ? value : fallback;
}

// Numeric IP sort: the first light is a cluster/group's reference, so the
// order must be predictable ("192.168.0.100" must not sort before ".21")
function sortAddresses(addresses) {
  return addresses.slice().sort((a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
  });
}

class HiluxDS8App extends Homey.App {
  async onInit() {
    this.log('HiluX DS8 app has been initialized');

    this._rebuilding = false;
    this._rebuildQueued = false;
    this._rebuildTimer = null;
    this._notifiedEmptyZones = new Set();

    this._api = await HomeyAPI.createAppAPI({ homey: this.homey });
    this._deployedHashes = new Map(); // i4 address -> last deployed config hash
    this._deployFailures = new Map(); // i4 address -> consecutive failure count
    this._failureNotifiedAt = new Map(); // i4 address -> last notification ts

    // Keep the device cache live and react to zone moves / renames instantly.
    // Without connect(), getDevices() serves a snapshot from app startup and
    // zone changes are never seen.
    await this._api.devices.connect();
    const appPrefix = `homey:app:${this.homey.manifest.id}:`;
    const onDeviceEvent = (device) => {
      if (device && device.driverId && device.driverId.startsWith(appPrefix)) {
        this.scheduleRebuild('device event');
      }
    };
    this._api.devices.on('device.update', onDeviceEvent);
    this._api.devices.on('device.create', onDeviceEvent);
    this._api.devices.on('device.delete', onDeviceEvent);

    // Push receiver: lights (webhooks) and i4 scripts (gesture pings) hit
    // http://<homey>:4820/hilux-push/<light-ip> the moment state changes, so
    // tiles follow in about a second instead of a poll cycle.
    this._groupRefreshTimer = null;
    this._pushServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      const m = /^\/hilux-push\/(\d+\.\d+\.\d+\.\d+)$/.exec((req.url || '').split('?')[0]);
      if (m) this.lightStateTouched(m[1]);
    });
    this._pushServer.on('error', (err) => this.error('Push server error:', err.message));
    this._pushServer.listen(PUSH_PORT, () => this.log(`Push receiver listening on :${PUSH_PORT}`));

    // First rebuild shortly after startup (lets drivers finish init), then a
    // periodic full verify (force) that also heals an i4 that was rebooted
    // or factory-reset behind our back.
    this.homey.setTimeout(() => this._rebuildAll('app start', true).catch((e) => this.error(e)), 15000);
    this.homey.setInterval(() => this._rebuildAll('periodic', true).catch((e) => this.error(e)), REBUILD_INTERVAL_MS);
  }

  async onUninit() {
    if (this._pushServer) this._pushServer.close();
  }

  // Base URL for state-push callbacks, baked into webhooks and i4 scripts.
  async getPushBaseUrl() {
    const address = await this.homey.cloud.getLocalAddress();
    return `http://${address.split(':')[0]}:${PUSH_PORT}/hilux-push/`;
  }

  // A light's state changed (webhook, i4 gesture ping, or a group broadcast):
  // poll it right away and refresh group tiles once things settle.
  lightStateTouched(address) {
    const dev = this._lightDevicesByAddress().get(address);
    if (dev && typeof dev.poll === 'function') dev.poll().catch(() => {});
    this.scheduleGroupTileRefresh();
  }

  scheduleGroupTileRefresh() {
    if (this._groupRefreshTimer) return;
    this._groupRefreshTimer = this.homey.setTimeout(() => {
      this._groupRefreshTimer = null;
      try {
        for (const group of this.homey.drivers.getDriver(GROUP_DRIVER).getDevices()) {
          if (typeof group.refreshNow === 'function') group.refreshNow();
        }
      } catch (err) {
        this.error('Group tile refresh failed:', err.message);
      }
    }, GROUP_REFRESH_DEBOUNCE_MS);
  }

  // --- virtual light groups (driver hilux-group) ---------------------------

  // Flat zone list for the group pairing view.
  async getZoneTree() {
    const zones = Object.values(await this._api.zones.getZones());
    return zones.map((z) => ({ id: z.id, name: z.name, parent: z.parent || null }));
  }

  // Resolve a stored zone set to member light addresses. Each selected zone
  // includes all its descendant zones, so groups follow the Homey zone tree
  // dynamically — lights moved between rooms need no reconfiguration.
  async resolveGroupAddresses(zoneIds) {
    const zones = Object.values(await this._api.zones.getZones());
    const selected = new Set(zoneIds);
    let grew = true;
    while (grew) {
      grew = false;
      for (const z of zones) {
        if (z.parent && selected.has(z.parent) && !selected.has(z.id)) {
          selected.add(z.id);
          grew = true;
        }
      }
    }

    const appPrefix = `homey:app:${this.homey.manifest.id}:`;
    const all = Object.values(await this._api.devices.getDevices());
    // Capability values must come from our own live device instances — the
    // Web API device cache only tracks properties (zone, settings), not
    // capability values, so reading those from it serves frozen state.
    const liveByAddress = this._lightDevicesByAddress();
    const members = all
      .filter((d) => d.driverId === appPrefix + LIGHT_DRIVER
        && selected.has(d.zone)
        && d.settings && d.settings.address)
      .map((d) => {
        const live = liveByAddress.get(d.settings.address);
        return {
          address: d.settings.address,
          onoff: live ? live.getCapabilityValue('onoff') : null,
          dim: live ? live.getCapabilityValue('dim') : null,
          temperature: live ? live.getCapabilityValue('light_temperature') : null,
        };
      });
    const order = sortAddresses(members.map((m) => m.address));
    members.sort((a, b) => order.indexOf(a.address) - order.indexOf(b.address));

    const zoneNames = zoneIds
      .map((id) => { const z = zones.find((x) => x.id === id); return z ? z.name : null; })
      .filter(Boolean);

    return { addresses: order, members, zoneNames };
  }

  // Auto-rename lights to "HiLux <room> (<nr>)" so names follow zone moves,
  // where <nr> is the unit label without its group prefix ("2-03" → "03").
  // The unit label (e.g. "2-03") lives in the device's settings, auto-extracted
  // from the legacy name once. Names not starting with "HiLux" (any casing,
  // so pre-2.3.1 "HiluX" names migrate too) are considered customized by the
  // user and are never touched.
  async _syncLightNames(lights, force = false) {
    const zones = await this._api.zones.getZones(force ? { $cache: false } : undefined);
    const zoneName = (id) => (zones[id] ? zones[id].name : null);
    const live = this._lightDevicesByAddress();

    for (const d of lights) {
      if (!d.name || !/^hilux/i.test(d.name)) continue;
      if (!d.settings || !d.settings.address) continue;
      const dev = live.get(d.settings.address);

      let unit = dev && dev.getSetting('unit_label');
      if (!unit) {
        const m = /(\d+-\d+)/.exec(d.name) || /\((\d+)\)/.exec(d.name);
        if (!m) continue; // no unit known and none derivable — leave alone
        unit = m[1];
        if (dev) await dev.setSettings({ unit_label: unit }).catch(() => {});
      }

      const zone = zoneName(d.zone);
      if (!zone) continue;
      // Full unit ("2-03") stays in settings; the name shows only the part
      // after the dash
      const shortUnit = unit.includes('-') ? unit.split('-').pop() : unit;
      const expected = `HiLux ${zone} (${shortUnit})`;
      if (d.name !== expected) {
        try {
          await this._api.devices.updateDevice({ id: d.id, device: { name: expected } });
          this.log(`Renamed light: "${d.name}" → "${expected}"`);
        } catch (err) {
          this.error(`Rename of "${d.name}" failed:`, err.message);
        }
      }
    }
  }

  _lightDevicesByAddress() {
    const map = new Map();
    try {
      for (const dev of this.homey.drivers.getDriver(LIGHT_DRIVER).getDevices()) {
        const addr = dev.getSetting('address') || dev.getStoreValue('address');
        if (addr) map.set(addr, dev);
      }
    } catch (err) {
      this.error('Light device lookup failed:', err.message);
    }
    return map;
  }

  // After a group broadcast, member lights are told to re-poll so their
  // Homey state (and every group tile mirroring them) syncs promptly.
  pollLights(addresses) {
    const live = this._lightDevicesByAddress();
    for (const address of addresses) {
      const dev = live.get(address);
      if (dev && typeof dev.poll === 'function') {
        dev.poll().catch(() => {});
      }
    }
  }

  // Called by button devices on init/settings/delete. Debounced: pairing an
  // i4 adds several devices in quick succession.
  scheduleRebuild(reason) {
    this.log('Rebuild requested:', reason);
    if (this._rebuildTimer) this.homey.clearTimeout(this._rebuildTimer);
    this._rebuildTimer = this.homey.setTimeout(() => {
      this._rebuildTimer = null;
      this._rebuildAll(reason).catch((e) => this.error(e));
    }, REBUILD_DEBOUNCE_MS);
  }

  async _rebuildAll(reason, force = false) {
    if (this._rebuilding) { this._rebuildQueued = true; return; }
    this._rebuilding = true;
    try {
      await this._doRebuild(reason, force);
    } finally {
      this._rebuilding = false;
      if (this._rebuildQueued) {
        this._rebuildQueued = false;
        this.scheduleRebuild('queued during rebuild');
      }
    }
  }

  async _doRebuild(reason, force = false) {
    // Forced runs bypass the realtime cache: homey-api never re-syncs it after
    // a socket reconnect, so zone moves that happen while the subscription is
    // down (or wedged) would otherwise stay invisible forever. Fetching fresh
    // also repairs the cache for the realtime path.
    const all = Object.values(await this._api.devices.getDevices(force ? { $cache: false } : undefined));
    const appPrefix = `homey:app:${this.homey.manifest.id}:`;

    const lights = all.filter((d) => d.driverId === appPrefix + LIGHT_DRIVER);

    // Keep light names in sync with their room (same triggers as the button
    // scripts: instant on zone moves, healed by the periodic sweep)
    await this._syncLightNames(lights, force).catch((err) => this.error('Name sync failed:', err.message));

    const buttons = all.filter((d) => d.driverId === appPrefix + BUTTON_DRIVER);
    if (buttons.length === 0) return;

    // zone id -> light addresses
    const lightsByZone = new Map();
    for (const light of lights) {
      const address = light.settings && light.settings.address;
      if (!address) continue;
      if (!lightsByZone.has(light.zone)) lightsByZone.set(light.zone, []);
      lightsByZone.get(light.zone).push(address);
    }

    // i4 address -> { '<input>': config }
    const perI4 = new Map();
    for (const button of buttons) {
      const s = button.settings || {};
      if (!s.address) continue;
      const input = String(num(s.input, 0));
      const zoneLights = sortAddresses(lightsByZone.get(button.zone) || []);

      if (zoneLights.length === 0 && !this._notifiedEmptyZones.has(button.id)) {
        this._notifiedEmptyZones.add(button.id);
        await this.homey.notifications.createNotification({
          excerpt: `HiluX button "${button.name}" has no HiluX lights in its zone — move it to the room it should control.`,
        }).catch(() => {});
      }
      if (zoneLights.length > 0) this._notifiedEmptyZones.delete(button.id);

      if (!perI4.has(s.address)) perI4.set(s.address, {});
      perI4.get(s.address)[input] = {
        lights: zoneLights,
        dimRate: num(s.dim_rate, 5),
        dimFloor: num(s.dim_floor, 5),
        ctSweepS: num(s.ct_sweep_s, 5),
        presetDouble: num(s.preset_double, 20),
        presetTriple: num(s.preset_triple, 50),
        fadeOn: num(s.fade_on, 1.5),
        fadeOff: num(s.fade_off, 0.5),
      };
    }

    const pushBaseUrl = await this.getPushBaseUrl().catch(() => null);

    for (const [address, configs] of perI4) {
      const { code, hash } = ScriptBuilder.generate(configs, pushBaseUrl);
      // Device events fire often (renames, capability chatter) — only talk
      // to the i4 when the config actually changed. Periodic runs force a
      // full on-device verify.
      if (!force && this._deployedHashes.get(address) === hash) continue;

      try {
        let result;
        try {
          result = await Deployer.deploy(address, code, hash, (m) => this.log(m));
        } catch (firstErr) {
          // Transient Wi-Fi blips are common on battery/IoT links — retry
          // once before treating this as a failure
          await new Promise((r) => this.homey.setTimeout(r, DEPLOY_RETRY_DELAY_MS));
          result = await Deployer.deploy(address, code, hash, (m) => this.log(m));
        }
        this._deployedHashes.set(address, hash);
        if (result.changed) this.log(`Rebuild (${reason}): i4 ${address} updated`);

        // Recovered after a notified outage? Close the loop.
        if (this._failureNotifiedAt.has(address)) {
          this._failureNotifiedAt.delete(address);
          await this.homey.notifications.createNotification({
            excerpt: `HiluX: the i4 at ${address} is reachable again — button script verified.`,
          }).catch(() => {});
        }
        this._deployFailures.delete(address);
      } catch (err) {
        const failures = (this._deployFailures.get(address) || 0) + 1;
        this._deployFailures.set(address, failures);
        this.error(`Rebuild (${reason}): i4 ${address} failed (${failures}x):`, err.message);

        // Only alert on persistent outage, at most once per cooldown window
        const lastNotified = this._failureNotifiedAt.get(address) || 0;
        if (failures >= NOTIFY_AFTER_CONSECUTIVE_FAILURES && Date.now() - lastNotified > NOTIFY_COOLDOWN_MS) {
          this._failureNotifiedAt.set(address, Date.now());
          await this.homey.notifications.createNotification({
            excerpt: `HiluX: the i4 at ${address} has been unreachable for ${failures} checks — its button script can't be verified. Check the device's power and Wi-Fi.`,
          }).catch(() => {});
        }
      }
    }
  }
}

module.exports = HiluxDS8App;
