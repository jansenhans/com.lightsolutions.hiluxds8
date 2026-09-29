'use strict';

const EventEmitter = require('events');
const WebSocket = require('ws');

// Persistent RPC connection to a Shelly (ws://<ip>/rpc). Commands travel over
// the already-open socket (no TCP setup per command, which on power-saving
// Wi-Fi costs as much as the command itself) and the device pushes
// NotifyStatus frames for every state change — brightness and colour
// temperature included, which the DS8 has no webhook events for.
//
// Recovery: a keepalive call every KEEPALIVE_MS catches half-open sockets
// (after a roam or an access-point restart the socket can look open while
// the device is long gone); any failure tears the socket down and a
// reconnect follows with exponential backoff plus jitter, so a fleet-wide
// outage doesn't end in 80 simultaneous reconnects.
//
// Events: 'connected', 'disconnected', 'status' (componentKey, partialStatus)

const HANDSHAKE_TIMEOUT_MS = 5000;
const KEEPALIVE_MS = 30000;
const KEEPALIVE_TIMEOUT_MS = 5000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60000;

class ShellyWsClient extends EventEmitter {
  constructor(ip, { log = () => {}, error = () => {} } = {}) {
    super();
    this.ip = ip;
    this.log = log;
    this.error = error;
    // Notifications only flow to connections that identified themselves
    // with a src in a request
    this.src = `hilux-app-${Math.random().toString(36).slice(2, 10)}`;
    this._ws = null;
    this._id = 0;
    this._pending = new Map();
    this._connected = false;
    this._stopped = true;
    this._attempt = 0;
    this._reconnectTimer = null;
    this._keepaliveTimer = null;
    this.stats = { connects: 0, drops: 0, since: null, lastDrop: null };
  }

  get connected() {
    return this._connected;
  }

  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._reconnectTimer);
    this._teardown('stopped');
  }

  // Resolves with the RPC result; rejects on RPC error, timeout, or when the
  // socket isn't open (callers fall back to HTTP).
  call(method, params = {}, timeoutMs = 3000) {
    if (!this._connected || !this._ws) return Promise.reject(new Error('not connected'));
    return this._send(method, params, timeoutMs);
  }

  _send(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++this._id;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`${method} timed out (${timeoutMs} ms)`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._ws.send(JSON.stringify({ id, src: this.src, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  _connect() {
    if (this._stopped) return;
    let ws;
    try {
      ws = new WebSocket(`ws://${this.ip}/rpc`, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
    } catch (err) {
      this._scheduleReconnect(err.message);
      return;
    }
    this._ws = ws;

    ws.on('open', async () => {
      if (this._ws !== ws) return;
      try {
        // First src-bearing request subscribes us to notifications and seeds
        // the full state
        const status = await this._send('CCT.GetStatus', { id: 0 }, KEEPALIVE_TIMEOUT_MS);
        if (this._ws !== ws) return;
        this._connected = true;
        this._attempt = 0;
        this.stats.connects += 1;
        this.stats.since = Date.now();
        this.emit('status', 'cct:0', status);
        this.emit('connected');
        this._armKeepalive();
      } catch (err) {
        this._teardown(`subscribe failed: ${err.message}`);
        this._scheduleReconnect();
      }
    });

    ws.on('message', (data) => this._onMessage(data));

    ws.on('close', () => {
      if (this._ws !== ws) return;
      this._teardown('closed by peer');
      this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      if (this._ws !== ws) return;
      this._teardown(err.message);
      this._scheduleReconnect();
    });
  }

  _onMessage(data) {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch (err) {
      return;
    }
    if (frame.id !== undefined && this._pending.has(frame.id)) {
      const { resolve, reject, timer } = this._pending.get(frame.id);
      clearTimeout(timer);
      this._pending.delete(frame.id);
      if (frame.error) reject(new Error(`RPC error ${frame.error.code}: ${frame.error.message}`));
      else resolve(frame.result);
      return;
    }
    if ((frame.method === 'NotifyStatus' || frame.method === 'NotifyFullStatus') && frame.params) {
      for (const [key, value] of Object.entries(frame.params)) {
        if (key !== 'ts' && value && typeof value === 'object') this.emit('status', key, value);
      }
    }
  }

  _armKeepalive() {
    clearTimeout(this._keepaliveTimer);
    this._keepaliveTimer = setTimeout(async () => {
      if (!this._connected) return;
      try {
        await this._send('Shelly.GetDeviceInfo', {}, KEEPALIVE_TIMEOUT_MS);
        this._armKeepalive();
      } catch (err) {
        this._teardown(`keepalive failed: ${err.message}`);
        this._scheduleReconnect();
      }
    }, KEEPALIVE_MS);
  }

  _teardown(reason) {
    clearTimeout(this._keepaliveTimer);
    const ws = this._ws;
    this._ws = null;
    const wasConnected = this._connected;
    this._connected = false;
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(new Error(`socket closed (${reason})`));
    }
    this._pending.clear();
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => {}); // a late error after terminate must not crash
      try { ws.terminate(); } catch (err) { /* already gone */ }
    }
    if (wasConnected) {
      this.stats.drops += 1;
      this.stats.lastDrop = { at: Date.now(), reason };
      this.log(`Live connection to ${this.ip} lost: ${reason}`);
      this.emit('disconnected', reason);
    }
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectPending) return;
    const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this._attempt);
    const delay = backoff / 2 + Math.random() * backoff / 2;
    this._attempt = Math.min(this._attempt + 1, 10);
    this._reconnectPending = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectPending = false;
      this._connect();
    }, delay);
  }
}

module.exports = ShellyWsClient;
