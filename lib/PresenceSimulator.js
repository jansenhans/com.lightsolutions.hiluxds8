'use strict';

// Presence simulation ("someone is home"): drives the room groups along a
// believable daily routine instead of random on/off noise. Each simulated day
// (05:00 → 05:00) gets a fresh plan built from the room types (derived from
// group/zone names), today's sunrise/sunset and the weekday: a dark-morning
// routine, dinner in kitchen + dining room, a living-room evening with short
// trips to hall, bathroom and pantry, kids' rooms in the evening, a staggered
// bedtime through hall → bathroom → bedroom, and now and then a night-time
// bathroom visit. Every time, room choice and level is jittered per day, so
// no two evenings look alike. Lights only come on while it is dark.

const DAY_START_MIN = 5 * 60; // a simulated day runs 05:00 → 05:00
const DUSK_LEAD_MIN = 35; // indoor lights go on this long before sunset
const DAWN_LAG_MIN = 20; // ...and are still needed this long after sunrise
const PLAN_SETTING = 'presence_plan';
const ENABLED_SETTING = 'presence_enabled';

const ROLES = [
  ['bathroom', /bath|toilet|wc\b/],
  ['pantry', /pantry|storage|wardrobe|dressing/],
  ['bedroom', /bedroom|sleep/],
  ['kitchen', /kitchen/],
  ['dining', /dining/],
  ['living', /living|lounge|sitting/],
  ['hall', /hall|entrance|corridor|stair|landing/],
];

// Typical level per room type: [brightness % min, max, colour temperature K]
const LOOK = {
  living: [45, 75, 2700],
  dining: [50, 70, 2700],
  kitchen: [75, 100, 3500],
  hall: [35, 60, 3000],
  bathroom: [70, 90, 3500],
  bedroom: [30, 55, 2700],
  pantry: [70, 90, 3500],
};

const rnd = (a, b) => a + Math.random() * (b - a);
const irnd = (a, b) => Math.round(rnd(a, b));
const chance = (p) => Math.random() < p;
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const shuffle = (list) => list.map((v) => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);

function roleOf(text) {
  const t = text.toLowerCase();
  for (const [role, re] of ROLES) if (re.test(t)) return role;
  return null;
}

// Sunrise/sunset (sunrise equation, -0.83° for refraction + solar disc)
// for the given UTC calendar day, as epoch ms
function sunTimes(y, m, d, lat, lon) {
  const rad = Math.PI / 180;
  const sin = (deg) => Math.sin(deg * rad);
  const jd = Date.UTC(y, m - 1, d, 12) / 86400000 + 2440587.5;
  const n = Math.round(jd - 2451545.0 + 0.0008);
  const jStar = n - lon / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * sin(M) + 0.02 * sin(2 * M) + 0.0003 * sin(3 * M);
  const L = (M + C + 180 + 102.9372) % 360;
  const jTransit = 2451545.0 + jStar + 0.0053 * sin(M) - 0.0069 * sin(2 * L);
  const decl = Math.asin(sin(L) * sin(23.44)) / rad;
  const cosH = (sin(-0.83) - sin(lat) * sin(decl)) / (Math.cos(lat * rad) * Math.cos(decl * rad));
  const H = Math.acos(Math.min(1, Math.max(-1, cosH))) / rad;
  const toMs = (j) => (j - 2440587.5) * 86400000;
  return { rise: toMs(jTransit - H / 360), set: toMs(jTransit + H / 360) };
}

class PresenceSimulator {
  constructor(app) {
    this.app = app;
    this.homey = app.homey;
    this._timer = null;
    this._events = [];
    this._on = new Set(); // group ids this simulation currently has on
    this._active = false;
  }

  get running() {
    return this.homey.settings.get(ENABLED_SETTING) === true;
  }

  // Resume after an app restart if it was left running
  init() {
    return this.sync();
  }

  start() {
    this.homey.settings.set(ENABLED_SETTING, true);
    return this.sync();
  }

  stop() {
    this.homey.settings.set(ENABLED_SETTING, false);
    return this.sync();
  }

  // Follow the stored flag (Flow cards, settings page toggle, app start);
  // serialised so overlapping triggers never plan or stop twice
  sync() {
    this._chain = (this._chain || Promise.resolve())
      .then(() => this._sync())
      .catch((err) => this.app.error('Presence simulation:', err.message));
    return this._chain;
  }

