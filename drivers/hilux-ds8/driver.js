'use strict';

const Homey = require('homey');
const http = require('http');

const SCAN_TIMEOUT_MS = 600;

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
  const parts = baseIp.split('.').map(Number);

  // Scan the /23 that contains Homey's IP, not just its own /24 — this also
  // finds lights when the LAN is widened to 255.255.254.0 and IoT devices
  // are placed in the other /24 half (e.g. Homey in .1.x, lights in .0.x).
  // On a plain /24 LAN the extra probes simply time out — harmless.
  // One parallel wave per /24 half, Homey's own half first.
  const third = parts[2] - (parts[2] % 2);
  const halves = [parts[2], parts[2] === third ? third + 1 : third];

  const results = [];
  for (const octet3 of halves) {
    const ips = Array.from({ length: 254 }, (_, i) => `${parts[0]}.${parts[1]}.${octet3}.${i + 1}`);
    const settled = await Promise.all(
      ips.map(ip => probeIp(ip).then(info => ({ ip, info })))
    );
    results.push(...settled);
  }
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
