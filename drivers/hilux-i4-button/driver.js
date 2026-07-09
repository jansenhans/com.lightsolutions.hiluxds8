'use strict';

const Homey = require('homey');
const http = require('http');

const SCAN_TIMEOUT_MS = 600;

function probeI4(ip) {
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
          resolve(info && info.app === 'I4G3' ? info : null);
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(SCAN_TIMEOUT_MS, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Same /23 scan strategy as the light driver: Homey's own /24 first, then
// the sibling half (covers a widened 255.255.254.0 LAN).
async function scanForI4s(baseIp) {
  const parts = baseIp.split('.').map(Number);
  const third = parts[2] - (parts[2] % 2);
  const halves = [parts[2], parts[2] === third ? third + 1 : third];

  const results = [];
  for (const octet3 of halves) {
    const ips = Array.from({ length: 254 }, (_, i) => `${parts[0]}.${parts[1]}.${octet3}.${i + 1}`);
    const settled = await Promise.all(
      ips.map(ip => probeI4(ip).then(info => ({ ip, info })))
    );
    results.push(...settled);
  }
  return results.filter(({ info }) => info !== null);
}

class HiluxI4ButtonDriver extends Homey.Driver {
  async onInit() {
    this.log('HiluX i4 button driver initialized');
  }

  async onPairListDevices() {
    const homeyAddress = await this.homey.cloud.getLocalAddress();
    const homeyIp = homeyAddress.split(':')[0];
    this.log('Scanning for Shelly i4 Gen3 devices from', homeyIp);

    const found = await scanForI4s(homeyIp);
    this.log(`Found ${found.length} i4(s)`);

    // Offer each input as its own device — the user adds the wired ones and
    // places each in the zone whose lights it should control.
    const devices = [];
    for (const { ip, info } of found) {
      const shortId = info.id.slice(-4);
      for (let input = 0; input < 4; input++) {
        devices.push({
          name: `i4 ${shortId} · Button ${input + 1}`,
          data: { id: `${info.id}-in${input}` },
          settings: { address: ip, input },
        });
      }
    }
    return devices;
  }
}

module.exports = HiluxI4ButtonDriver;
