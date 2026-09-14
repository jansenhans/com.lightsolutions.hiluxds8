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
let TAP_HOLD_GAP = 1.0; // measured: Hans's natural tap-to-hold pause is 0.6-0.9 s
let FAST_WAIT = 150;
let VERIFY_TRIES = 3;

let ST = {};
for (let k in CFG) {
  ST[k] = { dimUp: true, ctUp: true, fading: false, ctFading: false, lastTapEnd: 0, downTs: 0, tapStreak: 0, holdStreak: 0, on: null, b: 50, ct: 3150, gen: 0, undoOn: null, singleTs: 0, doubleTs: 0, dblUsed: false, dblSeq: 0 };
}

// All RPC goes through a small queue: Shelly.call throws synchronously past
// 5 concurrent calls, which silently dropped the commands for lights 5+ of
// a cluster (they only came on seconds later, via the verify rounds). At
// most MAX_CALLS are in flight; the rest wait their turn in order.
let Q = [];
let ACTIVE = 0;
let MAX_CALLS = 4;

// Every dispatch happens from its own fresh Timer tick, one call per tick:
// firing several long-URL Shelly.calls synchronously from inside another
// call's callback makes the RPC layer reject them with -103 "Malformed
// JSON request" (observed on i4 fw 2.0.0), while the same calls from timer
// context always go through.
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
      Shelly.call("HTTP.GET", { url: job.u, timeout: 2 }, function (res, ec, em) {
        ACTIVE--;
        try { if (job.cb) job.cb(res, ec, em); } catch (e) {}
        pump();
      });
    } catch (e) {
      started = false;
    }
    if (!started) {
      // Slot taken by something outside the queue — retry shortly
      ACTIVE--;
      Q.splice(0, 0, job);
      Timer.set(200, false, pump);
      return;
    }
    if (Q.length > 0) pump();
  });
}

