'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

const ScriptBuilder = require('./lib/I4ScriptBuilder');
const Deployer = require('./lib/I4Deployer');

const REBUILD_DEBOUNCE_MS = 3000;
const REBUILD_INTERVAL_MS = 5 * 60 * 1000; // catch zone moves and drift
const LIGHT_DRIVER = 'hilux-ds8';
const BUTTON_DRIVER = 'hilux-i4-button';

function num(value, fallback) {
  return typeof value === 'number' && !Number.isNaN(value) ? value : fallback;
}

class HiluxDS8App extends Homey.App {
  async onInit() {
    this.log('HiluX DS8 app has been initialized');

    this._rebuilding = false;
    this._rebuildQueued = false;
    this._rebuildTimer = null;
    this._notifiedEmptyZones = new Set();

    this._api = await HomeyAPI.createAppAPI({ homey: this.homey });

    // First rebuild shortly after startup (lets drivers finish init), then
    // periodically to catch zone moves, which have no direct event hook here.
    this.homey.setTimeout(() => this._rebuildAll('app start').catch((e) => this.error(e)), 15000);
    this.homey.setInterval(() => this._rebuildAll('periodic').catch((e) => this.error(e)), REBUILD_INTERVAL_MS);
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

  async _rebuildAll(reason) {
    if (this._rebuilding) { this._rebuildQueued = true; return; }
    this._rebuilding = true;
    try {
      await this._doRebuild(reason);
    } finally {
      this._rebuilding = false;
      if (this._rebuildQueued) {
        this._rebuildQueued = false;
        this.scheduleRebuild('queued during rebuild');
      }
    }
  }

  async _doRebuild(reason) {
    const all = Object.values(await this._api.devices.getDevices());
    const appPrefix = `homey:app:${this.homey.manifest.id}:`;

    const lights = all.filter((d) => d.driverId === appPrefix + LIGHT_DRIVER);
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
      const zoneLights = (lightsByZone.get(button.zone) || []).slice().sort();

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

    for (const [address, configs] of perI4) {
      try {
        const { code, hash } = ScriptBuilder.generate(configs);
        const result = await Deployer.deploy(address, code, hash, (m) => this.log(m));
        if (result.changed) this.log(`Rebuild (${reason}): i4 ${address} updated`);
      } catch (err) {
        this.error(`Rebuild (${reason}): i4 ${address} failed:`, err.message);
        await this.homey.notifications.createNotification({
          excerpt: `HiluX: deploying the button script to the i4 at ${address} failed: ${err.message}`,
        }).catch(() => {});
      }
    }
  }
}

module.exports = HiluxDS8App;
