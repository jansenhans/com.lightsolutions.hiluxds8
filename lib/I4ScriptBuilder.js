'use strict';

const crypto = require('crypto');

const SCRIPT_NAME = 'hilux-app-buttons';

// Generates the mJS button script deployed onto a Shelly i4 Gen3. One script
// per i4 handles all of its configured inputs; each input has its own light
// list (the HiluX lights in the button device's Homey zone) and behavior.
//
// configsByInput: { '<input 0-3>': {
//   lights: ['192.168.0.21', ...],
//   dimRate: 1..5, dimFloor: 1..50, ctSweepS: seconds,
//   presetDouble: 0..100 (0 disables), presetTriple: 0..100 (0 disables),
//   fadeOn: seconds, fadeOff: seconds,
// } }
function generate(configsByInput, pushBaseUrl) {
  const cfgJson = JSON.stringify(configsByInput);

  const body = `let CFG = ${cfgJson};
let PUSH = ${JSON.stringify(pushBaseUrl || '')};
let CT_MIN = 2200;
let CT_MAX = 6000;
let TAP_HOLD_GAP = 0.6;
let FAST_WAIT = 150;

let ST = {};
for (let k in CFG) {
  ST[k] = { dimUp: true, ctUp: true, fading: false, ctFading: false, lastTapEnd: 0, downTs: 0, tapPreceded: false, on: null, b: 50, ct: 3150, gen: 0 };
}

// Fire-and-forget RPC that can never crash the script (Shelly.call throws
// synchronously past 5 concurrent calls, e.g. when a light is unreachable).
function safeCall(url, cb) {
  try {
    Shelly.call("HTTP.GET", { url: url, timeout: 2 }, cb || function () {});
    return true;
  } catch (e) {
    return false;
  }
}

function callAll(cfg, method, qs) {
  for (let i = 0; i < cfg.lights.length; i++) {
    safeCall("http://" + cfg.lights[i] + "/rpc/" + method + "?id=0" + (qs ? "&" + qs : ""));
  }
}

// Tell Homey a light's state changed so its tiles update immediately.
// On/off transitions are pushed by the lights' own webhooks; these pings
// cover brightness/colour gestures, which have no webhook event.
function pushHomey(cfg, delayMs) {
  if (!PUSH) return;
  Timer.set(delayMs, false, function () {
    for (let i = 0; i < cfg.lights.length; i++) {
      safeCall(PUSH + cfg.lights[i]);
    }
  });
}

// First light of the group is the reference for group decisions
function getStatus(cfg, cb) {
  if (cfg.lights.length === 0) { cb(null); return; }
  let ok = safeCall("http://" + cfg.lights[0] + "/rpc/CCT.GetStatus?id=0", function (res) {
    let st = null;
    if (res && res.code === 200) st = JSON.parse(res.body);
    cb(st);
  });
  if (!ok) cb(null);
}

function adopt(s, st) {
  if (!st) return;
  s.on = st.output === true;
  if (typeof st.brightness === "number") s.b = Math.round(st.brightness);
  if (typeof st.ct === "number") s.ct = Math.round(st.ct);
}

// Status fetch that also refreshes the cached group state — used by gestures
// where correctness beats the extra round-trip (they hide it in the hold).
function withStatus(cfg, s, cb) {
  getStatus(cfg, function (st) {
    adopt(s, st);
    cb(st);
  });
}

// After the fade, make sure every light actually reached the commanded
// on/off state — a napping light can miss the command entirely. Re-sent
// once per light; skipped when a newer gesture has taken over (gen moved).
function verifyToggle(cfg, s, gen, wantOn, fade, qs) {
  Timer.set(fade * 1000 + 800, false, function () {
    if (s.gen !== gen) return;
    for (let i = 0; i < cfg.lights.length; i++) {
      (function (ip) {
        safeCall("http://" + ip + "/rpc/CCT.GetStatus?id=0", function (res) {
          if (s.gen !== gen || !res || res.code !== 200) return;
          let st = JSON.parse(res.body);
          if (st && st.output !== wantOn) safeCall("http://" + ip + "/rpc/CCT.Set?id=0&" + qs);
        });
      })(cfg.lights[i]);
    }
  });
}

function applyToggle(cfg, s, on) {
  s.gen++;
  let fade;
  let qs;
  if (on) {
    s.on = false;
    fade = cfg.fadeOff;
    qs = "on=false&transition_duration=" + JSON.stringify(fade);
  } else {
    // One shared brightness AND colour so the whole group comes on identical —
    // re-aligns any light whose state drifted (e.g. it changed zones).
    let b = s.b < cfg.dimFloor ? cfg.dimFloor : s.b;
    s.on = true;
    fade = cfg.fadeOn;
    qs = "on=true&brightness=" + JSON.stringify(b) + "&ct=" + JSON.stringify(s.ct) + "&transition_duration=" + JSON.stringify(fade);
  }
  callAll(cfg, "CCT.Set", qs);
  verifyToggle(cfg, s, s.gen, !on, fade, qs);
}

// Toggle must feel instant, so a slow (power-saving) reference light may not
// stall it: the light gets FAST_WAIT ms to answer, then the cached state
// decides. A reply that arrives after we acted only freshens brightness and
// colour — its on/off is ambiguous, it may already reflect our own command.
function toggle(cfg, s) {
  let acted = false;
  getStatus(cfg, function (st) {
    if (acted) {
      if (st && typeof st.brightness === "number") s.b = Math.round(st.brightness);
      if (st && typeof st.ct === "number") s.ct = Math.round(st.ct);
      return;
    }
    acted = true;
    adopt(s, st);
    applyToggle(cfg, s, s.on === true);
  });
  if (s.on !== null) {
    Timer.set(FAST_WAIT, false, function () {
      if (acted) return;
      acted = true;
      applyToggle(cfg, s, s.on === true);
    });
  }
}

function dimTo(cfg, s, pct) {
  withStatus(cfg, s, function (st) {
    if (!st || st.output !== true) return;
    s.gen++;
    s.b = pct;
    callAll(cfg, "CCT.Set", "brightness=" + JSON.stringify(pct) + "&transition_duration=1");
    pushHomey(cfg, 1300);
  });
}

function beginDim(cfg, s, up, b) {
  s.gen++;
  s.fading = true;
  if (up) {
    callAll(cfg, "CCT.DimUp", "fade_rate=" + JSON.stringify(cfg.dimRate));
    return;
  }
  // Timed fade to the floor so a held dim never goes invisible
  let d = Math.max(0.5, (b - cfg.dimFloor) / (cfg.dimRate * 4));
  callAll(cfg, "CCT.Set", "brightness=" + JSON.stringify(cfg.dimFloor) + "&transition_duration=" + JSON.stringify(d));
}

function startDim(cfg, s) {
  withStatus(cfg, s, function (st) {
    let b = 50;
    let on = false;
    if (st) {
      if (typeof st.brightness === "number") b = st.brightness;
      on = st.output === true;
    }
    if (!on || b <= cfg.dimFloor + 2) s.dimUp = true;
    else if (b >= 97) s.dimUp = false;
    let up = s.dimUp;
    s.dimUp = !s.dimUp;
    if (on) { beginDim(cfg, s, up, b); return; }
    // Off: turn on at 1% first — DimUp during switch-on is ignored
    let pending = cfg.lights.length;
    if (pending === 0) return;
    s.gen++;
    s.on = true;
    let done = function () { pending--; if (pending === 0) beginDim(cfg, s, up, 1); };
    for (let i = 0; i < cfg.lights.length; i++) {
      if (!safeCall("http://" + cfg.lights[i] + "/rpc/CCT.Set?id=0&on=true&brightness=1", done)) done();
    }
  });
}

function startCt(cfg, s) {
  withStatus(cfg, s, function (st) {
    if (!st || st.output !== true) return;
    let ct = typeof st.ct === "number" ? st.ct : 3150;
    if (ct <= CT_MIN + 50) s.ctUp = true;
    else if (ct >= CT_MAX - 50) s.ctUp = false;
    let target = s.ctUp ? CT_MAX : CT_MIN;
    s.ctUp = !s.ctUp;
    s.gen++;
    s.ctFading = true;
    let d = Math.max(0.5, Math.abs(target - ct) * cfg.ctSweepS / (CT_MAX - CT_MIN));
    callAll(cfg, "CCT.Set", "ct=" + JSON.stringify(target) + "&transition_duration=" + JSON.stringify(d));
  });
}

// DimStop freezes brightness and colour transitions alike
function stopSweep(cfg, s) {
  if (!s.fading && !s.ctFading) return;
  s.gen++;
  s.fading = false;
  s.ctFading = false;
  callAll(cfg, "CCT.DimStop");
  pushHomey(cfg, 400);
}

Shelly.addEventHandler(function (ev) {
  if (!ev.component || ev.component.indexOf("input:") !== 0) return;
  let k = ev.component.slice(6);
  let cfg = CFG[k];
  let s = ST[k];
  if (!cfg || !s) return;
  let e = ev.info.event;
  let ts = (ev.info && typeof ev.info.ts === "number") ? ev.info.ts : 0;
  if (e === "btn_down") {
    s.tapPreceded = ts > 0 && s.lastTapEnd > 0 && (ts - s.lastTapEnd) < TAP_HOLD_GAP;
    s.downTs = ts;
  } else if (e === "btn_up") {
    if (ts > 0 && s.downTs > 0 && (ts - s.downTs) < 0.35) s.lastTapEnd = ts;
    stopSweep(cfg, s);
  } else if (e === "long_push") {
    if (s.tapPreceded) startCt(cfg, s);
    else startDim(cfg, s);
  } else if (e === "single_push") {
    toggle(cfg, s);
  } else if (e === "double_push") {
    if (cfg.presetDouble > 0) dimTo(cfg, s, cfg.presetDouble);
  } else if (e === "triple_push") {
    if (cfg.presetTriple > 0) dimTo(cfg, s, cfg.presetTriple);
  }
});

// Seed the caches so the very first press after a script (re)start doesn't
// need the slow path. Staggered: Shelly.call allows only 5 concurrent calls.
let seedDelay = 1000;
for (let k in CFG) {
  (function (k2, d) {
    Timer.set(d, false, function () {
      withStatus(CFG[k2], ST[k2], function () {});
    });
  })(k, seedDelay);
  seedDelay += 400;
}
`;

  // Hash the full generated body (config AND template) so both config
  // changes and app updates to the script logic trigger a redeploy.
  const hash = crypto.createHash('sha1').update(body).digest('hex').slice(0, 12);
  const code = `// AUTO-GENERATED by the HiluX DS8 Homey app — do not edit by hand.
// Changes are overwritten; configure via the button devices in Homey.
// hash:${hash}
${body}`;

  return { code, hash };
}

module.exports = { generate, SCRIPT_NAME };