function safeCall(url, cb) {
  Q.push({ u: url, cb: cb });
  pump();
  return true;
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
// on/off state — a napping light can miss the command entirely. A light in
// the wrong state gets the command re-sent; one that doesn't answer the
// status check (a nap swallows that too) gets it re-sent blind. Each light
// is re-checked until confirmed, up to VERIFY_TRIES rounds, abandoned the
// moment a newer gesture takes over (gen moved).
function verifyLight(ip, s, gen, wantOn, qs, waitMs, tries) {
  let again = function () {
    if (tries <= 1) return;
    Timer.set(waitMs, false, function () {
      if (s.gen !== gen) return;
      verifyLight(ip, s, gen, wantOn, qs, waitMs, tries - 1);
    });
  };
  let ok = safeCall("http://" + ip + "/rpc/CCT.GetStatus?id=0", function (res) {
    if (s.gen !== gen) return;
    let st = null;
    if (res && res.code === 200) st = JSON.parse(res.body);
    if (st && st.output === wantOn) return;
    safeCall("http://" + ip + "/rpc/CCT.Set?id=0&" + qs);
    again();
  });
  if (!ok) again();
}

function verifyToggle(cfg, s, gen, wantOn, fade, qs) {
  let waitMs = fade * 1000 + 800;
  if (waitMs < 2000) waitMs = 2000;
  Timer.set(fade * 1000 + 800, false, function () {
    if (s.gen !== gen) return;
    for (let i = 0; i < cfg.lights.length; i++) {
      verifyLight(cfg.lights[i], s, gen, wantOn, qs, waitMs, VERIFY_TRIES);
    }
  });
}

function applyToggle(cfg, s, on) {
  s.undoOn = on; // pre-toggle state, so a tap+hold can revert its stray tap
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

// Upward brightness commands carry on=true: DS8 fw 2.0.0 latches an internal
// clamp after a stopped dim (upward changes silently ignored until an off/on
// cycle) and on=true bypasses it. Native CCT.DimUp is avoided for the same
// reason — a timed Set fade dims up instead, and CCT.DimStop freezes Set
// transitions, so release-to-stop behaves identically.
function dimTo(cfg, s, pct) {
  withStatus(cfg, s, function (st) {
    if (!st || st.output !== true) return;
    s.gen++;
    s.b = pct;
    callAll(cfg, "CCT.Set", "on=true&brightness=" + JSON.stringify(pct) + "&transition_duration=1");
    pushHomey(cfg, 1300);
  });
}

function beginDim(cfg, s, up, b) {
  s.gen++;
  s.fading = true;
  if (up) {
    let d = Math.max(0.5, (100 - b) / (cfg.dimRate * 4));
    callAll(cfg, "CCT.Set", "on=true&brightness=100&transition_duration=" + JSON.stringify(d));
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

// The tap of a tap+hold colour gesture fires its own single_push on i4
// fw 2.0.0 — the firmware's multi-push suppression window (~0.35 s) is
// shorter than a natural tap-to-hold gap — so the toggle has usually
// already executed by the time the hold's long_push arrives. Undo it:
// restore the pre-toggle state, then the colour sweep proceeds cleanly.
function undoToggle(cfg, s, ts) {
  if (s.undoOn === null) return;
  let wantOn = s.undoOn;
  s.undoOn = null;
  if (!(ts > 0 && s.singleTs > 0 && (ts - s.singleTs) < 2)) return;
  s.gen++;
  if (wantOn) {
    s.on = true;
    callAll(cfg, "CCT.Set", "on=true&brightness=" + JSON.stringify(s.b) + "&ct=" + JSON.stringify(s.ct) + "&transition_duration=0.5");
  } else {
    s.on = false;
    callAll(cfg, "CCT.Set", "on=false&transition_duration=0.5");
  }
}

// Freeze on release by reading the reference light and setting the whole
// group to that level (brightness AND colour, so ct sweeps freeze too, and
// the group ends uniform instead of each light frozen mid-fade at its own
// point). CCT.DimStop is avoided: on fw 2.0.0 it misbehaves — after a stop,
// lights nondeterministically ignore later upward brightness commands until
// an off/on cycle. 0.5 is the firmware's minimum transition (lower values
// are rejected with -103).
function stopSweep(cfg, s) {
  if (!s.fading && !s.ctFading) return;
  s.gen++;
  s.fading = false;
  s.ctFading = false;
  let g = s.gen;
  getStatus(cfg, function (st) {
    if (s.gen !== g || !st) return;
    if (typeof st.brightness === "number") s.b = Math.round(st.brightness);
    if (typeof st.ct === "number") s.ct = Math.round(st.ct);
    if (st.output !== true) return;
    let qs = "on=true&brightness=" + JSON.stringify(s.b) + "&ct=" + JSON.stringify(s.ct) + "&transition_duration=0.5";
    callAll(cfg, "CCT.Set", qs);
    // One aligned re-send heals any light that napped through the freeze,
    // so the group can't stay visibly mismatched after a gesture
    Timer.set(1200, false, function () {
      if (s.gen !== g) return;
      callAll(cfg, "CCT.Set", qs);
    });
  });
  pushHomey(cfg, 900);
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
    // The tap streak is counted from raw press events: when a hold follows
    // taps quickly, fw 2.0.0 swallows the taps entirely (no single_push,
    // no double_push — verified by event traces), so the firmware's own
    // classification cannot be relied on for compound gestures.
    s.holdStreak = (ts > 0 && s.lastTapEnd > 0 && (ts - s.lastTapEnd) < TAP_HOLD_GAP) ? s.tapStreak : 0;
    // A press soon after an emitted double_push cancels its deferred preset
    if (ts > 0 && s.doubleTs > 0 && (ts - s.doubleTs) < TAP_HOLD_GAP) s.dblUsed = true;
    s.downTs = ts;
  } else if (e === "btn_up") {
    if (ts > 0 && s.downTs > 0 && (ts - s.downTs) < 0.35) {
      s.tapStreak = (s.lastTapEnd > 0 && (s.downTs - s.lastTapEnd) < TAP_HOLD_GAP) ? s.tapStreak + 1 : 1;
      s.lastTapEnd = ts;
    } else {
      s.tapStreak = 0; // a long press breaks the tap chain
    }
    stopSweep(cfg, s);
  } else if (e === "long_push") {
    // Colour sweep = two (or more) taps then hold; one tap then hold is a
    // compound dim. Either way any stray toggle the taps fired is undone.
    if (s.holdStreak >= 1) undoToggle(cfg, s, ts);
    if (s.holdStreak >= 2) startCt(cfg, s);
    else startDim(cfg, s);
  } else if (e === "single_push") {
    s.singleTs = ts;
    toggle(cfg, s);
  } else if (e === "double_push") {
    // Deferred: only a double-tap that is NOT followed by another press
    // (the colour gesture) applies the preset.
    s.doubleTs = ts;
    s.dblUsed = false;
    if (cfg.presetDouble > 0) {
      s.dblSeq++;
      (function (seq) {
        Timer.set(1300, false, function () {
          if (s.dblSeq !== seq || s.dblUsed) return;
          dimTo(cfg, s, cfg.presetDouble);
        });
      })(s.dblSeq);
    }
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
