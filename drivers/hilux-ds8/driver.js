'use strict';

const Homey = require('homey');
const http = require('http');

const SCAN_TIMEOUT_MS = 800;

function probeIp(ip) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: ip,
      path: '/rpc/Shelly.GetDeviceInfo',
      method: 'GET',
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const info = JSON.parse(data);
          resolve(info && info.app === 'XMOD1' ? info : null);
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(SCAN_TIMEOUT_MS, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function scanSubnet(baseIp) {
  const parts = baseIp.split('.');
  const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`;

  // Scan all IPs at once — 254 parallel requests each with 800ms timeout
  // Total time: ~1-2 seconds, well within Homey's 30s pairing timeout
  const ips = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);
  const results = await Promise.all(
    ips.map(ip => probeIp(ip).then(info => ({ ip, info })))
  );
  return results.filter(({ info }) => info !== null);
}

class HiluxDS8Driver extends Homey.Driver {
  async onInit() {
    this.log('HiluX DS8 driver initialized');

    this.homey.flow.getActionCard('fade_to_brightness')
      .registerRunListener(async (args) => args.device.fadeTo({
        brightness: args.brightness,
        seconds: args.duration,
      }));

    this.homey.flow.getActionCard('fade_to_temperature')
      .registerRunListener(async (args) => args.device.fadeTo({
        ct: args.temperature,
        seconds: args.duration,
      }));

    this.homey.flow.getActionCard('start_dimming')
      .registerRunListener(async (args) => args.device.startDimming({
        seconds: args.duration,
      }));

    this.homey.flow.getActionCard('stop_dimming')
      .registerRunListener(async (args) => args.device.stopDimming());

    this.homey.flow.getActionCard('wake_up_light')
      .registerRunListener(async (args) => args.device.wakeUp({
        brightness: args.brightness,
        ct: args.temperature,
        minutes: args.duration,
      }));
  }

  async onPairListDevices() {
    this.log('onPairListDevices: starting subnet scan...');
    const homeyAddress = await this.homey.cloud.getLocalAddress();
    const homeyIp = homeyAddress.split(':')[0];
    this.log('onPairListDevices: Homey local address:', homeyAddress, '→ IP:', homeyIp);

    const found = await scanSubnet(homeyIp);
    this.log(`onPairListDevices: found ${found.length} device(s)`);

    return found.map(({ ip, info }) => ({
      name: (info.jwt && info.jwt.n) || 'HiluX DS8',
      data: { id: info.id, mac: info.mac },
      store: { address: ip },
      settings: { address: ip },
    }));
  }
}

module.exports = HiluxDS8Driver;