  async _sync() {
    // The Presence simulation switch device (Apple Home, tiles) follows the flag
    try {
      for (const d of this.homey.drivers.getDriver('hilux-presence').getDevices()) await d.reflect(this.running);
    } catch (err) { /* driver not ready yet */ }
    if (this.running && !this._active) {
      this._active = true;
      await this._startDay(true);
    } else if (!this.running && this._active) {
      this._active = false;
      await this._shutdown();
    }
  }

  async _shutdown() {
    this._clearTimer();
    this._events = [];
    this.homey.settings.set(PLAN_SETTING, null);
    // Switch off what the simulation itself switched on; anything else is
    // someone's deliberate choice and stays as it is
    const groups = this._groupDevices();
    await Promise.all([...this._on].map((id) => {
      const g = groups.find((d) => d.getData().id === id);
      return g ? g.applyPresence({ on: false }).catch((err) => this.app.error(err.message)) : null;
    }));
    this._on.clear();
    this.app.log('Presence simulation stopped');
  }

  _clearTimer() {
    if (this._timer) this.homey.clearTimeout(this._timer);
    this._timer = null;
  }

  _groupDevices() {
    try {
      return this.homey.drivers.getDriver('hilux-group').getDevices();
    } catch (err) {
      return [];
    }
  }

  // Groups taking part: a recognisable room type and not opted out
  _rooms() {
    return this._groupDevices()
      .filter((g) => g.getSetting('presence_include') !== false)
      .map((g) => ({
        id: g.getData().id,
        name: g.getName(),
        role: roleOf(`${g.getName()} ${g.getSetting('zones_label') || ''}`),
      }))
      .filter((r) => r.role);
  }

  // --- local time helpers (Homey's timezone, DST-safe) ---

