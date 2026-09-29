'use strict';

const Homey = require('homey');

// A single i4 input, placed in the Homey zone whose lights it controls.
// All behavior lives in the generated script on the i4; this device is the
// configuration surface. Any lifecycle change asks the app to rebuild.
class HiluxI4ButtonDevice extends Homey.Device {
  async onInit() {
    this.log('i4 button initialized:', this.getName());
    await this._migrateDimFloor().catch(this.error);
    this.homey.app.scheduleRebuild('button init');
  }

  // One-time: the dim floor default went 5 → 3 % (2026-09-29, matching the
  // groups' minimum brightness). Buttons still on the old default follow;
  // a deliberately chosen value is left alone.
  async _migrateDimFloor() {
    if (this.getStoreValue('dim_floor_v3')) return;
    const floor = this.getSetting('dim_floor');
    if (floor === 5 || floor === undefined || floor === null) {
      await this.setSettings({ dim_floor: 3 });
      this.log('Dim floor migrated to 3 %');
    }
    await this.setStoreValue('dim_floor_v3', true);
  }

  async onSettings() {
    this.homey.app.scheduleRebuild('button settings changed');
  }

  async onDeleted() {
    this.homey.app.scheduleRebuild('button deleted');
  }
}

module.exports = HiluxI4ButtonDevice;
