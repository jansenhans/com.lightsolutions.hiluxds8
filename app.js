'use strict';

const http = require('http');
const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

const ScriptBuilder = require('./lib/I4ScriptBuilder');
const Deployer = require('./lib/I4Deployer');
const PanelDeployer = require('./lib/PanelDeployer');
const PanelPage = require('./lib/PanelPage');
const MdnsResponder = require('./lib/MdnsResponder');

const REBUILD_DEBOUNCE_MS = 3000;
const REBUILD_INTERVAL_MS = 5 * 60 * 1000; // catch zone moves and drift
const DEPLOY_RETRY_DELAY_MS = 10000;
const NOTIFY_AFTER_CONSECUTIVE_FAILURES = 3; // ~15 min of real outage
const NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const CT_MIN = 2200;
const CT_MAX = 6000;
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

    // Renaming needs the API key from the app settings (see _renameDevice);
    // re-run the sweep as soon as the user pastes one
    this._renameKeyWarned = false;
    this.homey.settings.on('set', (key) => {
      if (key === 'api_key') {
        this._renameKeyWarned = false;
        this.scheduleRebuild('api key updated');
      }
    });
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
      const path = (req.url || '').split('?')[0];
      const m = /^\/hilux-push\/(\d+\.\d+\.\d+\.\d+)$/.exec(path);
      if (m) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        this.lightStateTouched(m[1]);
        return;
      }
      // Motion webhook from a wall display — remembered so the panel page's
      // presence poll can dismiss its screensaver
      const pm = /^\/panel-motion\/(\d+\.\d+\.\d+\.\d+)$/.exec(path);
      if (pm) {
        if (!this._panelMotionAt) this._panelMotionAt = new Map();
        this._panelMotionAt.set(pm[1], Date.now());
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }
      // Touch dashboard for wall displays (rendered in the display's WebView)
      if (path === '/panel' || path.startsWith('/panel/')) {
        this._handlePanel(req, res).catch((err) => {
          this.error('Panel request failed:', err.message);
          try { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('error'); } catch (e) { /* headers sent */ }
        });
        return;
      }
      // The Wall Display's "Home Assistant" WebView only accepts a bare
      // server address and probes it: answer HA's discovery endpoints, and
      // serve the caller's own panel at the root (matched by the group's
      // panel_address setting).
      if (path === '/auth/providers') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[{"name":"Local","id":null,"type":"homeassistant"}]');
        return;
      }
      if (path === '/manifest.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"name":"Home Assistant","short_name":"Assist","start_url":"/","display":"standalone"}');
        return;
      }
      if (path === '/api/' || path === '/api') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"message":"API running."}');
        return;
      }
      if (path === '/api/config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"version":"2026.1.0","location_name":"Homey","state":"RUNNING"}');
        return;
      }
      if (path === '/api/discovery_info') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          uuid: '6d6f636b686f6d6579686f6d6579686f',
          base_url: 'http://192.168.0.10:4820',
          external_url: null,
          internal_url: 'http://192.168.0.10:4820',
          location_name: 'Homey',
          installation_type: 'Home Assistant OS',
          requires_api_password: true,
          version: '2026.1.0',
        }));
        return;
      }
      // HA native login flow: complete it immediately with an auth code that
      // /auth/token below will happily exchange for a token
      if (path === '/auth/login_flow' || path.startsWith('/auth/login_flow/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"type":"create_entry","flow_id":"hilux","result":"hilux","version":1}');
        return;
      }
      if (path === '/auth/authorize' || path === '/auth/token') {
        // minimal auth flow: immediately hand the client back a token
        if (path === '/auth/token') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"access_token":"hilux","token_type":"Bearer","refresh_token":"hilux","expires_in":1800}');
        } else {
          const cb = new URL(req.url, 'http://x').searchParams.get('redirect_uri') || '/';
          res.writeHead(302, { Location: `${cb}${cb.includes('?') ? '&' : '?'}code=hilux` });
          res.end();
        }
        return;
      }
      if (path === '/' || path === '/lovelace' || path.startsWith('/lovelace/')) {
        const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        this.log(`Panel root request from ${ip} (${req.url})`);
        let groups = [];
        try { groups = this.homey.drivers.getDriver(GROUP_DRIVER).getDevices(); } catch (e) { /* not ready */ }
        // Prefer the group whose panel_address matches the caller; fall back
        // to the only panel-carrying group (the display's WebView traffic can
        // originate from a different IP than its Shelly service)
        const withPanel = groups.filter((g) => (g.getSetting('panel_address') || '').trim() !== '');
        const dev = withPanel.find((g) => g.getSetting('panel_address').trim() === ip)
          || (withPanel.length === 1 ? withPanel[0] : null);
        res.writeHead(dev ? 200 : 302, dev
          ? { 'Content-Type': 'text/html; charset=utf-8' }
          : { Location: '/panel' });
        res.end(dev ? PanelPage.render({ id: String(dev.getData().id), name: dev.getName() }) : '');
        return;
      }
      this.log(`HTTP ${req.method} ${req.url} from ${(req.socket.remoteAddress || '').replace(/^::ffff:/, '')}`);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    // HA clients (the Wall Display's WebView mode) validate an instance via
    // the websocket API — speak just enough of the handshake to pass.
    const WebSocket = require('ws');
    this._wss = new WebSocket.Server({ noServer: true });
    this._pushServer.on('upgrade', (req, socket, head) => {
      const wsPath = (req.url || '').split('?')[0];
      this.log(`WS upgrade request: ${wsPath} from ${(req.socket.remoteAddress || '').replace(/^::ffff:/, '')}`);
      if (wsPath !== '/api/websocket') { socket.destroy(); return; }
      this._wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify({ type: 'auth_required', ha_version: '2026.1.0' }));
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data);
            this.log('WS message:', String(data).slice(0, 300));
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'auth_ok', ha_version: '2026.1.0' }));
              return;
            }
            if (typeof msg.id !== 'number') return;
            let result = null;
            if (msg.type === 'get_config') {
              result = {
                latitude: 50.9, longitude: 4.5, elevation: 0, radius: 100,
                unit_system: { length: 'km', mass: 'kg', temperature: '°C', volume: 'L' },
                location_name: 'Homey', time_zone: 'Europe/Brussels',
                components: ['lovelace', 'frontend', 'api', 'websocket_api'],
                version: '2026.1.0', state: 'RUNNING',
              };
            } else if (msg.type === 'get_states' || msg.type === 'get_services' || msg.type === 'get_panels') {
              result = msg.type === 'get_states' ? [] : {};
            }
            ws.send(JSON.stringify({ id: msg.id, type: 'result', success: true, result }));
          } catch (e) { /* ignore malformed frames */ }
        });
        ws.on('error', () => {});
      });
    });
    this._pushServer.on('error', (err) => this.error('Push server error:', err.message));
    this._pushServer.listen(PUSH_PORT, () => this.log(`Push receiver listening on :${PUSH_PORT}`));

    // Advertise the panel server as a Home Assistant instance — the Wall
    // Display's HA mode only offers instances it discovers via mDNS
    try {
      const localIp = (await this.homey.cloud.getLocalAddress()).split(':')[0];
      this._mdns = new MdnsResponder({
        ip: localIp,
        port: PUSH_PORT,
        instance: 'Homey',
        log: (...a) => this.log(...a),
        error: (...a) => this.error(...a),
      });
      this._mdns.start();
    } catch (err) {
      this.error('mDNS responder failed to start:', err.message);
    }

    // First rebuild shortly after startup (lets drivers finish init), then a
    // periodic full verify (force) that also heals an i4 that was rebooted
    // or factory-reset behind our back.
    this.homey.setTimeout(() => this._rebuildAll('app start', true).catch((e) => this.error(e)), 15000);
    this.homey.setInterval(() => this._rebuildAll('periodic', true).catch((e) => this.error(e)), REBUILD_INTERVAL_MS);
  }

  async onUninit() {
    if (this._pushServer) this._pushServer.close();
    if (this._mdns) this._mdns.stop();
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

  // Auto-rename lights to "HiLux <room> (<nr>)" so names follow zone moves.
  // <nr> is a per-room sequence (01, 02, ...): a light keeps its number while
  // it stays in its room, and gets the lowest free number of the destination
  // room when it moves there. The assignment lives in the device store
  // (name_zone / name_seq); numbers already present in names are adopted on
  // first run. Names not starting with "HiLux" (any casing) are considered
  // customized by the user and are never touched.
  async _syncLightNames(lights, force = false) {
    const zones = await this._api.zones.getZones(force ? { $cache: false } : undefined);
    const zoneName = (id) => (zones[id] ? zones[id].name : null);
    const live = this._lightDevicesByAddress();

    const byZone = new Map();
    for (const d of lights) {
      if (!d.name || !/^hilux/i.test(d.name)) continue;
      if (!d.settings || !d.settings.address) continue;
      if (!byZone.has(d.zone)) byZone.set(d.zone, []);
      byZone.get(d.zone).push(d);
    }

    // Number currently visible in the name — seeds the store on first run and
    // is the fallback when the device object isn't available
    const nameSeq = (d) => {
      const m = /\((\d+)\)\s*$/.exec(d.name) || /\d+-(\d+)/.exec(d.name);
      return m ? parseInt(m[1], 10) : null;
    };

    for (const [zoneId, members] of byZone) {
      const zone = zoneName(zoneId);
      if (!zone) continue;

      const used = new Set();
      const assigned = [];
      const pending = [];

      // Lights that already hold a number in this room keep it
      for (const d of members) {
        const dev = live.get(d.settings.address);
        let seq = null;
        if (dev && dev.getStoreValue('name_zone') === zoneId) {
          seq = parseInt(dev.getStoreValue('name_seq'), 10) || null;
        } else if (!dev || dev.getStoreValue('name_zone') == null) {
          seq = nameSeq(d);
        }
        if (seq && !used.has(seq)) {
          used.add(seq);
          assigned.push([d, dev, seq]);
        } else {
          pending.push(d);
        }
      }

      // Moved-in lights take the lowest free number in the room
      pending.sort((a, b) => a.name.localeCompare(b.name));
      for (const d of pending) {
        let seq = 1;
        while (used.has(seq)) seq++;
        used.add(seq);
        assigned.push([d, live.get(d.settings.address), seq]);
      }

      for (const [d, dev, seq] of assigned) {
        if (dev) {
          await dev.setStoreValue('name_zone', zoneId).catch(() => {});
          await dev.setStoreValue('name_seq', seq).catch(() => {});
        }
        const expected = `HiLux ${zone} (${String(seq).padStart(2, '0')})`;
        if (d.name !== expected) {
          // d is a live cache object — its name mutates once the rename event
          // comes back, so keep the old name for logging
          const prevName = d.name;
          try {
            await this._renameDevice(d.id, expected);
            this.log(`Renamed light: "${prevName}" → "${expected}"`);
          } catch (err) {
            this.error(`Rename of "${prevName}" failed:`, err.message);
          }
        }
      }
    }
  }

  // Rename a device through the local Web API. The app's own API session
  // only gets homey.device.readonly/control — renaming needs the full
  // homey.device scope, which Homey never grants to apps. So we use a
  // user-created API key (Homey Settings → API Keys, Devices: full access)
  // stored in the app settings.
  async _renameDevice(id, name) {
    const key = this.homey.settings.get('api_key');
    if (!key) {
      if (!this._renameKeyWarned) {
        this._renameKeyWarned = true;
        this.log('Cannot rename lights: no API key configured in app settings');
        await this.homey.notifications.createNotification({
          excerpt: 'HiluX: automatic light naming needs a Homey API key. Create one in Homey Settings → API Keys (Devices: full access) and paste it in the HiluX DS8 app settings.',
        }).catch(() => {});
      }
      throw new Error('no API key configured');
    }
    const baseUrl = await this.homey.api.getLocalUrl();
    const res = await fetch(new URL(`/api/manager/devices/device/${id}`, baseUrl), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  // Routes for the wall-display touch dashboard: /panel lists the groups,
  // /panel/<id> serves the page, /panel/<id>/state|set are its JSON API.
  // Commands reuse the group's own capability path, so they behave exactly
  // like taps on the Homey group tile.
  async _handlePanel(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const parts = u.pathname.split('/').filter(Boolean);
    const json = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const html = (s) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(s); };

    let groups = [];
    try { groups = this.homey.drivers.getDriver(GROUP_DRIVER).getDevices(); } catch (e) { /* driver not ready */ }

    if (parts.length === 1) {
      return html(PanelPage.renderIndex(groups.map((g) => ({ id: String(g.getData().id), name: g.getName() }))));
    }
    if (parts[1] === 'weather') return json(await this._getWeather());
    const dev = groups.find((g) => String(g.getData().id) === parts[1]);
    if (!dev) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('unknown group'); return; }

    const action = parts[2] || 'page';
    if (action === 'page') return html(PanelPage.render({ id: parts[1], name: dev.getName() }));

    if (action === 'state') {
      const t = dev.getCapabilityValue('light_temperature');
      return json({
        name: dev.getName(),
        on: dev.getCapabilityValue('onoff') === true,
        b: Math.round((dev.getCapabilityValue('dim') || 0.5) * 100),
        ct: Math.round(CT_MAX - (typeof t === 'number' ? t : 0.75) * (CT_MAX - CT_MIN)),
      });
    }
    if (action === 'presence') {
      // Used by the panel page to dismiss its screensaver. Primary signal:
      // the display's own motion webhook (see /panel-motion); fallback: the
      // occupancy sensor polled via RPC (a stub on some hardware).
      const ip = (dev.getSetting('panel_address') || '').trim();
      if (!ip) return json({ present: false });
      if (this._panelMotionAt && Date.now() - (this._panelMotionAt.get(ip) || 0) < 10000) {
        return json({ present: true });
      }
      try {
        const r = await fetch(`http://${ip}/rpc/Occupancy.GetStatus?id=0`, { signal: AbortSignal.timeout(2000) });
        const j = await r.json();
        return json({ present: j.value === true });
      } catch (e) {
        return json({ present: false });
      }
    }
    if (action === 'set') {
      const values = {};
      if (u.searchParams.has('on')) values.onoff = u.searchParams.get('on') === 'true';
      if (u.searchParams.has('b')) values.dim = Math.min(1, Math.max(0.01, Number(u.searchParams.get('b')) / 100));
      if (u.searchParams.has('ct')) {
        const ctv = Math.min(CT_MAX, Math.max(CT_MIN, Number(u.searchParams.get('ct'))));
        values.light_temperature = (CT_MAX - ctv) / (CT_MAX - CT_MIN);
      }
      await dev._onCapabilities(values);
      return json({ ok: true });
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('unknown action');
  }

  // Current weather for the panels, from Open-Meteo at the Homey's location,
  // cached for 15 minutes
  async _getWeather() {
    if (this._weatherCache && Date.now() - this._weatherCache.at < 15 * 60 * 1000) {
      return this._weatherCache.data;
    }
    let lat = 50.9;
    let lon = 4.5;
    try {
      lat = this.homey.geolocation.getLatitude();
      lon = this.homey.geolocation.getLongitude();
    } catch (e) { /* fall back to defaults */ }
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
      + '&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1');
    if (!res.ok) throw new Error(`weather fetch failed: HTTP ${res.status}`);
    const j = await res.json();
    const data = {
      temp: j.current.temperature_2m,
      code: j.current.weather_code,
      min: j.daily.temperature_2m_min[0],
      max: j.daily.temperature_2m_max[0],
    };
    this._weatherCache = { at: Date.now(), data };
    return data;
  }

  // Deploy a panel script to every Shelly Wall Display named in a group's
  // panel_address setting, with the group's currently resolved member lights.
  async _deployPanels() {
    let groups = [];
    try {
      groups = this.homey.drivers.getDriver(GROUP_DRIVER).getDevices();
    } catch (e) {
      return;
    }
    for (const g of groups) {
      const ip = (g.getSetting('panel_address') || '').trim();
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
      try {
        const { addresses } = await this.resolveGroupAddresses(g.getStoreValue('zoneIds') || []);
        if (addresses.length === 0) {
          this.log(`Panel ${ip}: group "${g.getName()}" has no lights — skipped`);
          continue;
        }
        const fade = num(g.getSetting('fade_s'), 1.5) || 1.5;
        const base = await this.getPushBaseUrl();
        const motionUrl = base.replace('/hilux-push/', `/panel-motion/${ip}`);
        await PanelDeployer.deploy(ip, { name: g.getName(), lights: addresses, fade, motionUrl }, (m) => this.log(m));
      } catch (err) {
        this.error(`Panel deploy to ${ip} failed:`, err.message);
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

    // Wall-display panels follow their group's membership, same lifecycle as
    // the i4 scripts (instant on relevant events, healed by the periodic sweep)
    await this._deployPanels().catch((err) => this.error('Panel deploy failed:', err.message));

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
