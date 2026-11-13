'use strict';

const Homey = require('homey');

// Mirrors the app's presence_enabled flag; switching it starts or stops the
// simulation exactly like the Flow cards and the settings toggle
class HiluxPresenceDevice extends Homey.Device {
  async onInit() {
    this.registerCapabilityListener('onoff', (on) => (on
      ? this.homey.app._presence.start()
      : this.homey.app._presence.stop()));
    await this.reflect(this.homey.app._presence.running);
  }

  async reflect(on) {
    if (this.getCapabilityValue('onoff') !== on) await this.setCapabilityValue('onoff', on).catch(this.error);
  }
}

module.exports = HiluxPresenceDevice;
