'use strict';

const Homey = require('homey');

class HiluxGroupDriver extends Homey.Driver {
  async onInit() {
    this.log('HiluX Group driver initialized');
  }

  async onPair(session) {
    session.setHandler('get_zones', async () => this.homey.app.getZoneTree());
  }
}

module.exports = HiluxGroupDriver;
