'use strict';

const Homey = require('homey');
const ShellyRpcClient = require('../../lib/ShellyRpcClient');

const CT_MIN = 2200;
const CT_MAX = 6000;
const POLL_INTERVAL_MS = 20000;
const COMMAND_COOLDOWN_MS = 5000; // skip mirror poll this long after a command
const STAGGER_MS = 30; // gap between per-light commands in a broadcast
const CAPABILITY_COMBINE_MS = 300;

function ctToHomeyTemperature(ct) {
  const clamped = Math.min(CT_MAX, Math.max(CT_MIN, ct));
  return (CT_MAX - clamped) / (CT_MAX - CT_MIN);
}

function homeyTemperatureToCt(temperature) {
  const clamped = Math.min(1, Math.max(0, temperature));
  return Math.round(CT_MAX - clamped * (CT_MAX - CT_MIN));
}

// A group is a broadcaster, not an enforcer: a command fans out to every
// member light once, and afterwards rooms are free to diverge until the next
// deliberate group command. Membership is resolved at command time from the
// stored zone set (each selected zone includes its sub-zones), so lights that
// move between rooms follow automatically. The tile mirrors the group's
// reference light (lowest IP) for display only — mirroring never rebroadcasts.
class HiluxGroupDevice extends Homey.Device {
  async onInit() {
    this.log('HiluX Group initialized:', this.getName());

    this._lastCommandAt = 0;

    this.registerMultipleCapabilityListener(
      ['onoff', 'dim', 'light_temperature'],
      (values) => this._onCapabilities(values),
      CAPABILITY_COMBINE_MS,
    );

    await this._refresh().catch((err) => this.error('Initial refresh failed:', err.message));
    this._pollInterval = this.homey.setInterval(() => {
      if (Date.now() - this._lastCommandAt < COMMAND_COOLDOWN_MS) return;
      this._refresh().catch((err) => this.error('Refresh failed:', err.message));
    }, POLL_INTERVAL_MS);
  }

  async onUninit() {
    if (this._pollInterval) this.homey.clearInterval(this._pollInterval);
  }

  async onDeleted() {
    if (this._pollInterval) this.homey.clearInterval(this._pollInterval);
  }

  async _members() {
    const zoneIds = this.getStoreValue('zoneIds') || [];
    return this.homey.app.resolveGroupAddresses(zoneIds);
  }

  async _onCapabilities(values) {
    const params = {};
    if ('onoff' in values) params.on = values.onoff;
    if ('dim' in values) {
      params.brightness = Math.round(Math.min(1, Math.max(0, values.dim)) * 100);
      params.on = values.dim > 0;
    }
    if ('light_temperature' in values) params.ct = homeyTemperatureToCt(values.light_temperature);

    const fade = this.getSetting('fade_s');
    if (typeof fade === 'number' && fade > 0) params.transitionDuration = fade;

    await this._broadcast(params);
  }

  async _broadcast(params) {
    const { addresses } = await this._members();
    if (addresses.length === 0) {
      throw new Error('This group has no HiluX lights in its zones');
    }
    this._lastCommandAt = Date.now();

    // One shared value, near-simultaneous, lightly staggered so a large
    // group doesn't burst the Wi-Fi (same reasoning as settings enforcement)
    const results = await Promise.all(addresses.map((ip, i) => new Promise((resolve) => {
      this.homey.setTimeout(async () => {
        try {
          await new ShellyRpcClient(ip).setCct({ id: 0, ...params });
          resolve(true);
        } catch (err) {
          this.error(`Broadcast to ${ip} failed:`, err.message);
          resolve(false);
        }
      }, i * STAGGER_MS);
    })));

    const reached = results.filter(Boolean).length;
    this.log(`Broadcast ${JSON.stringify(params)} → ${reached}/${addresses.length} lights`);
    if (reached === 0) throw new Error('No lights in this group were reachable');
  }

  // Mirror the reference light's state onto the tile, and keep the zones
  // label + availability in sync with current membership.
  async _refresh() {
    const { addresses, zoneNames } = await this._members();

    const label = zoneNames.join(', ') || '(none)';
    if (this.getSetting('zones_label') !== label) {
      await this.setSettings({ zones_label: label }).catch(() => {});
    }

    if (addresses.length === 0) {
      await this.setUnavailable('No HiluX lights in the selected zones').catch(this.error);
      return;
    }
    if (!this.getAvailable()) await this.setAvailable().catch(this.error);

    let status;
    try {
      status = await new ShellyRpcClient(addresses[0]).getCctStatus(0);
    } catch (err) {
      // Reference unreachable — the group can still command the others,
      // so stay available and just skip this mirror cycle.
      return;
    }
    if (typeof status.output === 'boolean')
      await this.setCapabilityValue('onoff', status.output).catch(this.error);
    if (typeof status.brightness === 'number')
      await this.setCapabilityValue('dim', status.brightness / 100).catch(this.error);
    if (typeof status.ct === 'number')
      await this.setCapabilityValue('light_temperature', ctToHomeyTemperature(status.ct)).catch(this.error);
  }
}

module.exports = HiluxGroupDevice;