  _offsetMs(at) {
    const tz = this.homey.clock.getTimezone();
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(new Date(at)).map((p) => [p.type, Number(p.value)]));
    const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return wall - Math.floor(at / 1000) * 1000;
  }

  // { y, m, d, weekday, min } of an instant in local time
  _local(at) {
    const shifted = new Date(at + this._offsetMs(at));
    return {
      y: shifted.getUTCFullYear(),
      m: shifted.getUTCMonth() + 1,
      d: shifted.getUTCDate(),
      weekday: shifted.getUTCDay(),
      min: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    };
  }

  // Minutes after local midnight of day (y, m, d) → epoch ms (may run past 24:00)
  _at(day, min) {
    const guess = Date.UTC(day.y, day.m - 1, day.d, 0, 0) + Math.round(min * 60000);
    return guess - this._offsetMs(guess - this._offsetMs(guess));
  }

  // --- planning ---

  async _startDay(announce = false) {
    this._clearTimer();
    const now = Date.now();
    const loc = this._local(now);
    // Before 05:00 still belongs to yesterday's simulated day
    const dayAt = loc.min < DAY_START_MIN ? now - 86400000 : now;
    const day = this._local(dayAt);
    this._events = this._plan(day);
    this._publishPlan(day);

    // Joining mid-day: bring rooms that should be on right now up to date
    const current = new Map();
    for (const e of this._events) if (e.at <= now) current.set(e.id, e);
    this._events = this._events.filter((e) => e.at > now);
    for (const e of current.values()) if (e.params.on) await this._apply(e);

    if (announce) this.app.log(`Presence simulation started: ${this._events.length} events planned`);
    this._scheduleNext(this._at(day, DAY_START_MIN + 1440));
  }

  _scheduleNext(dayEnd) {
    this._clearTimer();
    if (!this.running) return;
    const next = this._events.length ? this._events[0].at : dayEnd;
    this._timer = this.homey.setTimeout(async () => {
      this._timer = null;
      if (!this.running) return;
      if (!this._events.length) {
        await this._startDay().catch((err) => this.app.error('Presence replan failed:', err.message));
        return;
      }
      const due = [];
      while (this._events.length && this._events[0].at <= Date.now() + 1000) due.push(this._events.shift());
      for (const e of due) await this._apply(e);
      this._scheduleNext(dayEnd);
    }, Math.max(1000, next - Date.now()));
  }

  async _apply(e) {
    const g = this._groupDevices().find((d) => d.getData().id === e.id);
    if (!g) return;
    try {
      await g.applyPresence(e.params);
      if (e.params.on) this._on.add(e.id);
      else this._on.delete(e.id);
      this.app.log(`Presence: ${e.name} ${e.params.on ? `on ${e.params.brightness}% ${e.params.ct}K` : 'off'}`);
    } catch (err) {
      this.app.error(`Presence: ${e.name} failed:`, err.message);
    }
  }

  _publishPlan(day) {
    const fmt = (at) => {
      const l = this._local(at);
      return `${String(Math.floor(l.min / 60)).padStart(2, '0')}:${String(l.min % 60).padStart(2, '0')}`;
    };
    this.homey.settings.set(PLAN_SETTING, {
      day: `${day.y}-${String(day.m).padStart(2, '0')}-${String(day.d).padStart(2, '0')}`,
      events: this._events.map((e) => ({
        time: fmt(e.at),
        room: e.name,
        action: e.params.on ? `on ${e.params.brightness}%` : 'off',
      })),
    });
  }

  // Build one simulated day as timed group events (sorted)
  _plan(day) {
    const rooms = this._rooms();
    const by = (role) => rooms.filter((r) => r.role === role);
    let lat = 50.9;
    let lon = 4.5;
    try {
      lat = this.homey.geolocation.getLatitude();
      lon = this.homey.geolocation.getLongitude();
    } catch (e) { /* defaults */ }
    const sun = sunTimes(day.y, day.m, day.d, lat, lon);
    const midnight = this._at(day, 0);
    const sunrise = (sun.rise - midnight) / 60000;
    const sunset = (sun.set - midnight) / 60000;
    const darkFrom = sunset - DUSK_LEAD_MIN;
    const darkUntil = sunrise + DAWN_LAG_MIN;
    const weekend = day.weekday === 0 || day.weekday === 6;
    const lateNight = day.weekday === 5 || day.weekday === 6; // Fri/Sat evening

    const spans = []; // { room, start, end, brightness, ct } in local minutes
    const look = (room, scale = 1) => {
      const [lo, hi, ct] = LOOK[room.role];
      return { brightness: Math.max(5, Math.round(rnd(lo, hi) * scale)), ct: ct + irnd(-2, 2) * 100 };
    };
    // Only while it is dark: morning spans end at dawn, evening ones start at dusk
    const add = (room, start, dur, lvl = look(room)) => {
      if (!room) return;
      let s = start;
      let e = start + dur;
      if (s < 12 * 60) e = Math.min(e, darkUntil);
      else if (s < 24 * 60) s = Math.max(s, darkFrom);
      if (e - s >= 1) spans.push({ room, start: s, end: e, ...lvl });
    };
    const masterBed = by('bedroom').find((r) => /master/i.test(r.name)) || by('bedroom')[0];
    const otherBeds = by('bedroom').filter((r) => r !== masterBed);
    const dressing = by('pantry').filter((r) => /bed/i.test(r.name));
    const pantries = by('pantry').filter((r) => !dressing.includes(r));
    const bathroom = () => pick(by('bathroom'));

    // Morning routine (only shows on dark mornings)
    const wake = weekend ? rnd(7 * 60 + 45, 9 * 60) : rnd(6 * 60 + 25, 7 * 60 + 15);
    if (chance(weekend ? 0.7 : 0.9)) {
      add(masterBed, wake, rnd(4, 12), look(masterBed, 0.6));
      add(pick(by('bathroom')), wake + rnd(3, 7), rnd(12, 22));
      add(pick(dressing), wake + rnd(15, 25), rnd(3, 8));
      for (const h of by('hall')) add(h, wake + rnd(22, 30), rnd(2, 4));
      const breakfast = wake + rnd(28, 38);
      for (const k of by('kitchen')) add(k, breakfast, rnd(18, 35));
      if (weekend && chance(0.6)) for (const d of by('dining')) add(d, breakfast + 5, rnd(25, 45));
    }

    // Bedtime: Fri/Sat later, and one evening in ten an early night
    let bedtime = lateNight ? rnd(23 * 60 + 10, 24 * 60 + 30) : rnd(22 * 60 + 15, 23 * 60 + 30);
    if (chance(0.1)) bedtime = rnd(21 * 60 + 30, 22 * 60 + 15);

    // Dinner: prep in the kitchen, eat in the dining room, short clean-up
    const prep = (weekend ? rnd(18 * 60, 19 * 60) : rnd(17 * 60 + 30, 18 * 60 + 40));
    const prepDur = rnd(30, 70);
    const kitchens = by('kitchen');
    for (const k of kitchens) add(k, prep + rnd(0, 6), prepDur);
    const dinner = prep + prepDur - rnd(0, 8);
    const dinnerDur = rnd(25, 55);
    for (const d of by('dining')) add(d, dinner, dinnerDur);
    add(pick(kitchens), dinner + dinnerDur + rnd(0, 5), rnd(8, 20));

    // Living room: lights come on as it gets dark, not all parts every day,
    // dimmed a little later for the TV, off just before bed
    const living = by('living');
    const usedLiving = living.filter(() => chance(0.75));
    if (living.length && !usedLiving.length) usedLiving.push(pick(living));
    const tvAt = rnd(20 * 60 + 30, 21 * 60 + 30);
    for (const r of usedLiving) {
      const on = Math.min(Math.max(sunset + rnd(-20, 25), 16 * 60) + rnd(0, 30), bedtime - 30);
      const off = bedtime - rnd(0, 12);
      const first = look(r);
      if (tvAt > on + 15 && tvAt < off - 15 && chance(0.6)) {
        add(r, on, tvAt - on, first);
        add(r, tvAt, off - tvAt, { ...first, step: true, brightness: Math.max(15, Math.round(first.brightness * rnd(0.5, 0.7))) });
      } else {
        add(r, on, off - on, first);
      }
    }

    // Short trips during the evening: tea, toilet, pantry, hallway
    const evStart = Math.max(darkFrom, dinner + dinnerDur);
    const trip = (pool, n, durLo, durHi) => {
      for (let i = 0; i < n; i++) add(pick(pool), rnd(evStart, bedtime - 20), rnd(durLo, durHi));
    };
    if (kitchens.length) trip(kitchens, irnd(0, 2), 3, 9);
    if (by('bathroom').length) trip(by('bathroom'), irnd(1, 3), 3, 9);
    if (pantries.length) trip(pantries, irnd(0, 2), 1, 4);
    if (by('hall').length) trip(by('hall'), irnd(1, 3), 1, 3);

    // Kids' rooms: an evening session some days, and their own earlier bedtime
    for (const r of otherBeds) {
      if (chance(0.55)) {
        const s = rnd(19 * 60 + 15, 21 * 60);
        add(r, s, rnd(30, 90), look(r, 1.2));
      }
      const own = Math.min(bedtime - rnd(20, 60), rnd(21 * 60 + 30, 22 * 60 + 40) + (lateNight ? 45 : 0));
      add(r, own, rnd(8, 25), look(r, 0.7));
    }

    // Going to bed: hall, bathroom, dressing, bedroom, lights out
    for (const h of by('hall')) add(h, bedtime - rnd(0, 2), rnd(3, 7));
    add(bathroom(), bedtime + rnd(2, 5), rnd(7, 16));
    add(pick(dressing), bedtime + rnd(8, 14), rnd(3, 7));
    add(masterBed, bedtime + rnd(4, 10), rnd(15, 40));

    // Now and then a night-time bathroom visit, dim and warm
    if (chance(0.35)) {
      add(bathroom(), rnd(25 * 60 + 30, 28 * 60 + 30), rnd(3, 7), { brightness: irnd(8, 15), ct: 2200 });
    }

    return this._toEvents(spans, day);
  }

  // Per room: merge overlapping or touching spans (a step span — the TV
  // dim — is kept as a level change), then on at each start and off at
  // each end unless a step picks up right there
  _toEvents(spans, day) {
    const events = [];
    const byRoom = new Map();
    for (const s of spans) {
      if (!byRoom.has(s.room.id)) byRoom.set(s.room.id, []);
      byRoom.get(s.room.id).push(s);
    }
    for (const list of byRoom.values()) {
      list.sort((a, b) => a.start - b.start);
      const merged = [];
      for (const s of list) {
        const last = merged[merged.length - 1];
        if (last && (s.step ? s.start < last.end - 0.5 : s.start <= last.end + 0.5)) last.end = Math.max(last.end, s.end);
        else merged.push({ ...s });
      }
      merged.forEach((s, i) => {
        const next = merged[i + 1];
        const room = s.room;
        events.push({ at: this._at(day, s.start), id: room.id, name: room.name, params: { on: true, brightness: s.brightness, ct: s.ct } });
        if (!next || next.start - s.end > 0.5) {
          events.push({ at: this._at(day, s.end), id: room.id, name: room.name, params: { on: false } });
        }
      });
    }
    return events.sort((a, b) => a.at - b.at);
  }
}

module.exports = PresenceSimulator;
