// Bathroom 2 button 1 (input:0) -> HiluX DS8 downlights, all-local control:
//   single push:  toggle all lights on/off (based on actual light state)
//   double push:  dim to 20% (only when lights are on)
//   triple push:  dim to 50% (only when lights are on)
//   long push:    fade up/down (alternating); release freezes at current level
let LIGHTS = ["192.168.1.176", "192.168.1.194", "192.168.1.111", "192.168.1.179"];
let FULL_RANGE_S = 5; // seconds for a full 1..100% dim sweep
let dimUp = true;     // direction of the next long push
let fading = false;

function setLight(ip, qs) {
  Shelly.call("HTTP.GET", { url: "http://" + ip + "/rpc/CCT.Set?id=0&" + qs, timeout: 3 }, function () {});
}

function setAll(qs) {
  for (let i = 0; i < LIGHTS.length; i++) setLight(LIGHTS[i], qs);
}

// Read the first light's status as the reference for group decisions
function withStatus(cb) {
  Shelly.call("HTTP.GET", { url: "http://" + LIGHTS[0] + "/rpc/CCT.GetStatus?id=0", timeout: 3 }, function (res) {
    let st = null;
    if (res && res.code === 200) st = JSON.parse(res.body);
    cb(st);
  });
}

function freeze(ip) {
  Shelly.call("HTTP.GET", { url: "http://" + ip + "/rpc/CCT.GetStatus?id=0", timeout: 3 }, function (res) {
    if (!res || res.code !== 200) return;
    let st = JSON.parse(res.body);
    if (typeof st.brightness === "number") {
      setLight(ip, "brightness=" + JSON.stringify(Math.round(st.brightness)));
    }
  });
}

function toggle() {
  withStatus(function (st) {
    let on = st ? st.output === true : false;
    setAll("on=" + JSON.stringify(!on) + "&transition_duration=0.5");
  });
}

function dimTo(pct) {
  withStatus(function (st) {
    if (!st || st.output !== true) return; // only when lights are on
    setAll("brightness=" + JSON.stringify(pct) + "&transition_duration=1");
  });
}

function startDim() {
  withStatus(function (st) {
    let b = 50;
    let on = false;
    if (st) {
      if (typeof st.brightness === "number") b = st.brightness;
      on = st.output === true;
    }
    if (!on || b <= 3) dimUp = true;
    else if (b >= 97) dimUp = false;
    let target = dimUp ? 100 : 1;
    dimUp = !dimUp; // alternate for the next long push
    fading = true;
    setAll("on=true&brightness=" + JSON.stringify(target) + "&transition_duration=" + JSON.stringify(FULL_RANGE_S));
  });
}

function stopDim() {
  if (!fading) return;
  fading = false;
  for (let i = 0; i < LIGHTS.length; i++) {
    freeze(LIGHTS[i]);
  }
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
