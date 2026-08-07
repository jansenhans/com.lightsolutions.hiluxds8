'use strict';

const Homey = require('homey');

class HiluxGroupDriver extends Homey.Driver {
  async onInit() {
    this.log('HiluX Group driver initialized');
  }

  async onPair(session) {
    let pending = null;

    session.setHandler('get_zones', async () => this.homey.app.getZoneTree());

    session.setHandler('zones_selected', async ({ name, zoneIds }) => {
      if (!name || !Array.isArray(zoneIds) || zoneIds.length === 0) {
        throw new Error('Pick a name and at least one zone');
      }
      const { addresses } = await this.homey.app.resolveGroupAddresses(zoneIds);
      pending = {
        name,
        data: { id: `hilux-group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` },
        store: { zoneIds },
      };
      return { lights: addresses.length };
    });

    session.setHandler('list_devices', async () => (pending ? [pending] : []));
  }
}

module.exports = HiluxGroupDriver;
