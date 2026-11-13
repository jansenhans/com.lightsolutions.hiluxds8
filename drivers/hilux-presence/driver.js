'use strict';

const Homey = require('homey');

// One switch for the whole house: lets Apple Home (HomeKit / Matter Bridge),
// Siri and Homey tiles start and stop the presence simulation
class HiluxPresenceDriver extends Homey.Driver {
  async onInit() {
    this.log('HiluX Presence driver initialized');
  }

  async onPairListDevices() {
    if (this.getDevices().length > 0) return [];
    return [{ name: 'Presence simulation', data: { id: 'hilux-presence' } }];
  }
}

module.exports = HiluxPresenceDriver;
