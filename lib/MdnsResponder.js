'use strict';

const dgram = require('dgram');

const MCAST_ADDR = '224.0.0.251';
const MCAST_PORT = 5353;
const SERVICE = '_home-assistant._tcp.local';
const ENUM_SERVICE = '_services._dns-sd._udp.local';

// Minimal mDNS responder that advertises the app's panel HTTP server as a
// Home Assistant instance — the Shelly Wall Display's "Home Assistant" mode
// only accepts instances it discovers via mDNS.
function encodeName(name) {
  const parts = name.split('.').filter(Boolean);
  return Buffer.concat([...parts.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p)])), Buffer.from([0])]);
}

function record(name, type, flush, ttl, rdata) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(flush ? 0x8001 : 0x0001, 2);
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encodeName(name), head, rdata]);
}

function txtRdata(entries) {
  return Buffer.concat(entries.map((e) => Buffer.concat([Buffer.from([Buffer.byteLength(e)]), Buffer.from(e)])));
}

function srvRdata(port, target) {
  const b = Buffer.alloc(6);
  b.writeUInt16BE(0, 0);
  b.writeUInt16BE(0, 2);
  b.writeUInt16BE(port, 4);
  return Buffer.concat([b, encodeName(target)]);
}

function aRdata(ip) {
  return Buffer.from(ip.split('.').map(Number));
}

// All question names in a DNS packet (handles compression pointers)
function questionNames(msg) {
  const names = [];
  try {
    const qd = msg.readUInt16BE(4);
    let off = 12;
    for (let i = 0; i < qd; i++) {
      const parts = [];
      let o = off;
      let jumped = false;
      let guard = 0;
      while (guard++ < 64) {
        const len = msg[o];
        if (len === undefined) return names;
        if (len === 0) { if (!jumped) off = o + 1; break; }
        if ((len & 0xc0) === 0xc0) {
          if (!jumped) off = o + 2;
          o = ((len & 0x3f) << 8) | msg[o + 1];
          jumped = true;
          continue;
        }
        parts.push(msg.toString('utf8', o + 1, o + 1 + len));
        o += 1 + len;
      }
      names.push(parts.join('.').toLowerCase());
      off += 4;
    }
  } catch (e) { /* malformed packet */ }
  return names;
}

class MdnsResponder {
  constructor({ ip, port, instance = 'Homey', log = () => {}, error = () => {} }) {
    this.ip = ip;
    this.port = port;
    this.instance = `${instance}.${SERVICE}`;
    this.host = 'homey-hilux.local';
    this.log = log;
    this.error = error;
    this._socket = null;
    this._interval = null;
  }

  _answer() {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x8400, 2); // authoritative response
    const answers = [
      record(ENUM_SERVICE, 12, false, 4500, encodeName(SERVICE)),
      record(SERVICE, 12, false, 4500, encodeName(this.instance)), // PTR
      record(this.instance, 33, true, 120, srvRdata(this.port, this.host)), // SRV
      record(this.instance, 16, true, 4500, txtRdata([
        `location_name=${this.instance.split('.')[0]}`,
        'uuid=6d6f636b686f6d6579686f6d6579686f',
        'version=2026.1.0',
        `base_url=http://${this.ip}:${this.port}`,
        `internal_url=http://${this.ip}:${this.port}`,
        'external_url=',
        'requires_api_password=True',
      ])), // TXT
      record(this.host, 1, true, 120, aRdata(this.ip)), // A
    ];
    header.writeUInt16BE(answers.length, 6);
    return Buffer.concat([header, ...answers]);
  }

  _send() {
    if (!this._socket) return;
    this._socket.send(this._answer(), MCAST_PORT, MCAST_ADDR, () => {});
  }

  start() {
    const bindListen = () => {
      this._socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this._socket.on('error', (err) => {
        this.error('mDNS socket error:', err.message);
        // fall back to blind periodic announcements from an ephemeral port
        try { this._socket.close(); } catch (e) { /* already closed */ }
        this._socket = dgram.createSocket({ type: 'udp4' });
        this._socket.on('error', () => {});
        this._socket.bind(() => this._send());
      });
      this._socket.on('message', (msg, rinfo) => {
        if ((msg.readUInt16BE(2) & 0x8000) !== 0) return; // ignore responses
        const names = questionNames(msg);
        if (names.some((n) => n === SERVICE || n === ENUM_SERVICE || n === this.instance.toLowerCase() || n === this.host)) {
          if (!this._lastQueryLog || Date.now() - this._lastQueryLog > 30000) {
            this._lastQueryLog = Date.now();
            this.log(`mDNS query for our service from ${rinfo.address}`);
          }
          this._send();
        }
      });
      this._socket.bind(MCAST_PORT, () => {
        try { this._socket.addMembership(MCAST_ADDR); } catch (e) { this.error('mDNS membership failed:', e.message); }
        this.log(`mDNS responder advertising ${this.instance} -> ${this.ip}:${this.port}`);
        this._send();
      });
    };
    bindListen();
    this._interval = setInterval(() => this._send(), 30000);
  }

  stop() {
    if (this._interval) clearInterval(this._interval);
    if (this._socket) { try { this._socket.close(); } catch (e) { /* noop */ } }
  }
}

module.exports = MdnsResponder;
