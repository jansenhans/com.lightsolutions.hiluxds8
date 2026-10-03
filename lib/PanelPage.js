'use strict';

const SAVER_CSS = `  .saver {
    position: fixed; inset: 0; z-index: 10; background: #000;
    display: flex; align-items: center; justify-content: center;
    opacity: 0; pointer-events: none; transition: opacity 1.2s ease;
  }
  .saver.show { opacity: 1; pointer-events: auto; }
  .saverin { display: flex; flex-direction: column; align-items: center; gap: 1.5vmin; transition: transform 2s ease; }
  .stime { font-size: min(36vw, 62vh); font-weight: 300; letter-spacing: 0.02em; font-variant-numeric: tabular-nums; line-height: 0.95; } /* as wide as the screen allows */
  .sdate { font-size: min(3.6vw, 6vh); opacity: 0.45; letter-spacing: 0.03em; }
  .swx { display: flex; align-items: center; gap: 2.5vmin; font-size: min(4vw, 6.5vh); opacity: 0.65; margin-top: 2vmin; font-variant-numeric: tabular-nums; }
  .swx svg { width: 1.2em; height: 1.2em; stroke: #8f99ad; }
`;

const SAVER_HTML = `<div class="saver" id="saver">
  <div class="saverin" id="saverin">
    <div class="stime" id="stime"></div>
    <div class="sdate" id="sdate"></div>
    <div class="swx" id="swx"></div>
  </div>
</div>
`;

// Weather icons (Open-Meteo WMO codes) for the in-page weather and saver
const WEATHER_JS = `  var W = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
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
`;

// Idle screensaver: needs activity(), saver elements, lastWx/icons/wxIcon
const SAVER_JS = `  // In-page screensaver: idle -> big centered clock; tap wakes back to the
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

  // When the screen turns off, the WebView is paused; it resumes the moment
  // the display's sensor wakes the screen. Treat that resume as activity so
  // a wake lands on the controls, not the screensaver: visibility events
  // where supported, plus a timer-gap detector as fallback.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) activity();
  });
  var lastTickAt = Date.now();
  setInterval(function () {
    var now = Date.now();
    if (now - lastTickAt > 5000) activity();
    lastTickAt = now;
  }, 1000);`;

// Displays keep a page open for weeks: reload when the app version changes
// so a new dashboard reaches every screen by itself
const VERSION_JS = `
  // Inside the Home Assistant Android app (Wall Display X2) the page must
  // report itself connected over the app's external bus, or the app shows
  // "unable to connect" and reloads after a few seconds. Messages the app
  // sends back to the frontend are accepted and ignored.
  window.externalBus = function () {};
  function haConnected() {
    try {
      if (window.externalApp && window.externalApp.externalBus) {
        window.externalApp.externalBus(JSON.stringify({ type: 'connection-status', payload: { event: 'connected' } }));
      }
    } catch (e) { /* not inside the HA app */ }
  }
  haConnected();
  setInterval(haConnected, 30000);
  var PAGE_VERSION = null;
  setInterval(function () {
    fetch('/panel/version').then(function (r) { return r.json(); }).then(function (v) {
      if (PAGE_VERSION === null) PAGE_VERSION = v.version;
      else if (v.version !== PAGE_VERSION) location.reload();
    }).catch(function () {});
  }, 60000);
`;

const ICON_GRID = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/></svg>';
const ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>';
const NAV_CSS = '.nav { position: fixed; top: 3vmin; left: 3vmin; z-index: 5; width: 9vmin; height: 9vmin; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #8f99ad; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); } .nav svg { width: 55%; height: 55%; } .nav:active { background: rgba(255,255,255,0.1); }';

