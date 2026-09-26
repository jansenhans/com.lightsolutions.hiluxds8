'use strict';

const http = require('http');

function httpRequest(options, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    // setTimeout is an idle timer that only starts once connected; a light
    // that is napping can stall the connect itself for seconds. Short
    // (fast-retry) timeouts are therefore enforced as a hard deadline.
    const expire = () => req.destroy(new Error(`Request timed out (${timeoutMs / 1000}s)`));
    req.setTimeout(timeoutMs, expire);
    if (timeoutMs < 8000) {
      const deadline = setTimeout(expire, timeoutMs);
      req.on('close', () => clearTimeout(deadline));
    }

    if (body) req.write(body);
    req.end();
  });
}

class ShellyRpcClient {
  // timeoutMs: per-request limit (default 8 s); fast-retry callers use less
  constructor(ip, { timeoutMs = 8000 } = {}) {
    this.ip = ip;
    this.timeoutMs = timeoutMs;
    this._id = 0;
  }

  async getDeviceInfo() {
    return httpRequest({
      hostname: this.ip,
      path: '/rpc/Shelly.GetDeviceInfo',
      method: 'GET',
    }, null, this.timeoutMs);
  }

  async call(method, params = {}) {
    const body = JSON.stringify({ id: ++this._id, method, params });
    const json = await httpRequest({
      hostname: this.ip,
      path: '/rpc',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, body, this.timeoutMs);

    if (json.error) throw new Error(`Shelly RPC error: ${JSON.stringify(json.error)}`);
    return json.result;
  }

  getCctStatus(id = 0) {
    return this.call('CCT.GetStatus', { id });
  }

  getCctConfig(id = 0) {
    return this.call('CCT.GetConfig', { id });
  }

  setCctConfig(id = 0, config = {}) {
    return this.call('CCT.SetConfig', { id, config });
  }

  // Native dimming (firmware >= 2.0.0). fade_rate: 1 (slow) .. 5 (fast), each unit ~4%/s
  dimUp(id = 0, fadeRate = 5) {
    return this.call('CCT.DimUp', { id, fade_rate: fadeRate });
  }

  dimDown(id = 0, fadeRate = 5) {
    return this.call('CCT.DimDown', { id, fade_rate: fadeRate });
  }

  dimStop(id = 0) {
    return this.call('CCT.DimStop', { id });
  }

  setCct({ id = 0, on, brightness, ct, transitionDuration } = {}) {
    const params = { id };
    if (typeof on === 'boolean') params.on = on;
    if (typeof brightness === 'number') params.brightness = brightness;
    if (typeof ct === 'number') params.ct = ct;
    if (typeof transitionDuration === 'number') params.transition_duration = transitionDuration;
    return this.call('CCT.Set', params);
  }
}

module.exports = ShellyRpcClient;
