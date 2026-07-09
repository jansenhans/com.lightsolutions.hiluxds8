// Bathroom 2 button 1 (input:0) -> HiluX DS8 downlights, all-local control:
//   single push:  toggle all lights on/off (based on actual light state)
//   double push:  dim to 20% (only when lights are on)
//   triple push:  dim to 50% (only when lights are on)
//   long push:    dim up/down (alternating); release freezes at current level
//   tap + hold:   colour temperature warm/cool sweep (alternating); release freezes
// Requires light firmware >= 2.0.0 (native CCT.DimUp/DimDown/DimStop).
let LIGHTS = ["192.168.0.21", "192.168.0.22", "192.168.0.23", "192.168.0.24"];
let DIM_RATE = 5;   // 1 (slow, ~25 s full range) .. 5 (fast, ~5 s full range)
let DIM_FLOOR = 5;  // dim-down stops here, so the lights never fade to invisible
let CT_MIN = 2200;  // warm end of the sweep (K)
let CT_MAX = 6000;  // cool end of the sweep (K)
let CT_SWEEP_S = 5; // seconds for a full warm-to-cool sweep
let TAP_HOLD_GAP = 0.6; // max seconds between a tap's release and the hold's press
let dimUp = true;   // direction of the next brightness hold
let ctUp = true;    // direction of the next colour hold
let fading = false;
let ctFading = false;

// Fire-and-forget RPC that can never crash the script: an unreachable light
// keeps calls in flight until timeout, and stacked button presses can then
// exceed the 5-concurrent-calls limit — Shelly.call throws synchronously.
function safeCall(url, cb) {
  try {
    Shelly.call("HTTP.GET", { url: url, timeout: 2 }, cb || function () {});
    return true;
  } catch (e) {
    return false;
  }
}

function callAll(method, qs) {
  for (let i = 0; i < LIGHTS.length; i++) {
    safeCall("http://" + LIGHTS[i] + "/rpc/" + method + "?id=0" + (qs ? "&" + qs : ""));
  }
}

// Read the first light's status as the reference for group decisions
function withStatus(cb) {
  let ok = safeCall("http://" + LIGHTS[0] + "/rpc/CCT.GetStatus?id=0", function (res) {
    let st = null;
    if (res && res.code === 200) st = JSON.parse(res.body);
    cb(st);
  });
  if (!ok) cb(null);
}

function toggle() {
  withStatus(function (st) {
    let on = st ? st.output === true : false;
    if (on) {
      callAll("CCT.Set", "on=false&transition_duration=0.5");
      return;
    }
    // Turn on with one shared brightness (the reference light's remembered
    // level) so all lights ramp identically — per-light remembered levels
    // drift apart and make lights appear to respond at different speeds.
    // 1.5 s fade-in so the ramp is visible (its low end emits almost no light).
    let b = st && typeof st.brightness === "number" ? Math.round(st.brightness) : 50;
    if (b < DIM_FLOOR) b = DIM_FLOOR;
    callAll("CCT.Set", "on=true&brightness=" + JSON.stringify(b) + "&transition_duration=1.5");
  });
}

function dimTo(pct) {
  withStatus(function (st) {
    if (!st || st.output !== true) return; // only when lights are on
    callAll("CCT.Set", "brightness=" + JSON.stringify(pct) + "&transition_duration=1");
  });
}

function beginDim(up, b) {
  fading = true;
  if (up) {
    callAll("CCT.DimUp", "fade_rate=" + JSON.stringify(DIM_RATE));
    return;
  }
  // Down: timed fade to DIM_FLOOR at the same speed (~4%/s per rate unit),
  // so the lights never dim below a visible level. DimStop freezes it.
  let duration = Math.max(0.5, (b - DIM_FLOOR) / (DIM_RATE * 4));
  callAll("CCT.Set", "brightness=" + JSON.stringify(DIM_FLOOR) + "&transition_duration=" + JSON.stringify(duration));
}

function startDim() {
  withStatus(function (st) {
    let b = 50;
    let on = false;
    if (st) {
      if (typeof st.brightness === "number") b = st.brightness;
      on = st.output === true;
    }
    if (!on || b <= DIM_FLOOR + 2) dimUp = true;
    else if (b >= 97) dimUp = false;
    let up = dimUp;
    dimUp = !dimUp; // alternate for the next long push
    if (on) {
      beginDim(up, b);
      return;
    }
    // Lights are off: turn on at 1% first, start dimming once they confirm —
    // DimUp sent while a light is still switching on is ignored.
    let pending = LIGHTS.length;
    let done = function () {
      pending--;
      if (pending === 0) beginDim(up, 1);
    };
    for (let i = 0; i < LIGHTS.length; i++) {
      if (!safeCall("http://" + LIGHTS[i] + "/rpc/CCT.Set?id=0&on=true&brightness=1", done)) done();
    }
  });
}

// Tap + hold: sweep colour temperature between CT_MIN and CT_MAX,
// alternating direction each use. Only when the lights are on.
function startCt() {
  withStatus(function (st) {
    if (!st || st.output !== true) return;
    let ct = typeof st.ct === "number" ? st.ct : 3150;
    if (ct <= CT_MIN + 50) ctUp = true;
    else if (ct >= CT_MAX - 50) ctUp = false;
    let target = ctUp ? CT_MAX : CT_MIN;
    ctUp = !ctUp; // alternate for the next tap+hold
    ctFading = true;
    let duration = Math.max(0.5, Math.abs(target - ct) * CT_SWEEP_S / (CT_MAX - CT_MIN));
    callAll("CCT.Set", "ct=" + JSON.stringify(target) + "&transition_duration=" + JSON.stringify(duration));
  });
}

// DimStop freezes both brightness and colour transitions mid-flight.
function stopSweep() {
  if (!fading && !ctFading) return;
  fading = false;
  ctFading = false;
  callAll("CCT.DimStop");
}

// Gesture detection: Shelly's classifier handles single/double/triple/long
// push. "Tap then hold" is ours: a short press (<0.35 s) followed within
// TAP_HOLD_GAP by a press that becomes a long_push. The classifier stays
// quiet about the tap because the hold starts inside its multi-push window.
let lastTapEnd = 0;
let downTs = 0;
let tapPreceded = false;

Shelly.addEventHandler(function (ev) {
  if (ev.component !== "input:0") return;
  let e = ev.info.event;
  let ts = (ev.info && typeof ev.info.ts === "number") ? ev.info.ts : 0;
  if (e === "btn_down") {
    tapPreceded = ts > 0 && lastTapEnd > 0 && (ts - lastTapEnd) < TAP_HOLD_GAP;
    downTs = ts;
  } else if (e === "btn_up") {
    if (ts > 0 && downTs > 0 && (ts - downTs) < 0.35) lastTapEnd = ts;
    stopSweep();
  } else if (e === "long_push") {
    if (tapPreceded) startCt();
    else startDim();
  } else if (e === "single_push") toggle();
  else if (e === "double_push") dimTo(20);
  else if (e === "triple_push") dimTo(50);
});
