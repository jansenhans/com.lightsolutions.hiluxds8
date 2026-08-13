'use strict';

// Self-contained touch dashboard served by the app's HTTP server for wall
// displays (rendered by the Shelly Wall Display's WebView). One page per
// group; state and commands go through /panel/<id>/state and /panel/<id>/set.
// Sliders are custom-built divs: native range inputs cannot be rotated
// vertically in the display's WebView (touch axis is not remapped).
function render({ id, name }) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>${escapeHtml(name)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; touch-action: none; }
  html, body { height: 100%; overflow: hidden; }
  body {
    font-family: -apple-system, Roboto, "Segoe UI", sans-serif;
    background: radial-gradient(120% 120% at 50% -10%, #2a3140 0%, #151a24 55%, #0b0e14 100%);
    color: #e8ecf4; display: flex; align-items: center; justify-content: center;
    user-select: none; -webkit-user-select: none;
  }
  .wrap { display: flex; flex-direction: row; align-items: center; justify-content: center; gap: 11vmin; width: 100%; padding: 4vmin; }
  .vwrap { display: flex; flex-direction: column; align-items: center; gap: 3vmin; }
  .ico { width: 7vmin; height: 7vmin; opacity: 0.7; }

  .orb {
    width: 40vmin; height: 40vmin; border-radius: 50%;
    border: none; outline: none; cursor: pointer;
    background: radial-gradient(circle at 35% 30%, #3a4256 0%, #232a38 60%, #1a202c 100%);
    box-shadow: inset 0 2px 10px rgba(255,255,255,0.06), 0 10px 40px rgba(0,0,0,0.55);
    transition: box-shadow 0.6s ease; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
  }
  .orb svg { width: 34%; height: 34%; opacity: 0.55; transition: opacity 0.4s, filter 0.4s; }
  .orb.on svg { opacity: 1; filter: drop-shadow(0 0 12px rgba(255,255,255,0.7)); }
  .orb:active { transform: scale(0.97); }

  .vtrack {
    width: 13vmin; height: 62vmin; border-radius: 6.5vmin; position: relative; cursor: pointer;
    background: linear-gradient(to top, #1c222e, #3f4964);
    box-shadow: inset 0 3px 12px rgba(0,0,0,0.5);
  }
  #ct.vtrack { background: linear-gradient(to top, #ff9a3c, #ffd9a0, #ffffff, #cfe4ff, #9cc4ff); }
  .thumb {
    position: absolute; left: 50%; transform: translateX(-50%); bottom: 0;
    width: 16vmin; height: 16vmin; border-radius: 50%;
    background: #f4f6fa; border: 1.1vmin solid #10141c;
    box-shadow: 0 4px 16px rgba(0,0,0,0.55);
  }
  .dot { border-radius: 50%; background: linear-gradient(to top, #ff9a3c, #ffffff, #9cc4ff); }
  .wx { display: flex; align-items: center; gap: 2.5vmin; font-size: 8vmin; font-weight: 600; opacity: 0.9; min-height: 10vmin; font-variant-numeric: tabular-nums; }
  .wx svg { width: 9vmin; height: 9vmin; stroke: #8f99ad; }
  .wxmm { font-size: 3.4vmin; opacity: 0.45; min-height: 4vmin; font-variant-numeric: tabular-nums; }
  .offline { position: fixed; top: 2vmin; right: 2.5vmin; font-size: 2.2vmin; color: #ff8f7a; opacity: 0; transition: opacity 0.4s; }
  .offline.show { opacity: 0.9; }

  .saver {
    position: fixed; inset: 0; z-index: 10; background: #000;
    display: flex; align-items: center; justify-content: center;
    opacity: 0; pointer-events: none; transition: opacity 1.2s ease;
  }
  .saver.show { opacity: 1; pointer-events: auto; }
  .saverin { display: flex; flex-direction: column; align-items: center; gap: 1.5vmin; transition: transform 2s ease; }
  .stime { font-size: 34vmin; font-weight: 200; letter-spacing: 0.04em; font-variant-numeric: tabular-nums; line-height: 1; }
  .sdate { font-size: 5vmin; opacity: 0.45; }
  .swx { display: flex; align-items: center; gap: 2.5vmin; font-size: 5.5vmin; opacity: 0.65; margin-top: 3vmin; font-variant-numeric: tabular-nums; }
  .swx svg { width: 6.5vmin; height: 6.5vmin; stroke: #8f99ad; }
</style>
</head>
<body>
<div class="offline" id="offline">connection lost</div>
<div class="saver" id="saver">
  <div class="saverin" id="saverin">
    <div class="stime" id="stime"></div>
    <div class="sdate" id="sdate"></div>
    <div class="swx" id="swx"></div>
  </div>
</div>
<div class="wrap">
  <div class="vwrap">
    <div class="vtrack" id="bri"><div class="thumb"></div></div>
    <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="#8f99ad" stroke-width="2" stroke-linecap="round">
      <circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>
    </svg>
  </div>
  <div class="vwrap">
    <button class="orb" id="orb" aria-label="toggle">
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round">
        <path d="M12 3v8"/><path d="M6.3 6.5a8 8 0 1 0 11.4 0"/>
      </svg>
    </button>
    <div class="wx" id="wx"></div>
    <div class="wxmm" id="wxmm"></div>
  </div>
  <div class="vwrap">
    <div class="vtrack" id="ct"><div class="thumb"></div></div>
    <span class="ico dot"></span>
  </div>
</div>
<script>
(function () {
  var id = ${JSON.stringify(id)};
  var st = { on: false, b: 50, ct: 3150 };
  var holdUntil = 0;
  var dragging = false;

  var orb = document.getElementById('orb');
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

  // Custom vertical slider: bottom = min, top = max
  function vslider(el, min, max, step, onInput, onChange) {
    var thumb = el.querySelector('.thumb');
    var val = min;
    function place(v) {
      val = v;
      var h = el.clientHeight - thumb.offsetHeight;
      var f = (v - min) / (max - min);
      thumb.style.bottom = Math.round(f * h) + 'px';
    }
    function fromEvent(e) {
      var rect = el.getBoundingClientRect();
      var y = (e.touches && e.touches.length ? e.touches[0].clientY : e.clientY);
      var th = thumb.offsetHeight;
      var f = 1 - (y - rect.top - th / 2) / (rect.height - th);
      f = Math.max(0, Math.min(1, f));
      var v = min + f * (max - min);
      return Math.round(v / step) * step;
    }
    var active = false;
    function start(e) { active = true; place(fromEvent(e)); onInput(val); e.preventDefault(); }
    function move(e) { if (active) { place(fromEvent(e)); onInput(val); e.preventDefault(); } }
    function end() { if (active) { active = false; onChange(val); } }
    el.addEventListener('touchstart', start, { passive: false });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    el.addEventListener('mousedown', function (e) {
      start(e);
      var mm = function (ev) { move(ev); };
      var mu = function () { end(); window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', mu); };
      window.addEventListener('mousemove', mm);
      window.addEventListener('mouseup', mu);
    });
    return { set: place };
  }

  function send(qs) {
    holdUntil = Date.now() + 4000;
    fetch('/panel/' + id + '/set?' + qs).catch(function () {});
  }
  function paint() {
    if (!dragging) { briS.set(st.b); ctS.set(st.ct); }
    glow();
  }

  var briS = vslider(document.getElementById('bri'), 1, 100, 1,
    function (v) { dragging = true; holdUntil = Date.now() + 4000; st.b = v; st.on = true; glow(); },
    function (v) { dragging = false; st.b = v; send('b=' + v); });
  var ctS = vslider(document.getElementById('ct'), 2200, 6000, 50,
    function (v) { dragging = true; holdUntil = Date.now() + 4000; st.ct = v; glow(); },
    function (v) { dragging = false; st.ct = v; send('ct=' + v); });

  orb.addEventListener('click', function () {
    st.on = !st.on;
    paint();
    send('on=' + st.on);
  });

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

  // Weather under the orb, refreshed every 15 min
  var wx = document.getElementById('wx');
  var wxmm = document.getElementById('wxmm');
  var W = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
  var CLOUD = '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a4 4 0 0 0 0-8z"/>';
  var RAINCLOUD = '<path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"/>';
  var icons = {
    sun: W + '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>',
    cloudsun: W + '<circle cx="6.5" cy="6" r="2.4"/><path d="M6.5 1.5V3M1.5 6H3M3 2.5l1 1M10 2.5l-1 1"/>' + CLOUD + '</svg>',
    cloud: W + CLOUD + '</svg>',
    fog: W + RAINCLOUD + '<path d="M6 19h12M8 22h8"/></svg>',
    rain: W + RAINCLOUD + '<path d="M8 19v2M12 18v3M16 19v2"/></svg>',
    snow: W + RAINCLOUD + '<path d="M8 18.5h.01M12 20h.01M16 18.5h.01M10 21.5h.01M14 21.5h.01"/></svg>',
    storm: W + RAINCLOUD + '<polyline points="13 12 9 18 15 18 11 24"/></svg>',
  };
  function wxIcon(c) {
    if (c === 0) return 'sun';
    if (c <= 2) return 'cloudsun';
    if (c === 3) return 'cloud';
    if (c === 45 || c === 48) return 'fog';
    if (c >= 95) return 'storm';
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
    if (c >= 51) return 'rain';
    return 'cloud';
  }
  var lastWx = null;
  function weather() {
    fetch('/panel/weather').then(function (r) { return r.json(); }).then(function (w) {
      lastWx = w;
      wx.innerHTML = icons[wxIcon(w.code)] + '<span>' + Math.round(w.temp) + '°</span>';
      wxmm.textContent = Math.round(w.min) + '° / ' + Math.round(w.max) + '°';
    }).catch(function () {});
  }
  setInterval(weather, 900000);
  weather();

  // In-page screensaver: idle -> big centered clock; tap wakes back to the
  // controls without reaching them. Content drifts a little each minute.
  var IDLE_MS = 20000;
  var saver = document.getElementById('saver');
  var saverin = document.getElementById('saverin');
  var stime = document.getElementById('stime');
  var sdate = document.getElementById('sdate');
  var swx = document.getElementById('swx');
  var lastActivity = Date.now();
  var saverOn = false;

  function activity() {
    lastActivity = Date.now();
    if (saverOn) { saverOn = false; saver.className = 'saver'; }
  }
  ['touchstart', 'mousedown', 'touchmove'].forEach(function (ev) {
    window.addEventListener(ev, activity, { capture: true, passive: true });
  });
  saver.addEventListener('touchstart', function (e) { e.stopPropagation(); e.preventDefault(); activity(); }, { capture: false });
  saver.addEventListener('mousedown', function (e) { e.stopPropagation(); e.preventDefault(); activity(); });

  function two(n) { return (n < 10 ? '0' : '') + n; }
  function tickSaver() {
    var now = new Date();
    if (!saverOn && Date.now() - lastActivity > IDLE_MS) {
      saverOn = true;
      saver.className = 'saver show';
    }
    if (!saverOn) return;
    stime.textContent = two(now.getHours()) + ':' + two(now.getMinutes());
    sdate.textContent = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    if (lastWx) swx.innerHTML = icons[wxIcon(lastWx.code)] + '<span>' + Math.round(lastWx.temp) + '°</span><span style="opacity:0.55;font-size:70%">' + Math.round(lastWx.min) + '° / ' + Math.round(lastWx.max) + '°</span>';
    var m = now.getMinutes();
    saverin.style.transform = 'translate(' + ((m % 7) - 3) + 'vmin,' + ((m % 5) - 2) + 'vmin)';
  }
  setInterval(tickSaver, 1000);

  // The display's occupancy sensor keeps the controls up while someone is
  // in the room and dismisses the screensaver when they walk in — no touch
  // needed. The saver only appears once the room has been still.
  setInterval(function () {
    fetch('/panel/' + id + '/presence').then(function (r) { return r.json(); }).then(function (p) {
      if (p.present) activity();
    }).catch(function () {});
  }, 3000);
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