// Self-contained touch dashboard served by the app's HTTP server for wall
// displays (rendered by the Shelly Wall Display's WebView). One page per
// group; state and commands go through /panel/<id>/state and /panel/<id>/set.
// Sliders are custom-built divs: native range inputs cannot be rotated
// vertically in the display's WebView (touch axis is not remapped).
function render({ id, name, back }) {
  const nav = back
    ? `<a class="nav" href="${escapeHtml(back)}" aria-label="back">${ICON_BACK}</a>`
    : `<a class="nav" href="/panel" aria-label="rooms">${ICON_GRID}</a>`;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>${escapeHtml(name)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; touch-action: none; }
  html, body { height: 100%; overflow: hidden; }
  html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; } /* no mobile font boosting */
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
  ${NAV_CSS}
  .offline { position: fixed; top: 2vmin; right: 2.5vmin; font-size: 2.2vmin; color: #ff8f7a; opacity: 0; transition: opacity 0.4s; }
  .offline.show { opacity: 0.9; }

${SAVER_CSS}</style>
</head>
<body>
<div class="offline" id="offline">connection lost</div>
${nav}
${SAVER_HTML}<div class="wrap">
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
${WEATHER_JS}  var lastWx = null;
  function weather() {
    fetch('/panel/weather').then(function (r) { return r.json(); }).then(function (w) {
      lastWx = w;
      wx.innerHTML = icons[wxIcon(w.code)] + '<span>' + Math.round(w.temp) + '°</span>';
      wxmm.textContent = Math.round(w.min) + '° / ' + Math.round(w.max) + '°';
    }).catch(function () {});
  }
  setInterval(weather, 900000);
  weather();

${SAVER_JS}
${VERSION_JS}

  // The display's occupancy sensor keeps the controls up while someone is
  // in the room and dismisses the screensaver when they walk in — no touch
  // needed. The saver only appears once the room has been still.
  setInterval(function () {
    fetch('/panel/' + id + '/presence').then(function (r) { return r.json(); }).then(function (p) {
      if (p.present) activity();
    }).catch(function () {});
  }, 2000);
})();
</script>
</body>
</html>`;
}

// Split room names into a shared caption and a short title, so a grid of
// "Living room front / middle / back" reads "LIVING ROOM" + "Front" etc.
function roomLabels(rooms) {
  return rooms.map((r) => {
    const name = r.name.trim();
    const first = name.split(/\s+/)[0].toLowerCase();
    const siblings = rooms.filter((o) => o.name.trim().split(/\s+/)[0].toLowerCase() === first);
    if (siblings.length < 2) return { ...r, caption: '', title: name };
    // Longest shared word prefix among siblings (case-insensitive)
    const words = siblings.map((o) => o.name.trim().split(/\s+/));
    let n = 0;
    while (words.every((w) => w.length > n + 1 && w[n].toLowerCase() === words[0][n].toLowerCase())) n++;
    const own = name.split(/\s+/);
    const rest = own.slice(n).join(' ');
    return { ...r, caption: own.slice(0, n).join(' '), title: rest.charAt(0).toUpperCase() + rest.slice(1) };
  });
}

// Multi-room dashboard for a large wall display: a grid of room tiles.
// Tap toggles a room, a vertical swipe on a tile sets its brightness, the
// chevron opens the full single-room view. State: /panel/area/<id>/state;
// commands go per room through /panel/<groupId>/set.
function renderArea({ id, name, rooms }) {
  const labelled = roomLabels(rooms);
  const tiles = labelled.map((r) => `
    <div class="tile" data-id="${escapeHtml(r.id)}">
      <div class="fill"></div>
      <div class="glowline"></div>
      <a class="open" href="/panel/${encodeURIComponent(r.id)}?back=${encodeURIComponent('/panel/area/' + id)}" aria-label="open">${ICON_CHEVRON}</a>
      <div class="cap">${escapeHtml(r.caption)}</div>
      <div class="title">${escapeHtml(r.title)}</div>
      <div class="val"><span class="pct"></span></div>
    </div>`).join('');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>${escapeHtml(name)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; touch-action: none; }
  html, body { height: 100%; overflow: hidden; }
  html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; } /* no mobile font boosting */
  body {
    font-family: -apple-system, Roboto, "Segoe UI", sans-serif;
    background: radial-gradient(130% 120% at 50% -20%, #2a3140 0%, #151a24 55%, #0b0e14 100%);
    color: #e8ecf4; user-select: none; -webkit-user-select: none;
    display: flex; flex-direction: column; padding: 4vmin 4.5vmin 4.5vmin;
  }
  ${NAV_CSS}
  .top { display: flex; align-items: flex-end; justify-content: space-between; padding: 0 0.5vmin 3.5vmin 12vmin; }
  .clock { font-size: 11vmin; font-weight: 300; letter-spacing: 0.03em; line-height: 0.9; font-variant-numeric: tabular-nums; }
  .date { font-size: 2.9vmin; opacity: 0.45; margin-top: 1.4vmin; letter-spacing: 0.04em; }
  .wxbox { text-align: right; }
  .wx { display: flex; align-items: center; justify-content: flex-end; gap: 1.8vmin; font-size: 6.5vmin; font-weight: 300; font-variant-numeric: tabular-nums; }
  .wx svg { width: 7vmin; height: 7vmin; stroke: #8f99ad; }
  .wxmm { font-size: 2.9vmin; opacity: 0.45; margin-top: 1vmin; font-variant-numeric: tabular-nums; }

  .grid { flex: 1; display: grid; gap: 2.4vmin; grid-template-columns: repeat(4, 1fr); grid-auto-rows: 1fr; }
  @media (max-aspect-ratio: 1/1) { .grid { grid-template-columns: repeat(2, 1fr); } }

  .tile {
    position: relative; overflow: hidden; border-radius: 3.2vmin; padding: 2.6vmin 2.8vmin;
    background: linear-gradient(160deg, rgba(255,255,255,0.055), rgba(255,255,255,0.015));
    border: 1px solid rgba(255,255,255,0.06);
    box-shadow: 0 1.2vmin 3vmin rgba(0,0,0,0.35);
    display: flex; flex-direction: column; justify-content: flex-end;
    transition: box-shadow 0.6s ease, border-color 0.6s ease, transform 0.12s ease;
  }
  .tile:active { transform: scale(0.985); }
  .tile .fill {
    position: absolute; left: 0; right: 0; bottom: 0; height: 0;
    background: linear-gradient(to top, var(--glow, rgba(255,200,140,0.0)), transparent);
    opacity: 0; transition: height 0.5s ease, opacity 0.6s ease;
  }
  .tile .glowline { position: absolute; left: 12%; right: 12%; top: 0; height: 2px; border-radius: 2px; background: var(--line, transparent); opacity: 0; transition: opacity 0.6s; }
  .tile.on .fill { opacity: 1; }
  .tile.on .glowline { opacity: 0.9; }
  .tile.on { border-color: rgba(255,255,255,0.12); }
  .tile.drag .fill { transition: none; }
  .cap { position: relative; font-size: 2.2vmin; letter-spacing: 0.14em; text-transform: uppercase; opacity: 0.42; min-height: 2.6vmin; }
  .title { position: relative; font-size: 4.4vmin; font-weight: 500; margin-top: 0.6vmin; line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .val { position: relative; margin-top: 1.6vmin; font-size: 3.4vmin; font-weight: 300; opacity: 0.5; font-variant-numeric: tabular-nums; }
  .tile.on .val { opacity: 0.95; }
  .tile.drag .val { opacity: 1; }
  .open {
    position: absolute; top: 1.8vmin; right: 1.8vmin; width: 7vmin; height: 7vmin; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; color: rgba(232,236,244,0.45);
  }
  .open svg { width: 50%; height: 50%; }
  .open:active { background: rgba(255,255,255,0.08); }

  .master .pwr { position: absolute; top: 2.2vmin; right: 2.2vmin; width: 5.5vmin; height: 5.5vmin; opacity: 0.45; }
  .master.on .pwr { opacity: 0.9; }
  .master .hint { position: relative; margin-top: 0.8vmin; font-size: 2vmin; opacity: 0.32; letter-spacing: 0.02em; }
  .tile.drag .val { font-size: 6vmin; font-weight: 200; margin-top: 0.4vmin; }

  .offline { position: fixed; top: 2vmin; right: 2.5vmin; font-size: 2.2vmin; color: #ff8f7a; opacity: 0; transition: opacity 0.4s; }
  .offline.show { opacity: 0.9; }
${SAVER_CSS}
</style>
</head>
<body>
<div class="offline" id="offline">connection lost</div>
<a class="nav" href="/panel" aria-label="rooms">${ICON_GRID}</a>
${SAVER_HTML}
<div class="top">
  <div><div class="clock" id="clock"></div><div class="date" id="date"></div></div>
  <div class="wxbox"><div class="wx" id="wx"></div><div class="wxmm" id="wxmm"></div></div>
</div>
<div class="grid" id="grid">
  ${tiles}
  <div class="tile master" id="master">
    <div class="fill"></div>
    <div class="glowline"></div>
    <svg class="pwr" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"><path d="M12 3v8"/><path d="M6.3 6.5a8 8 0 1 0 11.4 0"/></svg>
    <div class="cap">All rooms</div>
    <div class="title">Together</div>
    <div class="val"><span class="pct"></span></div>
    <div class="hint">tap: all off · swipe: dim / colour</div>
  </div>
</div>
<script>
(function () {
  var AREA = ${JSON.stringify(id)};
  var state = {};          // room id -> { on, b, ct }
  var holdUntil = {};      // room id -> ms; ignore polls while a command settles
  var offline = document.getElementById('offline');
  var tiles = Array.prototype.slice.call(document.querySelectorAll('.tile[data-id]'));

  function rgbFor(ct) {
    var t = Math.max(0, Math.min(1, (ct - 2200) / 3800));
    return [Math.round(255 - t * 100), Math.round(180 + t * 30), Math.round(110 + t * 145)];
  }
  function look(tile, on, b, ct, text) {
    var c = rgbFor(ct);
    var a = 0.18 + 0.5 * (b / 100);
    tile.classList.toggle('on', on);
    tile.classList.toggle('drag', !!tile.dragging);
    tile.style.setProperty('--glow', 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')');
    tile.style.setProperty('--line', 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')');
    tile.style.boxShadow = on
      ? '0 0 ' + (3 + b / 12) + 'vmin rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (0.12 + 0.28 * b / 100) + '), 0 1.2vmin 3vmin rgba(0,0,0,0.35)'
      : '';
    tile.querySelector('.fill').style.height = on ? Math.max(14, b) + '%' : '0';
    tile.querySelector('.pct').textContent = text;
  }
  function paint(tile) {
    var s = state[tile.dataset.id];
    if (!s) return;
    var text = tile.dragging === 'ct' ? s.ct + ' K' : (s.on ? s.b + '%' : 'Off');
    look(tile, s.on, s.b, s.ct, text);
    paintMaster();
  }
  function onRooms() {
    return tiles.filter(function (t) { var s = state[t.dataset.id]; return s && s.on; });
  }
  function avg(list, key) {
    if (!list.length) return null;
    return Math.round(list.reduce(function (n, t) { return n + state[t.dataset.id][key]; }, 0) / list.length);
  }
  var master = document.getElementById('master');
  var masterView = null; // { b, ct, axis } while the master tile is being swiped
  function paintMaster() {
    var on = onRooms();
    var b = masterView ? masterView.b : (avg(on, 'b') || 0);
    var ct = masterView ? masterView.ct : (avg(on, 'ct') || 3150);
    var text = masterView
      ? (masterView.axis === 'ct' ? ct + ' K' : b + '%')
      : (on.length ? on.length + (on.length === 1 ? ' room on' : ' rooms on') : 'All off');
    look(master, on.length > 0, b, ct, text);
  }
  function send(rid, qs) {
    holdUntil[rid] = Date.now() + 4000;
    fetch('/panel/' + encodeURIComponent(rid) + '/set?' + qs).catch(function () {});
  }
  function clampB(v) { return Math.max(1, Math.min(100, Math.round(v))); }
  function clampCt(v) { return Math.max(2200, Math.min(6000, Math.round(v / 50) * 50)); }

  // One gesture model for every tile: a tap, or a swipe whose dominant axis
  // decides — vertical = brightness (up brighter), horizontal = colour
  // temperature (right cooler). The chevron link keeps its own taps.
  function gestures(el, h) {
    var x0 = 0, y0 = 0, axis = null, active = false;
    function pt(e) { var t = e.touches && e.touches.length ? e.touches[0] : e; return [t.clientX, t.clientY]; }
    function start(e) {
      if (e.target.closest && e.target.closest('.open')) return;
      var p = pt(e); x0 = p[0]; y0 = p[1]; axis = null; active = true;
      h.start(); e.preventDefault();
    }
    function move(e) {
      if (!active) return;
      var p = pt(e), dx = p[0] - x0, dy = y0 - p[1];
      if (!axis) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 14) return;
        axis = Math.abs(dy) >= Math.abs(dx) ? 'b' : 'ct';
        el.dragging = axis;
      }
      if (axis === 'b') h.brightness(dy / el.clientHeight * 130);
      else h.colour(dx / el.clientWidth * 3800); // one tile width = warm to cool
      e.preventDefault();
    }
    function end() {
      if (!active) return;
      active = false;
      var a = axis; el.dragging = false;
      if (a) h.commit(a); else h.tap();
    }
    el.addEventListener('touchstart', start, { passive: false });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', function () { active = false; el.dragging = false; });
    el.addEventListener('mousedown', function (e) {
      start(e);
      var mm = function (ev) { move(ev); };
      var mu = function () { end(); window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', mu); };
      window.addEventListener('mousemove', mm); window.addEventListener('mouseup', mu);
    });
  }

  tiles.forEach(function (tile) {
    var rid = tile.dataset.id, s0 = null;
    function st() { return state[rid] || (state[rid] = { on: false, b: 50, ct: 3150 }); }
    gestures(tile, {
      start: function () { var s = st(); s0 = { b: s.on ? s.b : 0, ct: s.ct }; },
      brightness: function (d) { var s = st(); s.b = clampB(s0.b + d); s.on = true; holdUntil[rid] = Date.now() + 4000; paint(tile); },
      colour: function (d) { var s = st(); s.ct = clampCt(s0.ct + d); holdUntil[rid] = Date.now() + 4000; paint(tile); },
      commit: function (axis) { var s = st(); send(rid, axis === 'b' ? 'b=' + s.b : 'ct=' + s.ct); paint(tile); },
      tap: function () { var s = st(); s.on = !s.on; paint(tile); send(rid, 'on=' + s.on); },
    });
  });

  // Master tile: acts on the rooms that are on when its gesture starts
  var targets = [], m0 = null;
  gestures(master, {
    start: function () {
      targets = onRooms();
      m0 = { b: avg(targets, 'b') || 50, ct: avg(targets, 'ct') || 3150 };
    },
    brightness: function (d) {
      if (!targets.length) return;
      var b = clampB(m0.b + d);
      masterView = { b: b, ct: m0.ct, axis: 'b' };
      targets.forEach(function (t) { var s = state[t.dataset.id]; s.b = b; holdUntil[t.dataset.id] = Date.now() + 4000; paint(t); });
    },
    colour: function (d) {
      if (!targets.length) return;
      var ct = clampCt(m0.ct + d);
      masterView = { b: m0.b, ct: ct, axis: 'ct' };
      targets.forEach(function (t) { var s = state[t.dataset.id]; s.ct = ct; holdUntil[t.dataset.id] = Date.now() + 4000; paint(t); });
    },
    commit: function (axis) {
      targets.forEach(function (t) {
        var s = state[t.dataset.id];
        send(t.dataset.id, axis === 'b' ? 'b=' + s.b : 'ct=' + s.ct);
      });
      masterView = null; paintMaster();
    },
    tap: function () {
      onRooms().forEach(function (t) { state[t.dataset.id].on = false; paint(t); send(t.dataset.id, 'on=false'); });
      paintMaster();
    },
  });
  paintMaster();

  function poll() {
    fetch('/panel/area/' + encodeURIComponent(AREA) + '/state').then(function (r) { return r.json(); }).then(function (rooms) {
      offline.className = 'offline';
      rooms.forEach(function (s) {
        if (Date.now() < (holdUntil[s.id] || 0)) return;
        var tile = tiles.filter(function (t) { return t.dataset.id === s.id; })[0];
        if (!tile || tile.dragging) return;
        state[s.id] = { on: !!s.on, b: s.b, ct: s.ct };
        paint(tile);
      });
    }).catch(function () { offline.className = 'offline show'; });
  }
  setInterval(poll, 2000);
  poll();

  // Clock in the top bar
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function clock() {
    var now = new Date();
    document.getElementById('clock').textContent = two(now.getHours()) + ':' + two(now.getMinutes());
    document.getElementById('date').textContent = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  setInterval(clock, 1000);
  clock();

${WEATHER_JS}
  var wx = document.getElementById('wx');
  var wxmm = document.getElementById('wxmm');
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

${SAVER_JS}
${VERSION_JS}

  setInterval(function () {
    fetch('/panel/area/' + encodeURIComponent(AREA) + '/presence').then(function (r) { return r.json(); }).then(function (p) {
      if (p.present) activity();
    }).catch(function () {});
  }, 2000);
})();
</script>
</body>
</html>`;
}

