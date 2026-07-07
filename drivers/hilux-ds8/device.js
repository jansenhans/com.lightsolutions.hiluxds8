'use strict';

const Homey = require('homey');
const ShellyRpcClient = require('../../lib/ShellyRpcClient');

const CT_MIN = 2200;
const CT_MAX = 6000;
const POLL_INTERVAL_MS = 15000;
const COMMAND_COOLDOWN_MS = 3000; // skip poll this long after a command
const UNAVAILABLE_AFTER_FAILURES = 3;

function ctToHomeyTemperature(ct) {
  const clamped = Math.min(CT_MAX, Math.max(CT_MIN, ct));
  return (CT_MAX - clamped) / (CT_MAX - CT_MIN);
}

function homeyTemperatureToCt(temperature) {
  const clamped = Math.min(1, Math.max(0, temperature));
  return Math.round(CT_MAX - clamped * (CT_MAX - CT_MIN));
}

class HiluxDS8Device extends Homey.Device {
  async onInit() {
    this.log('HiluX DS8 device initialized:', this.getName());

    const settings = this.getSettings();
    const store = this.getStore();
    this.address = settings.address || store.address;
    this.log('HiluX DS8 device address:', this.address);

    this._lastCommandAt = 0;
    this._pollFailures = 0;

    this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));
    this.registerCapabilityListener('dim', this.onCapabilityDim.bind(this));
    this.registerCapabilityListener('light_temperature', this.onCapabilityLightTemperature.bind(this));

    if (!this.address) {
      await this.setUnavailable('Please configure the IP address in device settings').catch(this.error);
      return;
    }

    this.client = new ShellyRpcClient(this.address);
    await this._startPolling();
  }

  async _startPolling() {
    if (this._pollInterval) this.homey.clearInterval(this._pollInterval);

    await this.poll().catch((err) => this.error('Initial poll failed:', err));

    this._pollInterval = this.homey.setInterval(() => {
      // Skip poll if a command was sent recently — avoids overwriting optimistic state
      const msSinceCommand = Date.now() - this._lastCommandAt;
      if (msSinceCommand < COMMAND_COOLDOWN_MS) return;
      this.poll().catch((err) => this.error('Poll failed:', err));
    }, POLL_INTERVAL_MS);
  }

  async onUninit() {
    if (this._pollInterval) this.homey.clearInterval(this._pollInterval);
  }

  async onDeleted() {
    if (this._pollInterval) this.homey.clearInterval(this._pollInterval);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('address')) {
      this.address = newSettings.address;
      if (!this.address) {
        await this.setUnavailable('Please configure the IP address in device settings').catch(this.error);
        return;
      }
      this.client = new ShellyRpcClient(this.address);
      this.log('Address updated to:', this.address);
      await this._startPolling();
    }
  }

  async poll() {
    let status;
    try {
      status = await this.client.getCctStatus(0);
    } catch (err) {
      this._pollFailures += 1;
      if (this._pollFailures >= UNAVAILABLE_AFTER_FAILURES) {
        await this.setUnavailable('Device unreachable').catch(this.error);
      }
      throw err;
    }
    this._pollFailures = 0;
    if (typeof status.output === 'boolean')
      await this.setCapabilityValue('onoff', status.output).catch(this.error);
    if (typeof status.brightness === 'number')
      await this.setCapabilityValue('dim', status.brightness / 100).catch(this.error);
    if (typeof status.ct === 'number')
      await this.setCapabilityValue('light_temperature', ctToHomeyTemperature(status.ct)).catch(this.error);
    if (!this.getAvailable()) await this.setAvailable().catch(this.error);
  }

  async _setCct(params) {
    if (!this.client) throw new Error('Device not configured — set the IP address in device settings');
    this._lastCommandAt = Date.now();
    return this.client.setCct({ id: 0, ...params });
  }

  // Fade to the given brightness (0-100 %) and/or colour temperature (Kelvin)
  // over `seconds`. The transition runs on the Shelly firmware itself.
  async fadeTo({ brightness, ct, seconds }) {
    const params = {
      on: true,
      transitionDuration: Math.min(10800, Math.max(1, seconds)),
    };
    if (typeof brightness === 'number') params.brightness = Math.round(Math.min(100, Math.max(0, brightness)));
    if (typeof ct === 'number') params.ct = Math.round(Math.min(CT_MAX, Math.max(CT_MIN, ct)));
    await this._setCct(params);
    await this.setCapabilityValue('onoff', true).catch(this.error);
  }

  // Wake-up light: jump to 1% warm white, then fade to the target over `minutes`.
  async wakeUp({ brightness, ct, minutes }) {
    await this._setCct({ on: true, brightness: 1, ct: CT_MIN });
    await this.fadeTo({ brightness, ct, seconds: minutes * 60 });
  }

  // Hold-to-dim: start dimming toward full or minimum brightness, alternating
  // direction each call like a classic dimmer. `seconds` is roughly the time a
  // fade across the full 1-100% range takes. Uses native CCT.DimUp/DimDown on
  // firmware >= 2.0.0, with a timed-fade fallback for older firmware.
  async startDimming({ seconds = 5 } = {}) {
    const status = await this.client.getCctStatus(0);
    const on = status.output === true;
    const current = typeof status.brightness === 'number' ? Math.round(status.brightness) : 50;

    let direction;
    if (!on || current <= 2) direction = 'up';
    else if (current >= 99) direction = 'down';
    else direction = this._dimDirection === 'up' ? 'down' : 'up';
    this._dimDirection = direction;

    if (!on) await this._setCct({ on: true, brightness: 1 });

    try {
      // fade_rate 1..5, each unit ~4%/s => full range in ~25/rate seconds
      const fadeRate = Math.min(5, Math.max(1, Math.round(25 / seconds)));
      this._lastCommandAt = Date.now();
      if (direction === 'up') await this.client.dimUp(0, fadeRate);
      else await this.client.dimDown(0, fadeRate);
      await this.setCapabilityValue('onoff', true).catch(this.error);
    } catch (err) {
      // Older firmware without CCT.DimUp/DimDown — timed fade to the extreme
      const from = on ? current : 1;
      const target = direction === 'up' ? 100 : 1;
      const duration = Math.max(1, seconds * (Math.abs(target - from) / 99));
      await this.fadeTo({ brightness: target, seconds: duration });
    }
  }

  // Freeze an ongoing fade at the light's current brightness.
  async stopDimming() {
    try {
      this._lastCommandAt = Date.now();
      await this.client.dimStop(0);
      await this.poll().catch(() => {});
    } catch (err) {
      // Older firmware without CCT.DimStop — freeze by re-setting the
      // current brightness without a transition
      const status = await this.client.getCctStatus(0);
      if (typeof status.brightness !== 'number') return;
      const brightness = Math.round(status.brightness);
      await this._setCct({ brightness });
      await this.setCapabilityValue('dim', brightness / 100).catch(this.error);
    }
  }

  async onCapabilityOnoff(value) {
    // Update UI immediately (optimistic)
    await this.setCapabilityValue('onoff', value).catch(this.error);
    try {
      await this._setCct({ on: value });
    } catch (err) {
      this.error('Failed to set onoff:', err);
      // Revert optimistic update on failure
      await this.poll().catch(() => {});
      throw err;
    }
  }

  async onCapabilityDim(value) {
    // Dimming an off light turns it on, matching standard light behavior
    const on = value > 0;
    await this.setCapabilityValue('dim', value).catch(this.error);
    await this.setCapabilityValue('onoff', on).catch(this.error);
    try {
      await this._setCct({ on, brightness: Math.round(value * 100) });
    } catch (err) {
      this.error('Failed to set dim:', err);
      await this.poll().catch(() => {});
      throw err;
    }
  }

  async onCapabilityLightTemperature(value) {
    await this.setCapabilityValue('light_temperature', value).catch(this.error);
    try {
      await this._setCct({ ct: homeyTemperatureToCt(value) });
    } catch (err) {
      this.error('Failed to set light_temperature:', err);
      await this.poll().catch(() => {});
      throw err;
    }
  }
}

module.exports = HiluxDS8Device;
