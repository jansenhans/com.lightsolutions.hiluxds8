'use strict';

const Homey = require('homey');

// A single i4 input, placed in the Homey zone whose lights it controls.
// All behavior lives in the generated script on the i4; this device is the
// configuration surface. Any lifecycle change asks the app to rebuild.
class HiluxI4ButtonDevice extends Homey.Device {
  async onInit() {
    this.log('i4 button initialized:', this.getName());
    this.homey.app.scheduleRebuild('button init');
  }

  async onSettings() {
    this.homey.app.scheduleRebuild('button settings changed');
  }

  async onDeleted() {
    this.homey.app.scheduleRebuild('button deleted');
  }
}

module.exports = HiluxI4ButtonDevice;