const ICON_CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>';

// Room picker: every area and room, each with "show on this screen" (the
// choice is remembered per screen) and a plain preview link
function renderIndex(groups, areas = []) {
  const row = (label, view, target, kind) => `
    <div class="row"><a class="name" href="${view}"><span class="kind">${kind}</span>${escapeHtml(label)}</a>
    <a class="use" href="/panel/use?target=${encodeURIComponent(target)}">Show on this screen</a></div>`;
  const areaRows = areas.map((a) => row(a.name, `/panel/area/${encodeURIComponent(a.id)}`, `area:${a.id}`, 'Area')).join('');
  const groupRows = groups.slice().sort((x, y) => x.name.localeCompare(y.name))
    .map((g) => row(g.name, `/panel/${encodeURIComponent(g.id)}`, `group:${g.id}`, 'Room')).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>HiluX panels</title>
<style>
  html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
  body { font-family: -apple-system, Roboto, "Segoe UI", sans-serif; margin: 0; padding: 5vmin; color: #e8ecf4;
    background: radial-gradient(130% 120% at 50% -20%, #2a3140 0%, #151a24 55%, #0b0e14 100%); min-height: 100vh; box-sizing: border-box; }
  h1 { font-weight: 200; font-size: 6vmin; margin: 0 0 3vmin; letter-spacing: 0.02em; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 3vmin; padding: 2.2vmin 2.6vmin; margin-bottom: 1.6vmin;
    border-radius: 2.4vmin; background: linear-gradient(160deg, rgba(255,255,255,0.055), rgba(255,255,255,0.015)); border: 1px solid rgba(255,255,255,0.06); }
  .name { color: #e8ecf4; text-decoration: none; font-size: 3.6vmin; }
  .kind { display: inline-block; min-width: 9vmin; font-size: 2vmin; letter-spacing: 0.14em; text-transform: uppercase; opacity: 0.4; }
  .use { color: #9cc4ff; text-decoration: none; font-size: 2.6vmin; padding: 1.2vmin 2vmin; border-radius: 99px; border: 1px solid rgba(156,196,255,0.3); white-space: nowrap; }
  .use:active { background: rgba(156,196,255,0.12); }
  .reset { display: inline-block; margin-top: 3vmin; color: #8f99ad; font-size: 2.4vmin; }
</style></head>
<body><h1>Choose what this screen shows</h1>${areaRows}${groupRows}
<a class="reset" href="/panel/use">Reset this screen to automatic</a></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { render, renderArea, renderIndex };
