'use strict';

// Self-contained touch dashboard served by the app's HTTP server for wall
// displays (rendered by the Shelly Wall Display's WebView). One page per
// group; state and commands go through /panel/<id>/state and /panel/<id>/set.
function render({ id, name }) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>${escapeHtml(name)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
  html, body { height: 100%; overflow: hidden; }
  body {
    font-family: -apple-system, Roboto, "Segoe UI", sans-serif;
    background: radial-gradient(120% 120% at 50% -10%, #2a3140 0%, #151a24 55%, #0b0e14 100%);
    color: #e8ecf4; display: flex; flex-direction: column; align-items: center; justify-content: center;
    user-select: none; -webkit-user-select: none;
  }
  .wrap { display: flex; flex-direction: column; align-items: center; gap: 4.5vmin; width: 100%; max-width: 560px; padding: 4vmin; }
  @media (orientation: landscape) {
    .wrap { flex-direction: row; max-width: none; justify-content: center; gap: 8vmin; }
    .side { width: 44vw; max-width: 520px; }
  }
  h1 { font-size: 5vmin; font-weight: 600; letter-spacing: 0.02em; opacity: 0.92; text-align: center; }
  .sub { font-size: 2.6vmin; opacity: 0.45; margin-top: 0.8vmin; text-align: center; }

  .orb {
    width: 38vmin; height: 38vmin; border-radius: 50%;
    border: none; outline: none; cursor: pointer; position: relative;
    background: radial-gradient(circle at 35% 30%, #3a4256 0%, #232a38 60%, #1a202c 100%);
    box-shadow: inset 0 2px 10px rgba(255,255,255,0.06), 0 10px 40px rgba(0,0,0,0.55);
    transition: box-shadow 0.6s ease, background 0.6s ease; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
  }
  .orb svg { width: 34%; height: 34%; opacity: 0.55; transition: opacity 0.4s, filter 0.4s; }
  .orb.on svg { opacity: 1; filter: drop-shadow(0 0 12px rgba(255,255,255,0.7)); }
  .orb:active { transform: scale(0.97); }

  .side { display: flex; flex-direction: column; gap: 4.5vmin; width: 100%; }
  .ctl { width: 100%; display: flex; align-items: center; gap: 3vmin; }
  .ctl .ico { width: 6vmin; height: 6vmin; flex-shrink: 0; opacity: 0.7; }
  input[type=range] {
    -webkit-appearance: none; appearance: none; width: 100%; height: 6.5vmin; border-radius: 4vmin;
    background: #232a38; outline: none;
  }
  input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none; width: 9vmin; height: 9vmin; border-radius: 50%;
    background: #f4f6fa; border: 0.8vmin solid #10141c;
    box-shadow: 0 4px 14px rgba(0,0,0,0.5);
  }
  #bri { background: linear-gradient(to right, #232a38, #8f99ad); }
  #ct  { background: linear-gradient(to right, #ff9a3c, #ffd9a0, #ffffff, #cfe4ff, #9cc4ff); }
  .offline { position: fixed; top: 2vmin; right: 2.5vmin; font-size: 2.2vmin; color: #ff8f7a; opacity: 0; transition: opacity 0.4s; }
  .offline.show { opacity: 0.9; }
</style>
</head>
<body>
<div class="offline" id="offline">connection lost</div>
<div class="wrap">
  <button class="orb" id="orb" aria-label="toggle">
    <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round">
      <path d="M12 3v8"/><path d="M6.3 6.5a8 8 0 1 0 11.4 0"/>
    </svg>
  </button>
  <div class="side">
    <div class="ctl">
      <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="#8f99ad" stroke-width="2" stroke-linecap="round">
        <circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>
      </svg>
      <input type="range" id="bri" min="1" max="100" step="1" value="50">
    </div>
    <div class="ctl">
      <span class="ico"></span>
      <input type="range" id="ct" min="2200" max="6000" step="50" value="3150">
    </div>
  </div>
</div>
<script>
(function () {
  var id = ${JSON.stringify(id)};
  var st = { on: false, b: 50, ct: 3150 };
  var holdUntil = 0;
  var dragging = false;

  var orb = document.getElementById('orb');
  var bri = document.getElementById('bri');
  var ct = document.getElementById('ct');
  var offline = document.getElementById('offline');

  function glow() {
    if (!st.on) {
      orb.className = 'orb';
      orb.style.boxShadow = '';
      return;
    }
    var t = (st.ct - 2200) / 3800;
    var r = Math.round(255 - t * 100), g = Math.round(180 + t * 30), b = Math.round(110 + t * 145);
    var a = 0.25 + 0.55 * (st.b / 100);
    orb.className = 'orb on';
    orb.style.boxShadow = 'inset 0 2px 10px rgba(255,255,255,0.08), 0 0 ' + (30 + st.b) + 'px rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function paint() {
    if (!dragging) { bri.value = st.b; ct.value = st.ct; }
    glow();
  }
  function send(qs) {
    holdUntil = Date.now() + 4000;
    fetch('/panel/' + id + '/set?' + qs).catch(function () {});
  }

  orb.addEventListener('click', function () {
    st.on = !st.on;
    paint();
    send('on=' + st.on);
  });
  function slider(el, key, unit) {
    el.addEventListener('input', function () {
      dragging = true;
      st[key] = Number(el.value);
      if (key !== 'ct') st.on = true;
      paint();
      holdUntil = Date.now() + 4000;
    });
    el.addEventListener('change', function () {
      dragging = false;
      st[key] = Number(el.value);
      send(unit + '=' + el.value);
    });
  }
  slider(bri, 'b', 'b');
  slider(ct, 'ct', 'ct');

  function poll() {
    if (Date.now() < holdUntil) return;
    fetch('/panel/' + id + '/state').then(function (r) { return r.json(); }).then(function (s) {
      offline.className = 'offline';
      if (Date.now() < holdUntil) return;
      st = { on: !!s.on, b: s.b, ct: s.ct };
      paint();
    }).catch(function () { offline.className = 'offline show'; });
  }
  setInterval(poll, 2000);
  poll();
  paint();
})();
</script>
</body>
</html>`;
}

function renderIndex(groups) {
  const items = groups.map((g) => `<li><a href="/panel/${encodeURIComponent(g.id)}">${escapeHtml(g.name)}</a></li>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>HiluX panels</title>
<style>body{font-family:sans-serif;background:#151a24;color:#e8ecf4;padding:24px}a{color:#9cc4ff;font-size:22px;line-height:2}</style></head>
<body><h2>HiluX panels</h2><ul>${items}</ul></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { render, renderIndex };
