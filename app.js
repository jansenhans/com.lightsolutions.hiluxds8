'use strict';

const Homey = require('homey');

class HiluxDS8App extends Homey.App {
  async onInit() {
    this.log('HiluX DS8 app has been initialized');
  }
}

module.exports = HiluxDS8App;
