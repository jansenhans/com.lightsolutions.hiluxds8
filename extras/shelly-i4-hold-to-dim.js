// Bathroom 2 button 1 (input:0) -> HiluX DS8 downlights, all-local control:
//   single push:  toggle all lights on/off (based on actual light state)
//   double push:  dim to 20% (only when lights are on)
//   triple push:  dim to 50% (only when lights are on)
//   long push:    dim up/down (alternating); release freezes at current level
// Requires light firmware >= 2.0.0 (native CCT.DimUp/DimDown/DimStop).
let LIGHTS = ["192.168.1.176", "192.168.1.194", "192.168.1.111", "192.168.1.179"];
let DIM_RATE = 5;   // 1 (slow, ~25 s full range) .. 5 (fast, ~5 s full range)
let DIM_FLOOR = 5;  // dim-down stops here, so the lights never fade to invisible
let dimUp = true;   // direction of the next long push
let fading = false;

function callAll(method, qs) {
  for (let i = 0; i < LIGHTS.length; i++) {
    Shelly.call("HTTP.GET", {
      url: "http://" + LIGHTS[i] + "/rpc/" + method + "?id=0" + (qs ? "&" + qs : ""),
      timeout: 3,
    }, function () {});
  }
}

// Read the first light's status as the reference for group decisions
function withStatus(cb) {
  Shelly.call("HTTP.GET", { url: "http://" + LIGHTS[0] + "/rpc/CCT.GetStatus?id=0", timeout: 3 }, function (res) {
    let st = null;
    if (res && res.code === 200) st = JSON.parse(res.body);
    cb(st);
  });
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
    for (let i = 0; i < LIGHTS.length; i++) {
      Shelly.call("HTTP.GET", {
        url: "http://" + LIGHTS[i] + "/rpc/CCT.Set?id=0&on=true&brightness=1",
        timeout: 3,
      }, function () {
        pending--;
        if (pending === 0) beginDim(up, 1);
      });
    }
  });
}

function stopDim() {
  if (!fading) return;
  fading = false;
  callAll("CCT.DimStop");
}

Shelly.addEventHandler(function (ev) {
  if (ev.component !== "input:0") return;
  let e = ev.info.event;
  if (e === "long_push") startDim();
  else if (e === "btn_up") stopDim();
  else if (e === "single_push") toggle();
  else if (e === "double_push") dimTo(20);
  else if (e === "triple_push") dimTo(50);
});
