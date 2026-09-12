'use strict';

const crypto = require('crypto');

const SCRIPT_NAME = 'hilux-panel';

// Generates the panel script deployed onto a Shelly Wall Display: virtual
// components (toggle + brightness + colour sliders) drive a group of HiluX
// lights, and the reference light's state is mirrored back by polling.
//
// Wall Display quirks this script accounts for (fw 2.7.4):
// - status events arrive aggregated under component "shelly:0" with the
//   per-component values nested inside delta
// - the lights reject transition_duration < 0.5 s
// - the HTTP client methods are "HTTP.Get"/"HTTP.Post" (not HTTP.GET)
function generate({ lights, fade, ids }) {
  const body = `let LIGHTS = ${JSON.stringify(lights)};
let REF = LIGHTS[0];
let SW_ID = ${ids.sw}, BR_ID = ${ids.br}, CT_ID = ${ids.ct};
let SW = "boolean:${ids.sw}", BR = "number:${ids.br}", CT = "number:${ids.ct}";
let FADE = ${JSON.stringify(fade)};
let VERIFY_TRIES = 3;
let L = { on: null, b: 50, ct: 3150 };
let holdPolls = 0; // sync pushes suppressed right after we command the lights
let gen = 0; // bumped per command; cancels verify rounds of superseded commands

// All RPC goes through a small queue: Shelly.call throws synchronously past
// 5 concurrent calls, which would silently drop commands for large light
// groups. At most MAX_CALLS in flight; the rest wait their turn in order.
let Q = [];
let ACTIVE = 0;
let MAX_CALLS = 4;

// Every dispatch happens from its own fresh Timer tick, one call per tick:
// firing several Shelly.calls synchronously from inside another call's
// callback can make the RPC layer reject them with -103 (seen on the i4;
// avoided here the same way).
let PUMP_SCHED = false;

function pump() {
  if (PUMP_SCHED) return;
  PUMP_SCHED = true;
  Timer.set(10, false, function () {
    PUMP_SCHED = false;
    if (ACTIVE >= MAX_CALLS || Q.length === 0) return;
    let job = Q.splice(0, 1)[0];
    let started = true;
    ACTIVE++;
    try {
      Shelly.call(job.m, job.p, function (res, ec, em) {
        ACTIVE--;
        try { if (job.cb) job.cb(res, ec, em); } catch (e) {}
        pump();
      });
    } catch (e) {
      started = false;
    }
    if (!started) {
      ACTIVE--;
      Q.splice(0, 0, job);
      Timer.set(200, false, pump);
      return;
    }
    if (Q.length > 0) pump();
  });
}

function rpc(method, params, cb) {
  Q.push({ m: method, p: params, cb: cb });
  pump();
}
function call(url) {
  rpc("HTTP.Get", { url: url, timeout: 2 }, null);
}
function callCb(url, cb) {
  rpc("HTTP.Get", { url: url, timeout: 2 }, cb);
  return true;
}
function callAll(qs) {
  holdPolls = 2;
  gen++;
  for (let i = 0; i < LIGHTS.length; i++) call("http://" + LIGHTS[i] + "/rpc/CCT.Set?id=0&" + qs);
}

// After the fade, make sure every light actually reached the commanded
// on/off state — a napping light can miss the command entirely (same
// verify rounds as the i4 button script). A light in the wrong state gets
// the command re-sent; one that doesn't answer the status check gets it
// re-sent blind. Abandoned when a newer command takes over (gen moved).
function verifyLight(ip, g, wantOn, qs, waitMs, tries) {
  let again = function () {
    if (tries <= 1) return;
    Timer.set(waitMs, false, function () {
      if (g !== gen) return;
      verifyLight(ip, g, wantOn, qs, waitMs, tries - 1);
    });
  };
  let ok = callCb("http://" + ip + "/rpc/CCT.GetStatus?id=0", function (res) {
    if (g !== gen) return;
    let st = null;
    if (res && res.code === 200) st = JSON.parse(res.body);
    if (st && st.output === wantOn) return;
    call("http://" + ip + "/rpc/CCT.Set?id=0&" + qs);
    again();
  });
  if (!ok) again();
}

function verifyToggle(wantOn, qs) {
  let g = gen;
  let waitMs = FADE * 1000 + 800;
  if (waitMs < 2000) waitMs = 2000;
  Timer.set(FADE * 1000 + 800, false, function () {
    if (g !== gen) return;
    for (let i = 0; i < LIGHTS.length; i++) verifyLight(LIGHTS[i], g, wantOn, qs, waitMs, VERIFY_TRIES);
  });
}

// Panel interactions -> lights. Events our own sync produces are filtered
// out because the cache is updated before the virtual component is set.
// Value changes only ever act after the first sync has seeded the cache.
function handleVals(vals) {
  if (L.on === null) return;
  if (vals.sw !== undefined && vals.sw !== L.on) {
    L.on = vals.sw;
    let qs = L.on
      ? "on=true&brightness=" + JSON.stringify(L.b) + "&ct=" + JSON.stringify(L.ct) + "&transition_duration=" + JSON.stringify(FADE)
      : "on=false&transition_duration=" + JSON.stringify(FADE);
    callAll(qs);
    verifyToggle(L.on, qs);
  }
  if (vals.b !== undefined) {
    let v = Math.round(vals.b);
    if (v !== L.b) {
      L.b = v;
      L.on = true; // moving the slider implies wanting light
      callAll("on=true&brightness=" + JSON.stringify(v) + "&transition_duration=0.5");
    }
  }
  if (vals.ct !== undefined) {
    let v = Math.round(vals.ct);
    if (v !== L.ct) {
      L.ct = v;
      callAll("ct=" + JSON.stringify(v) + "&transition_duration=0.5");
    }
  }
}

Shelly.addStatusHandler(function (ev) {
  if (!ev || !ev.delta) return;
  let d = ev.delta;
  let vals = {};
  if (ev.component === SW && typeof d.value === "boolean") vals.sw = d.value;
  if (ev.component === BR && typeof d.value === "number") vals.b = d.value;
  if (ev.component === CT && typeof d.value === "number") vals.ct = d.value;
  if (d[SW] && typeof d[SW].value === "boolean") vals.sw = d[SW].value;
  if (d[BR] && typeof d[BR].value === "number") vals.b = d[BR].value;
  if (d[CT] && typeof d[CT].value === "number") vals.ct = d[CT].value;
  handleVals(vals);
});

// Lights -> panel: poll the reference light so changes made elsewhere
// (wall buttons, Homey, wake-up light) show up on the display.
Timer.set(3000, true, function () {
  callCb("http://" + REF + "/rpc/CCT.GetStatus?id=0", function (res) {
    if (!res || res.code !== 200) return;
    if (holdPolls > 0) { holdPolls--; return; }
    let st = JSON.parse(res.body);
    if (!st) return;
    let first = L.on === null;
    let on = st.output === true;
    let b = typeof st.brightness === "number" ? Math.round(st.brightness) : L.b;
    let ct = typeof st.ct === "number" ? Math.round(st.ct) : L.ct;
    if (first || L.on !== on) { L.on = on; rpc("Boolean.Set", { id: SW_ID, value: on }); }
    if (first || L.b !== b) { L.b = b; rpc("Number.Set", { id: BR_ID, value: b }); }
    if (first || L.ct !== ct) { L.ct = ct; rpc("Number.Set", { id: CT_ID, value: ct }); }
  });
});
`;

  const hash = crypto.createHash('sha1').update(body).digest('hex').slice(0, 12);
  const code = `// AUTO-GENERATED by the HiluX DS8 Homey app — do not edit by hand.
// Changes are overwritten; configure via the group device in Homey.
// hash:${hash}
${body}`;

  return { code, hash };
}

module.exports = { generate, SCRIPT_NAME };
