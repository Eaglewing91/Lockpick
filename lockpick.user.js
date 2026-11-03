// ==UserScript==
// @name         Lockpick: Jail Bust HUD
// @namespace    eaglewing.torn.lockpick
// @version      1.4.9
// @description  A heads-up display for busting in Torn: odds on every prisoner, a heat gauge for your bust penalty, a bail cap, and one-press "Best Bust" / "Best Bail" buttons that stay within Torn's 1 click = 1 request rule.
// @author       Eaglewing
// @match        https://www.torn.com/*
// @run-at       document-end
// @license      MIT
// @homepageURL  https://github.com/Eaglewing91/Lockpick
// @supportURL   https://github.com/Eaglewing91/Lockpick/issues
// @downloadURL  https://raw.githubusercontent.com/Eaglewing91/Lockpick/main/lockpick.user.js
// @updateURL    https://raw.githubusercontent.com/Eaglewing91/Lockpick/main/lockpick.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

/*
 * Heat (bust penalty) curve constants adapted from BUSTR by Adobi, Ironhydedragon and
 * The_Baron, used under the MIT licence. The odds model, interface and everything else are
 * original to Lockpick.
 *
 * COMPLIANCE
 * - Torn API (api.torn.com) only, throttled: bust log every 60s while the jail page is
 *   open; level and perks once a day. Nothing is fetched on other pages.
 * - One other request to torn.com, and only when you press Refresh: one press = one request
 *   for the jail list you are viewing (the same request the jail page makes when you change
 *   page), so the list updates without reloading. A real click only, never automatic, never
 *   repeated, and at most one per second.
 * - Skip-confirm switches rewrite the link YOU clicked to Torn's no-confirm variant at the
 *   moment of the click. Your click is still the one and only request.
 * - "Best Bust" / "Best Bail": one press = one .click() on the real bust or bail link of the
 *   chosen row (best odds / cheapest within your bail cap) on the page you are viewing.
 *   Torn's own handler sends the request. No loops, timers or queues.
 * - Bail cap: a bail click over your cap is stopped before Torn sees it. It can only ever
 *   prevent a request, never create one.
 * - If the jail list isn't on the page, Refresh does one normal page reload instead. If the
 *   request fails, it says so in the HUD and sends nothing else.
 * - Page reading is limited to the jail page you have open (and the Jail link in the menu).
 * - No external servers, no WebSockets. All data stays on this device.
 *
 * Works in Tampermonkey/Violentmonkey and Torn PDA (PDA's API key is used automatically
 * unless you save your own in settings).
 */

(() => {
  'use strict';
  if (window.__lockpickHud) return;
  window.__lockpickHud = true;

  const VERSION = '1.4.9';

  // ---------------------------------------------------------------------------
  // Model constants
  // ---------------------------------------------------------------------------
  const M = {
    SLOPE: 2.77,       // how sharply odds fall as difficulty rises (log scale)
    D50: 2500,         // perk-adjusted difficulty at which odds are 50% with no heat
    HEAT_COEF: 2.0,    // heat 100% shifts odds by 2 logit units
    PEN_ANCHOR: 1037,  // heat added per bust = 1037 / your level (%)
    DECAY_C: 0.1, WINDOW_H: 72, // heat halves at 10h, gone after 72h
  };
  const MODEL_V = 2;   // outcomes logged under the difficulty model; older ones aren't used for learning

  const LOG_BUST = 5360;
  const API_SELECTIONS = 'basic,log,perks';
  // "?" after #tab=api is intentional - Torn splits the fragment on it.
  const KEY_URL = 'https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=Lockpick&user=' + API_SELECTIONS;

  const JAIL_POLL_MS = 60 * 1000;
  const LOAD_MIN_GAP_MS = 35 * 1000;
  const RESYNC_AFTER_BUST_MS = 40 * 1000;
  const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;
  const TICK_MS = 15 * 1000;
  const OUTCOME_MAX = 1000;
  const PENDING_TIMEOUT_MS = 15 * 1000;
  const PRIOR = 8;
  const FATAL_KEY_CODES = [2, 10, 13, 16, 18];

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------
  const PDA_KEY = '###PDA-APIKEY###';
  const isPDA = !/^###.+###$/.test(PDA_KEY);
  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function' && !isPDA;

  const store = {
    get(k, d) {
      try {
        const raw = hasGM ? GM_getValue(k) : localStorage.getItem(k);
        if (raw == null) return d;
        try { return JSON.parse(raw); } catch (e) { return typeof raw === 'string' ? raw : d; }   // also accepts a key saved as plain text (e.g. by TUCC)
      } catch (e) { return d; }
    },
    set(k, v) {
      try { const s = JSON.stringify(v); hasGM ? GM_setValue(k, s) : localStorage.setItem(k, s); } catch (e) { /* quota */ }
    },
    del(k) {
      try { hasGM ? GM_deleteValue(k) : localStorage.removeItem(k); } catch (e) { /* ignore */ }
    },
  };

  const KEYS = { settings: 'lockpick_settings', cache: 'lockpick_cache', outcomes: 'lockpick_outcomes', key: 'lockpick_key' };

  const DEFAULTS = {
    heatLimit: 50,       // heat (penalty %) you're willing to carry
    greenAt: 60,
    redBelow: 40,
    dimBelow: 0,
    sortByOdds: true,
    showDifficulty: false,
    quickBust: false,
    quickBail: false,
    bestButton: true,
    bailButton: true,
    badge: 'everywhere', // everywhere | jail | off
    learning: true,
    bonusOverride: null,
    maxBail: 0,              // $ cap for bails, 0 = no cap
    bailDiscountOverride: null, // % off bail, blank = learned/perks
    dockCollapsed: false,
  };

  let S = Object.assign({}, DEFAULTS, store.get(KEYS.settings, {}));
  delete S.calOverride; delete S.showHardness; // settings from the old skill model
  let C = Object.assign({ ts: [], level: null, perks: [], lastLogFetch: 0, lastProfileFetch: 0, err: null, perksV: 0, bailMult: null }, store.get(KEYS.cache, {}));
  let O = store.get(KEYS.outcomes, null);
  if (!Array.isArray(O)) O = store.get('bustrR_outcomes', []); // carry over history from the interim build
  if (!Array.isArray(O)) O = [];
  if (!Array.isArray(C.ts)) C.ts = [];

  const dirty = new Set();
  let saveTimer = null;
  function save(which) {
    dirty.add(which);
    if (!saveTimer) saveTimer = setTimeout(flush, 400);
  }
  function flush() {
    saveTimer = null;
    if (dirty.has('s')) store.set(KEYS.settings, S);
    if (dirty.has('c')) store.set(KEYS.cache, C);
    if (dirty.has('o')) store.set(KEYS.outcomes, O);
    dirty.clear();
  }
  window.addEventListener('pagehide', flush);

  const cleanKey = (k) => (typeof k === 'string' ? k.replace(/[^A-Za-z0-9]/g, '') : '');
  function apiKey() {
    const saved = cleanKey(store.get(KEYS.key, ''));
    if (saved.length === 16) return saved;
    const pda = isPDA ? cleanKey(PDA_KEY) : '';
    return pda.length === 16 ? pda : null;
  }
  function keySource() {
    if (cleanKey(store.get(KEYS.key, '')).length === 16) return 'saved';
    if (isPDA && cleanKey(PDA_KEY).length === 16) return 'pda';
    return 'none';
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const logit = (p) => Math.log(p / (1 - p));
  const sig = (x) => 1 / (1 + Math.exp(-x));
  const normText = (n) => (n && n.textContent ? n.textContent.replace(/\s+/g, ' ').trim() : '');
  const onJail = () => location.pathname === '/jailview.php';
  const nowSec = () => Date.now() / 1000;
  const fmtDur = (s) => {
    if (s <= 0) return 'Cool';
    const h = Math.floor(s / 3600), m = Math.ceil((s % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m`;
  };
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const setText = (node, t) => { if (node && node.textContent !== t) node.textContent = t; };

  // ---------------------------------------------------------------------------
  // Icons (original line icons, stroke = currentColor)
  // ---------------------------------------------------------------------------
  const svg = (body, size = 16) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICON = {
    keyhole: svg('<circle cx="12" cy="9" r="4"/><path d="M10.6 12.6 9 20h6l-1.6-7.4"/>', 18),
    key: svg('<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2"/><path d="m16 7 3 3"/><path d="m14 9 2 2"/>', 18),
    sliders: svg('<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>'),
    reload: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
    minus: svg('<path d="M6 12h12"/>'),
    expand: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    check: svg('<path d="m5 12 5 5 9-10"/>', 14),
    cross: svg('<path d="M6 6l12 12M18 6 6 18"/>', 14),
    coin: svg('<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 1.7 3 2 3 .8 3 2-1.3 2-3 2c-1.4 0-2.6-.5-3-1.5M12 6.5v11"/>', 18),
    lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 14),
  };

  // Heat ring. scale = how much heat fills the ring; the tick marks your heat limit.
  function ringSvg(size, stroke) {
    const r = (size - stroke) / 2, cx = size / 2, c = 2 * Math.PI * r;
    return `<svg class="lp-ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" data-c="${c}" data-cx="${cx}" aria-hidden="true">
      <circle class="lp-ring-track" cx="${cx}" cy="${cx}" r="${r}" stroke-width="${stroke}" fill="none"/>
      <circle class="lp-ring-arc" cx="${cx}" cy="${cx}" r="${r}" stroke-width="${stroke}" fill="none"
        stroke-dasharray="${c} ${c}" stroke-dashoffset="${c}" stroke-linecap="round" transform="rotate(-90 ${cx} ${cx})"/>
      <line class="lp-ring-tick" x1="${cx}" y1="${stroke * 0.1}" x2="${cx}" y2="${stroke * 1.9}" stroke-width="2"/>
    </svg>`;
  }
  function heatLevel(heat) { return heat <= S.heatLimit * 0.5 ? 'good' : heat <= S.heatLimit ? 'mid' : 'bad'; }
  function setRing(ringEl, heat) {
    if (!ringEl) return;
    const scale = Math.max(100, S.heatLimit * 1.6);
    const c = +ringEl.dataset.c, cx = +ringEl.dataset.cx;
    const arc = ringEl.querySelector('.lp-ring-arc');
    const tick = ringEl.querySelector('.lp-ring-tick');
    const off = String(c * (1 - clamp(heat / scale, 0, 1)));
    if (arc.getAttribute('stroke-dashoffset') !== off) arc.setAttribute('stroke-dashoffset', off);
    tick.setAttribute('transform', `rotate(${clamp(S.heatLimit / scale, 0, 1) * 360} ${cx} ${cx})`);
    const lv = heatLevel(heat);
    for (const l of ['good', 'mid', 'bad']) ringEl.classList.toggle(`lp-lv-${l}`, l === lv);
  }

  // ---------------------------------------------------------------------------
  // Model
  // ---------------------------------------------------------------------------
  // Difficulty = target level x minutes left in jail - the unit Torn itself uses (bail costs
  // $100 x level x minutes, so difficulty = bail / 100). Community testing puts the comfortable
  // ceiling for a fully perked buster near 3,600, with failures piling up past 6,000-10,000.
  //
  // Odds = sigmoid(SLOPE * (ln D50 - ln(D / (1 + bonus))) - HEAT_COEF * heat), where bonus is
  // your busting bonus from perks ("X% easier" scales difficulty down). Anchors: full perks
  // (+115%), no heat -> ~70% at 3,600 and ~20% at 8,000. Torn's real formula is not public, so
  // this is a prior that personal learning re-fits to your own results.
  function level() { return C.level || 100; }
  const hasOverride = () => typeof S.bonusOverride === 'number' && S.bonusOverride >= 0;

  function perkBonus(perks) {
    let bonus = 0;
    for (const p of perks || []) {
      if (!/bust/i.test(p) || /nerve/i.test(p)) continue;
      if (/harder to bust|resist|defen[cs]e|less likely|reduce/i.test(p)) continue;
      if (/bust success|busting skill|bust skill|easier to bust|busting/i.test(p)) {
        const m = p.match(/([\d.]+)\s*%/);
        if (m) bonus += parseFloat(m[1]);
      }
    }
    return Math.min(bonus, 200);
  }
  function bustBonus() { return hasOverride() ? S.bonusOverride : perkBonus(C.perks); }
  function perBust() { return M.PEN_ANCHOR / level(); }

  function heatAt(t) {
    const p0 = perBust();
    let s = 0;
    for (const ts of C.ts) {
      const h = Math.max(0, (t - ts) / 3600);
      if (h > M.WINDOW_H) continue;
      s += p0 / (1 + M.DECAY_C * h);
    }
    return s;
  }
  function coolsIn() {
    const t0 = nowSec();
    if (heatAt(t0) <= S.heatLimit) return 0;
    let lo = 0, hi = M.WINDOW_H * 3600;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (heatAt(t0 + mid) > S.heatLimit) lo = mid; else hi = mid;
    }
    return hi;
  }
  const picksLeft = (heat) => Math.max(0, Math.floor((S.heatLimit - heat) / perBust()));
  const difficulty = (lvl, minutes) => Math.max(1, Math.round(lvl * minutes));
  const fmtNum = (n) => Math.round(n).toLocaleString('en-GB');
  const fmtShort = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
  const fmtPct = (p) => (p < 1 ? '<1%' : p > 99 ? '>99%' : `${Math.round(p)}%`);

  // Bail price: Torn charges $100 x level x minutes, minus your discounts (education up to
  // 57.25%, Law Firm special 50%). Discount source, in order: your manual override, the ratio
  // read from Torn's own confirm price the last time you bailed with confirmation on, then
  // bail perks from the API (each "X% cheaper" compounds).
  function perkBailMult() {
    let m = 1;
    for (const p of C.perks || []) {
      if (!/bail/i.test(p) || !/cheaper|reduc|discount|less|lower|cost/i.test(p)) continue;
      const x = p.match(/([\d.]+)\s*%/);
      if (x) m *= 1 - clamp(parseFloat(x[1]), 0, 95) / 100;
    }
    return m;
  }
  function bailMult() {
    if (typeof S.bailDiscountOverride === 'number' && S.bailDiscountOverride >= 0) return 1 - clamp(S.bailDiscountOverride, 0, 95) / 100;
    if (typeof C.bailMult === 'number' && C.bailMult > 0 && C.bailMult <= 1) return C.bailMult;
    return perkBailMult();
  }
  function bailSource() {
    if (typeof S.bailDiscountOverride === 'number' && S.bailDiscountOverride >= 0) return 'your override';
    if (typeof C.bailMult === 'number' && C.bailMult > 0 && C.bailMult <= 1) return "Torn's confirm price";
    return 'your perks';
  }
  // Torn shows time rounded down but charges every started minute, so the charged price is
  // $100 x level x (shown minutes + 1), minus your discount.
  const bailBase = (lvl, minutes) => 100 * lvl * (minutes + 1);
  const bailCost = (lvl, minutes) => Math.round(bailBase(lvl, minutes) * bailMult());
  const fmtMoney = (n) => '$' + fmtNum(n);
  const fmtMoneyShort = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}m` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${n}`);
  function parseMoney(v) {
    const m = String(v).trim().toLowerCase().replace(/[$,\s]/g, '').match(/^(\d+(?:\.\d+)?)([km]?)$/);
    if (!m) return null;
    return Math.round(parseFloat(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1));
  }
  const overCap = (cost) => S.maxBail > 0 && cost > S.maxBail;

  function baseOdds(d, heat) {
    const eff = d / (1 + bustBonus() / 100);
    const x = M.SLOPE * (Math.log(M.D50) - Math.log(eff)) - M.HEAT_COEF * Math.min(heat, 150) / 100;
    return clamp(100 * sig(x), 0.1, 99.9);
  }

  // Personal learning: p = sigmoid(a + b*logit(p0)), regularised toward a=0, b=1.
  const L = { a: 0, b: 1, n: 0 };
  const usable = () => O.filter((o) => o && o.m === MODEL_V && typeof o.p0 === 'number');
  const lx = (p) => logit(clamp(p / 100, 0.001, 0.999));
  function fitLearning() {
    const data = usable();
    L.n = data.length; L.a = 0; L.b = 1;
    if (!S.learning || !data.length) return;
    let a = 0, b = 1;
    for (let it = 0; it < 25; it++) {
      let ga = PRIOR * a, gb = PRIOR * (b - 1), haa = PRIOR, hab = 0, hbb = PRIOR;
      for (const o of data) {
        const x = lx(o.p0);
        const p = sig(a + b * x);
        const r = p - (o.ok ? 1 : 0), w = p * (1 - p);
        ga += r; gb += r * x; haa += w; hab += w * x; hbb += w * x * x;
      }
      const det = haa * hbb - hab * hab;
      if (det <= 1e-9) break;
      const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
      a = clamp(a - da, -3, 3); b = clamp(b - db, 0.3, 3);
      if (Math.abs(da) + Math.abs(db) < 1e-6) break;
    }
    L.a = a; L.b = b;
  }
  function odds(d, heat) {
    const p0 = baseOdds(d, heat);
    if (!S.learning || !L.n) return { p0, p: p0 };
    return { p0, p: clamp(100 * sig(L.a + L.b * lx(p0)), 0.1, 99.9) };
  }
  // Hardest difficulty you've actually busted. Targets far beyond it are flagged as untested
  // because no model, Torn's or ours, has evidence for you out there.
  function hardestBust() {
    const wins = usable().filter((o) => o.ok && typeof o.d === 'number');
    return wins.length >= 10 ? Math.max(...wins.map((o) => o.d)) : null;
  }
  function accuracy() {
    const recent = usable().slice(-100).filter((o) => typeof o.p === 'number');
    if (!recent.length) return null;
    return {
      n: recent.length,
      pred: Math.round(recent.reduce((s, o) => s + o.p, 0) / recent.length),
      act: Math.round(100 * recent.filter((o) => o.ok).length / recent.length),
      jailed: recent.filter((o) => o.jailed).length,
    };
  }

  // ---------------------------------------------------------------------------
  // Torn API
  // ---------------------------------------------------------------------------
  let fetching = false, keyDead = false, resyncTimer = null;

  async function api(selections, extra) {
    const key = apiKey();
    if (!key) throw Object.assign(new Error('No API key set'), { code: 0 });
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await fetch(`https://api.torn.com/user/?selections=${selections}${extra || ''}&key=${key}&comment=Lockpick`,
        { signal: ctl.signal, cache: 'no-store' });
      const d = await r.json();
      if (d.error) throw Object.assign(new Error(d.error.error), { code: d.error.code });
      return d;
    } finally { clearTimeout(to); }
  }

  function extractPerks(d) {
    const out = [];
    for (const k of Object.keys(d)) {
      if (!/_perks$/.test(k) || !Array.isArray(d[k])) continue;
      for (const p of d[k]) if (typeof p === 'string' && /bust|bail/i.test(p)) out.push(p);
    }
    return out;
  }

  async function sync({ minGap = JAIL_POLL_MS, forceProfile = false } = {}) {
    if (fetching || keyDead || !apiKey()) return;
    const now = Date.now();
    const needProfile = forceProfile || !C.level || C.perksV !== 2 || now - C.lastProfileFetch > PROFILE_TTL_MS;
    if (!needProfile && now - C.lastLogFetch < minGap) return;
    fetching = true;
    try {
      // Profile and bust log are separate requests: combining them can return a reply
      // without the log, which must never be read as "no busts".
      if (needProfile) {
        const p = await api('basic,perks');
        if (p.level) C.level = p.level;
        C.perks = extractPerks(p);
        C.perksV = 2;
        C.lastProfileFetch = now;
      }
      const d = await api('log', `&log=${LOG_BUST}`);
      // A reply with no log field means "unknown", so keep the current heat instead of wiping it.
      // (An account with no busts returns an empty log, which is handled normally below.)
      if (!d || !('log' in d)) throw new Error('Torn returned no bust log; heat kept as it was');
      const t = now / 1000;
      const apiTs = Object.values(d.log || {})
        .map((e) => e && e.timestamp)
        .filter((x) => typeof x === 'number' && t - x <= M.WINDOW_H * 3600);
      const newest = apiTs.length ? Math.max(...apiTs) : 0;
      const localOnly = C.ts.filter((x) => x > newest + 5 && t - x < 120);
      C.ts = apiTs.concat(localOnly).sort((a, b) => b - a);
      C.lastLogFetch = now;
      C.err = null;
    } catch (e) {
      C.err = { msg: e.name === 'AbortError' ? 'Request timed out' : (e.message || String(e)), code: e.code ?? null };
      if (FATAL_KEY_CODES.includes(e.code)) keyDead = true;
    } finally {
      fetching = false;
      save('c');
      render();
      refreshDrawer();
    }
  }
  function scheduleResync() {
    clearTimeout(resyncTimer);
    resyncTimer = setTimeout(() => sync({ minGap: 0 }), RESYNC_AFTER_BUST_MS);
  }

  // ---------------------------------------------------------------------------
  // Jail rows: tumbler meter on each prisoner
  // ---------------------------------------------------------------------------
  function parseRow(li) {
    const lv = li.querySelector('.level'), tm = li.querySelector('.time');
    if (!lv || !tm) return null;
    const lvl = +((lv.textContent.match(/\d+/) || [])[0] || 0);
    if (!lvl) return null;
    const t = tm.textContent;
    const num = (re) => +((t.match(re) || [0, 0])[1]);
    const minutes = num(/(\d+)\s*d/) * 1440 + num(/(\d+)\s*h/) * 60 + num(/(\d+)\s*m/);
    const nameEl = li.querySelector('a.user.name');
    const name = nameEl ? (normText(nameEl) || nameEl.getAttribute('title') || '').split('[')[0].trim() : '';
    return { lvl, minutes, bust: li.querySelector('a[href*="step=breakout"]'), name };
  }
  const oddsBand = (pr) => (pr >= S.greenAt ? 'good' : pr < S.redBelow ? 'bad' : 'mid');

  let bestRow = null;
  let bailRow = null;

  function renderRows(heat) {
    const list = document.querySelector('ul.user-info-list-wrap');
    if (!list) { bestRow = null; bailRow = null; return; }
    let best = null, cheapest = null;
    const record = hardestBust();
    for (const li of list.children) {
      if (li.tagName !== 'LI') continue;
      const r = parseRow(li);
      if (!r) continue;
      const d = difficulty(r.lvl, r.minutes);
      const { p0, p } = odds(d, heat);
      const untested = record != null && d > record * 2;
      const bail = bailCost(r.lvl, r.minutes);
      li._lp = { d, p0, p, name: r.name, lvl: r.lvl, minutes: r.minutes, bail };
      const bailLink = li.querySelector('a[href*="step=buy"]');
      if (bailLink) {
        const over = overCap(bail);
        bailLink.classList.toggle('lp-bail-over', over);
        bailLink.classList.toggle('lp-bail-ok', S.maxBail > 0 && !over);
        bailLink.title = `Bail: ${fmtMoney(bail)}` + (S.maxBail > 0 ? (over ? ` - over your ${fmtMoneyShort(S.maxBail)} cap, Lockpick will block it` : ` - within your ${fmtMoneyShort(S.maxBail)} cap`) : '');
      }

      let meter = li.querySelector('.lp-meter');
      if (!meter) {
        meter = el('span', 'lp-meter', '<span class="lp-pins"><i></i><i></i><i></i><i></i><i></i></span><b></b>');
        const host = li.querySelector('.reason') || li.querySelector('.info-wrap') || li;
        host.insertBefore(meter, host.firstChild);
      }
      setText(meter.querySelector('b'), (S.showDifficulty ? `${fmtPct(p)} · ${fmtShort(d)}` : fmtPct(p)) + (untested ? ' ?' : ''));
      const lit = p < 1 ? 0 : Math.max(1, Math.round(p / 20));
      meter.querySelectorAll('.lp-pins i').forEach((pin, i) => pin.classList.toggle('on', i < lit));
      const band = oddsBand(p);
      for (const b of ['good', 'mid', 'bad']) meter.classList.toggle(`lp-m-${b}`, b === band);
      meter.classList.toggle('lp-untested', untested);
      meter.title = `Odds: ${fmtPct(p)}\nDifficulty: ${fmtNum(d)} (level ${r.lvl} x ${fmtNum(r.minutes)} min)\nBail: ${fmtMoney(bail)}${overCap(bail) ? ' (over your cap)' : ''}`
        + (untested ? `\nAbout ${Math.round(d / record)}x harder than anything you've busted (${fmtNum(record)}). Treat these odds as a guess.` : '');

      li.classList.toggle('lp-dim', S.dimBelow > 0 && p < S.dimBelow);
      const order = S.sortByOdds ? String(Math.round(1000 - p * 10)) : '';
      if (li.style.order !== order) li.style.order = order;
      if (r.bust && (!best || p > best._lp.p)) best = li;
      if (bailLink && !overCap(bail) && (!cheapest || bail < cheapest._lp.bail)) cheapest = li;
    }
    list.classList.toggle('lp-sorted', !!S.sortByOdds);
    for (const li of list.children) li.classList.toggle('lp-best', li === best);
    bestRow = best;
    bailRow = cheapest;
  }

  // ---------------------------------------------------------------------------
  // HUD: an inline panel inside the jail page, directly above the prisoner list
  // ---------------------------------------------------------------------------
  let hud = null;

  function buildHud() {
    hud = el('div', 'lp-hud lp-ui', `
      <div class="lp-bar">
        <div class="lp-brand">${ICON.keyhole}<b>Lockpick</b></div>
        <div class="lp-gauge">${ringSvg(58, 6)}
          <div class="lp-gauge-val"><b data-k="heat">-</b><small>heat</small></div>
        </div>
        <dl class="lp-stats">
          <div><dt>Picks left</dt><dd data-k="picks">-</dd></div>
          <div><dt>Cools in</dt><dd data-k="cool">-</dd></div>
          <div><dt>Per bust</dt><dd data-k="per">-</dd></div>
        </dl>
        <div class="lp-actions">
          <button type="button" class="lp-go" data-act="best">
            <span class="lp-go-main">${ICON.key}<span>Best Bust</span><b data-k="bestodds"></b></span>
            <span class="lp-go-sub" data-k="bestname">Looking for targets...</span>
          </button>
          <button type="button" class="lp-refresh" data-act="reload" aria-label="Refresh the jail list">Refresh</button>
          <button type="button" class="lp-go lp-go-bail" data-act="bail">
            <span class="lp-go-main">${ICON.coin}<span>Best Bail</span><b data-k="bailcost"></b></span>
            <span class="lp-go-sub" data-k="bailname">Looking for bails...</span>
          </button>
        </div>
        <div class="lp-switches">
          <label class="lp-sw" title="Your bust clicks skip Torn's 'Are you sure?' step. You still click every bust yourself.">
            <input type="checkbox" data-q="quickBust"><i></i><span>Skip bust confirm</span></label>
          <label class="lp-sw" title="Your bail clicks skip Torn's confirmation step.">
            <input type="checkbox" data-q="quickBail"><i></i><span>Skip bail confirm<em class="lp-cap" data-k="cap"></em></span></label>
        </div>
        <div class="lp-tools">
          <button type="button" class="lp-ib" data-act="settings" title="Settings" aria-label="Settings">${ICON.sliders}</button>
          <button type="button" class="lp-ib" data-act="collapse" title="Compact view" aria-label="Compact view">${ICON.minus}</button>
        </div>
      </div>
      <div class="lp-mini">
        <span class="lp-brand">${ICON.keyhole}</span>
        <span class="lp-mini-ring">${ringSvg(18, 3)}</span>
        <span class="lp-mini-text" data-k="mini">-</span>
        <button type="button" class="lp-go-mini" data-act="best" data-k="minibest">Best Bust</button>
        <button type="button" class="lp-go-mini lp-go-mini-bail" data-act="bail" data-k="minibail">Best Bail</button>
        <span class="lp-tools">
          <button type="button" class="lp-ib" data-act="settings" title="Settings" aria-label="Settings">${ICON.sliders}</button>
          <button type="button" class="lp-ib" data-act="expand" title="Full view" aria-label="Full view">${ICON.expand}</button>
        </span>
      </div>
      <div class="lp-feed" data-k="feed">
        <div class="lp-alert" data-k="alert" hidden>
          <span data-k="alerttext"></span>
          <button type="button" class="lp-link" data-act="fixkey">Set up</button>
        </div>
      </div>
      <div class="lp-settings" data-k="settings" hidden></div>`);

    hud.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'expand' || act === 'collapse') { S.dockCollapsed = act === 'collapse'; save('s'); render(); }
      else if (act === 'settings') toggleDrawer();
      else if (act === 'fixkey') openDrawer('key');
      else if (act === 'reload') { if (e.isTrusted) refreshList(b); }
      // Real clicks only, so one press = one click on Torn's own link.
      else if (act === 'best') { if (e.isTrusted) pickBest(b, 'bust'); }
      else if (act === 'bail') { if (e.isTrusted) pickBest(b, 'bail'); }
    });
    hud.addEventListener('change', (e) => {
      const k = e.target.dataset.q;
      if (!k) return;
      S[k] = e.target.checked;
      save('s');
      toast(`${k === 'quickBust' ? 'Bust' : 'Bail'} confirm ${S[k] ? 'skipped' : 'restored'}`, 'info');
    });
  }

  // Keeps the HUD in the page, right above the list. Re-inserts the same element if
  // Torn re-renders the list area, so open settings and state survive.
  function placeHud() {
    if (!hud) buildHud();
    const anchor = document.querySelector('.users-list-title') || document.querySelector('ul.user-info-list-wrap');
    if (!anchor || !anchor.parentNode) return hud.isConnected;
    if (hud.nextElementSibling !== anchor) anchor.parentNode.insertBefore(hud, anchor);
    return true;
  }

  // One press = one click on the real bust (or bail) link of the chosen visible row.
  // Bust: best odds. Bail: cheapest prisoner within your bail cap.
  function pickBest(btn, kind) {
    if (btn.disabled) return;
    const target = kind === 'bail' ? bailRow : bestRow;
    const row = target && target.isConnected ? target : null;
    const link = row && row.querySelector(kind === 'bail' ? 'a[href*="step=buy"]' : 'a[href*="step=breakout"]');
    if (!link) {
      toast(kind === 'bail'
        ? (S.maxBail > 0 ? `No bails under your ${fmtMoneyShort(S.maxBail)} cap on this page` : 'No bails available on this page')
        : 'No bustable targets on this page', 'info');
      return;
    }
    btn.disabled = true;
    setTimeout(() => { btn.disabled = false; }, 1200);
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    row.classList.remove('lp-flash');
    void row.offsetWidth;
    row.classList.add('lp-flash');
    link.click();
  }

  function renderHud(heat) {
    if (!placeHud()) return;
    hud.classList.toggle('lp-collapsed', !!S.dockCollapsed);
    const q = (k) => hud.querySelector(`[data-k="${k}"]`);
    const hasKey = !!apiKey();
    const hasData = hasKey && (C.lastLogFetch > 0 || C.ts.length > 0);

    hud.querySelectorAll('.lp-bar .lp-ring, .lp-mini .lp-ring').forEach((r) => setRing(r, hasData ? heat : 0));
    setText(q('heat'), hasData ? `${Math.round(heat)}%` : '-');
    setText(q('picks'), hasData ? String(picksLeft(heat)) : '-');
    setText(q('cool'), hasData ? fmtDur(coolsIn()) : '-');
    setText(q('per'), `+${perBust().toFixed(1)}%`);
    setText(q('mini'), hasData
      ? `Heat ${Math.round(heat)}% · ${picksLeft(heat)} picks left · ${coolsIn() > 0 ? 'cools in ' + fmtDur(coolsIn()) : 'under limit'}`
      : 'Heat unknown · add an API key in settings');
    q('heat').closest('.lp-gauge').title = `Heat is your bust penalty. It lowers the odds on every prisoner.\nNow ${heat.toFixed(1)}% · limit ${S.heatLimit}% · halves roughly every 10 hours.`;

    let alert = '';
    if (!hasKey) alert = 'Add an API key to track your heat.';
    else if (C.err) alert = `API error: ${C.err.msg}`;
    q('alert').hidden = !alert;
    setText(q('alerttext'), alert);
    hud.querySelector('[data-act="fixkey"]').hidden = hasKey && !keyDead;

    const go = hud.querySelector('[data-act="best"].lp-go');
    const goBail = hud.querySelector('.lp-go-bail');
    const mini = q('minibest'), miniBail = q('minibail');
    go.hidden = mini.hidden = !S.bestButton;
    goBail.hidden = miniBail.hidden = !S.bailButton;
    hud.querySelector('.lp-actions').hidden = !S.bestButton && !S.bailButton;
    // Best Bust goes green when the best target is 80% or better; Best Bail goes green when someone is within your bail cap.
    const bustOk = !!(bestRow && bestRow._lp && bestRow._lp.p >= 80);
    go.classList.toggle('lp-go-ok', bustOk);
    mini.classList.toggle('lp-go-ok', bustOk);
    const bailOk = !!(bailRow && bailRow._lp && S.maxBail > 0 && bailRow._lp.bail <= S.maxBail);
    goBail.classList.toggle('lp-go-ok', bailOk);
    miniBail.classList.toggle('lp-go-ok', bailOk);
    if (bestRow && bestRow._lp) {
      const pr = fmtPct(bestRow._lp.p);
      setText(q('bestodds'), pr);
      setText(q('bestname'), bestRow._lp.name || 'Best target on this page');
      setText(mini, `Best Bust · ${pr}`);
    } else {
      setText(q('bestodds'), '');
      setText(q('bestname'), 'No bustable targets on this page');
      setText(mini, 'Best Bust');
    }
    const noBail = !(bailRow && bailRow._lp);
    goBail.classList.toggle('lp-go-none', noBail);
    miniBail.classList.toggle('lp-go-none', noBail);
    if (bailRow && bailRow._lp) {
      setText(q('bailcost'), fmtMoneyShort(bailRow._lp.bail));
      setText(q('bailname'), `${bailRow._lp.name || 'Cheapest on this page'} · ${fmtMoney(bailRow._lp.bail)}`);
      setText(miniBail, `Best Bail · ${fmtMoneyShort(bailRow._lp.bail)}`);
    } else {
      setText(q('bailcost'), '');
      setText(q('bailname'), S.maxBail > 0 ? `Nobody under your ${fmtMoneyShort(S.maxBail)} cap` : 'No bails on this page');
      setText(miniBail, 'Best Bail');
    }
    hud.querySelectorAll('input[data-q]').forEach((i) => { i.checked = !!S[i.dataset.q]; });
    setText(q('cap'), S.maxBail > 0 ? ` · max ${fmtMoneyShort(S.maxBail)}` : '');
  }

  // Result messages live in the HUD's feed row, never floating over the page.
  // Refresh the prisoner list in place. One real press = one request to Torn's own jail list (the same request the
  // jail page makes when you change page), then the rows are updated here; no page reload. If the request can't be
  // made, it falls back to reloading the page. Inside TUCC the request goes through TUCC's own guarded helper.
  let refreshing = false, lastRefresh = 0;
  const REFRESH_GAP_MS = 1000;   // Torn allows one action per second: a second press within a second is ignored
  function jailList(start) {
    if (typeof tucc !== 'undefined' && tucc && tucc.pagePost) return tucc.pagePost({ action: 'jail', start });
    const rfc = (/(?:^|;\s*)rfc_v=([^;]+)/.exec(document.cookie) || [])[1] || '';
    const body = new URLSearchParams({ action: 'jail', start: String(start) });
    return fetch('/jailview.php?rfcv=' + encodeURIComponent(rfc), { method: 'POST', credentials: 'same-origin', body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' } })
      .then((r) => r.text(), () => { throw new Error('Could not reach Torn'); })
      .then((t) => { try { return JSON.parse(t); } catch (e) { throw new Error('Unexpected reply'); } });
  }
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function refreshList(btn) {
    if (refreshing || Date.now() - lastRefresh < REFRESH_GAP_MS) return;
    lastRefresh = Date.now();
    const list = document.querySelector('ul.user-info-list-wrap');
    if (!list) { location.reload(); return; }
    refreshing = true;   // a second press while one refresh is still on its way is ignored (no greying out)
    const active = document.querySelector('a.page-number.active');
    const pageNo = Math.max(1, parseInt(active && active.getAttribute('page'), 10) || 1);
    try {
      const res = await jailList((pageNo - 1) * 50);
      const players = res && res.data && Array.isArray(res.data.players) ? res.data.players : null;
      if (!players) throw new Error('Unexpected reply');
      const rowOf = (id) => { const a = list.querySelector(`a.user.name[href*="XID=${id}"]`); return a && a.closest('li'); };
      const keep = new Set();
      for (const pl of players) {
        const id = String(pl.user_id);
        let li = rowOf(id);
        if (li) {
          const tm = li.querySelector('.time');
          if (tm) { const title = tm.querySelector('.title'); tm.textContent = ''; if (title) tm.append(title, ' ' + pl.time); else tm.textContent = String(pl.time); }
        } else {
          li = document.createElement('li');
          li.innerHTML = `${pl.online_offline || ''}<span class="user-wrap user-faction">${pl.print_tag || ''}</span><span class="user-wrap user-name">${pl.print_name || ''}</span>
<span class="info-wrap"><span class="time"><span class="title bold">TIME</span> ${esc(pl.time)}</span><span class="level"><span class="title bold">LEVEL</span> ${esc(pl.level)}</span><span class="reason">${pl.jailreason || ''}</span></span>
<a class="bye t-gray-3" href="jailview.php?XID=${encodeURIComponent(id)}&action=rescue&step=buy"><span class="bye-icon"></span><span class="title bold wai">BUY</span></a>
<a class="bust t-gray-3" href="jailview.php?XID=${encodeURIComponent(id)}&action=rescue&step=breakout"><span class="bust-icon"></span><span class="title bold wai">BUST</span></a>
<div class="confirm-bye"></div><div class="confirm-bust"></div><div class="bottom-white"></div>`;
          list.appendChild(li);
        }
        keep.add(li);
      }
      let gone = 0;
      [...list.children].forEach((li) => { if (li.tagName === 'LI' && li.querySelector('a.user.name') && !keep.has(li)) { li.remove(); gone++; } });
      const total = document.querySelector('.users-list-title span[class*="total"]');
      if (total && res.total != null) total.textContent = String(res.total);
      toast(`List refreshed: ${players.length} on this page${gone ? `, ${gone} gone` : ''}.`, 'info');
      render();
    } catch (err) {
      toast(`Couldn't refresh the list (${err.message}). Reload the page instead.`, 'info');
    } finally {
      refreshing = false;
    }
  }

  function toast(text, kind) {
    if (!hud) return;
    const host = hud.querySelector('[data-k="feed"]');
    if (kind === 'note') host.querySelectorAll('.lp-t-note').forEach((n) => n.remove()); // one explanation at a time
    const icon = kind === 'good' ? ICON.check : kind === 'bad' ? ICON.cross : kind === 'jail' ? ICON.lock : '';
    const t = el('div', `lp-toast lp-t-${kind || 'info'}`, `${icon}<span></span>`);
    t.setAttribute('role', 'status');
    t.querySelector('span').textContent = text;
    host.appendChild(t);
    const chips = host.querySelectorAll('.lp-toast');
    if (chips.length > 3) chips[0].remove();
    setTimeout(() => { t.classList.add('lp-out'); setTimeout(() => t.remove(), 300); }, kind === 'note' ? 10000 : 6000);
  }

  // Tap (or click) a prisoner's odds meter or the heat gauge to see its details in the HUD.
  // Hover tooltips don't exist on touch screens, so this is how PDA users get the same info.
  function onExplainTap(e) {
    if (!onJail() || !e.target || !e.target.closest) return;
    const target = e.target.closest('.lp-meter, .lp-gauge');
    if (!target || !target.title) return;
    toast(target.title.split('\n').join(' · '), 'note');
  }

  // ---------------------------------------------------------------------------
  // Nav badge
  // ---------------------------------------------------------------------------
  function renderBadge(heat) {
    const a = document.querySelector('#nav-jail a');
    if (!a) return;
    let b = a.querySelector('.lp-badge');
    const show = apiKey() && (S.badge === 'everywhere' || (S.badge === 'jail' && onJail()));
    if (!show) { if (b) b.remove(); return; }
    if (!b) {
      b = el('span', 'lp-badge', `${ringSvg(14, 3)}<b></b>`);
      a.appendChild(b);
    }
    setRing(b.querySelector('.lp-ring'), heat);
    setText(b.querySelector('b'), `${Math.round(heat)}%`);
    b.classList.toggle('lp-badge-hot', heatLevel(heat) === 'bad');
    b.title = `Lockpick heat ${heat.toFixed(1)}% · ${picksLeft(heat)} pick(s) left before your ${S.heatLimit}% limit`;
  }

  // ---------------------------------------------------------------------------
  // Outcome detection (passive)
  // ---------------------------------------------------------------------------
  const RX = {
    gone: /no longer in jail|not in jail|already (been )?(busted|released|bailed)/i,
    jailed: /caught|arrested|thrown (in|into) jail|sent to jail|you were jailed/i,
    ok: /you busted|successfully busted/i,
    fail: /failed|unsuccessful|couldn'?t|could not|did ?n[o']t manage/i,
  };
  const count = (s, re) => (s.match(new RegExp(re.source, 'gi')) || []).length;
  const msgText = () => [...document.querySelectorAll('.info-msg-cont, .info-msg, .msg')]
    .filter((n) => !n.closest('ul.user-info-list-wrap') && !n.closest('.lp-ui'))
    .map(normText).join(' ');

  let pending = null;
  let pendingBail = null;

  function onDocClick(e) {
    if (!onJail() || !e.target || !e.target.closest) return;
    const a = e.target.closest('a[href*="step=breakout"], a[href*="step=buy"]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    const isBust = /step=breakout/.test(href);
    const row = a.closest('li');
    const info = row && row._lp;
    // Bail cap: stop the click before Torn sees it, so no request is sent at all.
    if (!isBust && S.maxBail > 0 && (!info || overCap(info.bail))) {
      e.preventDefault();
      e.stopImmediatePropagation();
      toast(info
        ? `Bail blocked: ${info.name || 'this prisoner'} costs ${fmtMoney(info.bail)}, over your ${fmtMoneyShort(S.maxBail)} cap`
        : `Bail blocked: couldn't price this prisoner, so your ${fmtMoneyShort(S.maxBail)} cap can't be checked`, 'bad');
      return;
    }
    if (!isBust && info && !/step=buy1/.test(href) && !S.quickBail) {
      // Confirm step on: remember the base price so Torn's quoted price can calibrate your discount.
      pendingBail = { li: row, base: bailBase(info.lvl, info.minutes), at: Date.now(), snap: normText(row) };
    }
    if ((isBust && S.quickBust) || (!isBust && S.quickBail)) {
      const next = href.replace(/(step=(?:breakout|buy))1?(?=&|$)/, (_m, base) => base + '1');
      if (next !== href) a.setAttribute('href', next);
    }
    if (!isBust) return;
    const li = a.closest('li');
    const d = li && li._lp;
    if (!d) return;
    pending = {
      li, name: d.name, d: d.d, p0: d.p0, p: d.p,
      heat: heatAt(nowSec()), bonus: bustBonus(), lvl: level(),
      at: Date.now(), snapRow: normText(li), snapMsg: msgText(),
    };
  }

  // Reads the price Torn quotes on its bail confirm prompt and stores the real discount ratio.
  function checkPendingBail() {
    if (!pendingBail) return;
    if (Date.now() - pendingBail.at > PENDING_TIMEOUT_MS || !pendingBail.li.isConnected) { pendingBail = null; return; }
    const amounts = (t) => (t.match(/\$\s?[\d,]{3,}/g) || []).map((x) => +x.replace(/[^\d]/g, ''));
    const before = new Set(amounts(pendingBail.snap));
    const fresh = amounts(normText(pendingBail.li)).filter((x) => !before.has(x));
    if (!fresh.length) return;
    const ratio = fresh[0] / pendingBail.base;
    pendingBail = null;
    if (ratio > 0.03 && ratio <= 1.05) {
      C.bailMult = Math.min(1, ratio);
      save('c');
      render();
      refreshDrawer();
    }
  }

  function checkPending() {
    checkPendingBail();
    if (!pending) return;
    if (Date.now() - pending.at > PENDING_TIMEOUT_MS) { pending = null; return; }
    const judge = (now, before) => {
      const more = (re) => count(now, re) > count(before, re);
      if (more(RX.gone)) return { gone: true };
      if (more(RX.jailed)) return { ok: false, jailed: true };
      if (more(RX.ok)) return { ok: true };
      if (more(RX.fail)) return { ok: false, jailed: false };
      return null;
    };
    let res = pending.li.isConnected ? judge(normText(pending.li), pending.snapRow) : null;
    if (!res) res = judge(msgText(), pending.snapMsg);
    if (!res) return;
    const p = pending;
    pending = null;
    if (res.gone) { toast(`${p.name || 'Target'} is no longer in jail`, 'info'); return; }
    recordOutcome(p, res);
  }

  function recordOutcome(p, res) {
    O.push({
      ts: Date.now(), m: MODEL_V, d: p.d, heat: Math.round(p.heat * 10) / 10, lvl: p.lvl, bonus: p.bonus,
      p0: Math.round(p.p0 * 100) / 100, p: Math.round(p.p * 10) / 10, ok: !!res.ok, jailed: !!res.jailed,
    });
    if (O.length > OUTCOME_MAX) O.splice(0, O.length - OUTCOME_MAX);
    save('o');
    fitLearning();
    if (res.ok) { C.ts.unshift(nowSec()); save('c'); scheduleResync(); }
    const who = p.name || 'target', shot = fmtPct(p.p);
    if (res.ok) toast(`Picked ${who} · ${shot} shot`, 'good');
    else if (res.jailed) toast(`Caught on ${who} · you're in jail`, 'jail');
    else toast(`Missed ${who} · ${shot} shot`, 'bad');
    render();
  }

  // ---------------------------------------------------------------------------
  // Settings: opens inside the HUD, pushing the list down rather than covering anything
  // ---------------------------------------------------------------------------
  let drawer = null;
  let wantSettings = null; // tab to open once the HUD is on the page

  const sw = (key, label, hint) => `
    <label class="lp-row"><span class="lp-row-l">${label}${hint ? `<small>${hint}</small>` : ''}</span>
      <span class="lp-sw"><input type="checkbox" data-s="${key}"><i></i></span></label>`;
  const range = (key, label, min, max, step, unit, hint) => `
    <label class="lp-row lp-row-range"><span class="lp-row-l">${label}${hint ? `<small>${hint}</small>` : ''}</span>
      <span class="lp-range"><input type="range" data-s="${key}" min="${min}" max="${max}" step="${step}"><output data-v="${key}" data-unit="${unit}"></output></span></label>`;
  const select = (key, label, opts) => `
    <label class="lp-row"><span class="lp-row-l">${label}</span>
      <select data-s="${key}">${opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label>`;

  function buildDrawer() {
    drawer = hud.querySelector('[data-k="settings"]');
    drawer.innerHTML = `
      <div class="lp-sh">
        <div class="lp-summary" data-k="summary"></div>
        <button type="button" class="lp-ib" data-act="close" title="Close settings" aria-label="Close settings">${ICON.close}</button>
      </div>
      <nav class="lp-tabs">
        <button type="button" data-tab="heat">Heat</button>
        <button type="button" data-tab="list">List</button>
        <button type="button" data-tab="learn">Learning</button>
        <button type="button" data-tab="key">API key</button>
        <button type="button" data-tab="data">Data</button>
      </nav>
      <div class="lp-panes">
        <section data-pane="heat">
          <div class="lp-card2">
            ${range('heatLimit', 'Heat limit', 10, 200, 5, '%', 'The bust penalty you\'re willing to carry. Sets "Picks left", "Cools in" and the gauge tick.')}
          </div>
          <div class="lp-card2">
            ${select('badge', 'Nav badge', [['everywhere', 'Every page'], ['jail', 'Jail page only'], ['off', 'Off']])}
            <p class="lp-note">Heat decays on its own: half is gone after about 10 hours and all of it after 72.</p>
          </div>
        </section>

        <section data-pane="list">
          <div class="lp-card2">
            ${sw('sortByOdds', 'Sort this page by odds')}
            ${sw('bestButton', '"Best Bust" button', 'One press clicks the best-odds prisoner\'s real bust link once.')}
            ${sw('bailButton', '"Best Bail" button', 'One press clicks the cheapest prisoner\'s real bail link once, never above your bail cap.')}
            ${sw('showDifficulty', 'Show difficulty next to odds', 'Level x minutes left. The same number as the bail price divided by $100.')}
          </div>
          <div class="lp-card2">
            ${range('greenAt', 'Good odds from', 0, 100, 1, '%')}
            ${range('redBelow', 'Poor odds below', 0, 100, 1, '%')}
            ${range('dimBelow', 'Fade prisoners below', 0, 100, 5, '%', '0 = off')}
          </div>
          <div class="lp-card2">
            <label class="lp-row"><span class="lp-row-l">Maximum bail<small>Bail clicks over this are blocked before anything is sent. Accepts 350000, 350k or 1.5m. Blank or 0 = no cap.</small></span>
              <input type="text" class="lp-num lp-money" data-s="maxBail" placeholder="no cap" inputmode="decimal"></label>
            <label class="lp-row"><span class="lp-row-l">Bail discount override (%)<small>Blank = automatic.</small></span>
              <input type="number" class="lp-num" data-s="bailDiscountOverride" min="0" max="95" step="0.25" placeholder="auto"></label>
            <p class="lp-note" data-k="bailinfo"></p>
          </div>
        </section>

        <section data-pane="learn">
          <div class="lp-card2">
            ${sw('learning', 'Learn from my results', 'Tunes the odds to your real success rate, gently from the first bust.')}
            <div class="lp-acc" data-k="acc"></div>
          </div>
          <div class="lp-card2">
            <label class="lp-row"><span class="lp-row-l">Busting bonus override (%)<small>Blank = read from your perks. Faction (50%) plus all LAW perks (65%) is 115%.</small></span>
              <input type="number" class="lp-num" data-s="bonusOverride" min="0" max="200" step="5" placeholder="auto"></label>
            <button type="button" class="lp-btn" data-act="refreshprofile">Refresh level &amp; perks now</button>
            <button type="button" class="lp-btn lp-btn-ghost" data-act="resetlearn">Clear learning history</button>
          </div>
        </section>

        <section data-pane="key">
          <div class="lp-card2">
            <div class="lp-keystate" data-k="keystate"></div>
            <a class="lp-btn" href="${KEY_URL}" target="_blank" rel="noopener noreferrer">Create a key (${API_SELECTIONS} only)</a>
            <input type="text" class="lp-input" data-k="key" placeholder="Paste your 16-character key"
              autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
              data-lpignore="true" data-1p-ignore data-bwignore data-form-type="other">
            <div class="lp-pair">
              <button type="button" class="lp-btn" data-act="savekey">Save key</button>
              <button type="button" class="lp-btn lp-btn-ghost" data-act="clearkey">Clear saved key</button>
            </div>
          </div>
          <div class="lp-tos" role="table" aria-label="Terms of service">
            <div class="lp-tos-cap">Terms of service</div>
            <div class="lp-tos-row" role="row"><span role="rowheader">Data storage</span><span role="cell">Only locally</span></div>
            <div class="lp-tos-row" role="row"><span role="rowheader">Data sharing</span><span role="cell">Nobody</span></div>
            <div class="lp-tos-row" role="row"><span role="rowheader">Purpose of use</span><span role="cell">Competitive advantage (bust odds, heat tracking and bail pricing)</span></div>
            <div class="lp-tos-row" role="row"><span role="rowheader">Key storage &amp; sharing</span><span role="cell">Stored / Used only for automation (on this device; sent only to api.torn.com)</span></div>
            <div class="lp-tos-row" role="row"><span role="rowheader">Key access level</span><span role="cell">Custom: basic, log, perks</span></div>
          </div>
        </section>

        <section data-pane="data">
          <div class="lp-card2">
            <p class="lp-note">Removes your settings, saved key and learning history from this device.</p>
            <button type="button" class="lp-btn lp-btn-danger" data-act="wipe">Erase all Lockpick data</button>
          </div>
        </section>
      </div>`;

    drawer.querySelector('.lp-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) showTab(b.dataset.tab);
    });

    const onInput = (e) => {
      const t = e.target, k = t.dataset.s;
      if (!k) return;
      if (t.type === 'checkbox') S[k] = t.checked;
      else if (t.tagName === 'SELECT') S[k] = t.value;
      else if (k === 'maxBail') { if (e.type !== 'change') return; const v = parseMoney(t.value); S[k] = v && v > 0 ? v : 0; t.value = S[k] ? fmtNum(S[k]) : ''; }
      else if (k === 'bailDiscountOverride') { const v = parseFloat(t.value); S[k] = t.value.trim() !== '' && Number.isFinite(v) && v >= 0 ? v : null; }
      else if (k === 'bonusOverride') { const v = parseFloat(t.value); S[k] = t.value.trim() !== '' && Number.isFinite(v) && v >= 0 ? v : null; }
      else { const v = parseFloat(t.value); S[k] = Number.isFinite(v) ? v : DEFAULTS[k]; }
      save('s');
      if (k === 'learning') fitLearning();
      render();
      refreshDrawer(t);
    };
    drawer.addEventListener('input', onInput);
    drawer.addEventListener('change', onInput);

    const q = (k) => drawer.querySelector(`[data-k="${k}"]`);
    const on = (act, fn) => drawer.querySelector(`[data-act="${act}"]`).addEventListener('click', fn);
    on('close', closeDrawer);
    on('savekey', () => {
      const k = cleanKey(q('key').value);
      if (k.length !== 16) { q('keystate').textContent = `That key is ${k.length} characters. Torn keys are 16.`; q('keystate').className = 'lp-keystate lp-bad'; return; }
      store.set(KEYS.key, k);
      q('key').value = '';
      keyDead = false; C.err = null;
      sync({ minGap: 0, forceProfile: true });
      refreshDrawer();
    });
    on('clearkey', () => { store.del(KEYS.key); keyDead = false; C.err = null; render(); refreshDrawer(); });
    on('refreshprofile', () => { keyDead = false; sync({ minGap: 0, forceProfile: true }); });
    twoStep(drawer.querySelector('[data-act="resetlearn"]'), 'Tap again to clear history', () => {
      O = []; save('o'); fitLearning(); render(); refreshDrawer();
    });
    twoStep(drawer.querySelector('[data-act="wipe"]'), 'Tap again to erase everything', () => {
      for (const k of Object.values(KEYS)) store.del(k);
      location.reload();
    });
  }

  function twoStep(btn, armed, action) {
    const rest = btn.textContent;
    let t = null;
    btn.addEventListener('click', () => {
      if (t) { clearTimeout(t); t = null; btn.textContent = rest; btn.classList.remove('lp-armed'); action(); return; }
      btn.textContent = armed;
      btn.classList.add('lp-armed');
      t = setTimeout(() => { t = null; btn.textContent = rest; btn.classList.remove('lp-armed'); }, 4000);
    });
  }

  function showTab(name) {
    drawer.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    drawer.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== name; });
  }

  function refreshDrawer(skip) {
    if (!drawer || drawer.hidden) return;
    for (const inp of drawer.querySelectorAll('[data-s]')) {
      if (inp === skip) continue;
      const v = S[inp.dataset.s];
      if (inp.type === 'checkbox') inp.checked = !!v;
      else if (inp.dataset.s === 'maxBail') inp.value = v ? fmtNum(v) : '';
      else inp.value = v == null ? '' : v;
    }
    setText(drawer.querySelector('[data-k="bailinfo"]'), `Your bail discount: ${Math.round((1 - bailMult()) * 1000) / 10}%, from ${bailSource()}. `
      + 'Turn "Skip bail confirm" off for one bail and Lockpick reads your exact discount from the price Torn quotes.');
    drawer.querySelectorAll('output[data-v]').forEach((o) => setText(o, `${S[o.dataset.v]}${o.dataset.unit}`));

    const q = (k) => drawer.querySelector(`[data-k="${k}"]`);
    const heat = heatAt(nowSec());
    q('summary').innerHTML = `
      <div><small>Level</small><b>${C.level || '?'}</b></div>
      <div><small>Bust bonus</small><b>${Math.round(bustBonus())}%${hasOverride() ? '*' : ''}</b></div>
      <div><small>Heat</small><b class="lp-t-${heatLevel(heat)}">${Math.round(heat)}%</b></div>
      <div><small>Logged</small><b>${L.n}</b></div>`;

    const src = keySource();
    const ks = q('keystate');
    let msg = src === 'saved' ? 'Your saved key is in use.'
      : src === 'pda' ? 'Using the key from Torn PDA. Save one here to override it.'
      : 'No key yet. Create one below, then paste it here.';
    if (C.err) msg += ` Last API error: ${C.err.msg}.`;
    ks.textContent = msg;
    ks.className = 'lp-keystate ' + (C.err || src === 'none' ? 'lp-bad' : 'lp-ok');

    const acc = accuracy();
    q('acc').innerHTML = !acc
      ? '<p class="lp-note">No results yet. Every bust you make on the jail page is logged on this device.</p>'
      : `<div class="lp-acc-h">Last ${acc.n} busts</div>
         <div class="lp-bars">
           <div><span>Predicted</span><i><em style="width:${acc.pred}%"></em></i><b>${acc.pred}%</b></div>
           <div><span>Actual</span><i><em class="lp-act" style="width:${acc.act}%"></em></i><b>${acc.act}%</b></div>
         </div>
         <p class="lp-note">${acc.jailed} of them ended in jail. The closer the bars, the better the odds fit you.</p>`;
  }

  // Settings live in the jail page's HUD. From any other page, go to the jail page and
  // open them there.
  function openDrawer(tab) {
    if (!onJail()) {
      try { sessionStorage.setItem('lp_open', tab || 'auto'); } catch (e) { /* ignore */ }
      location.href = '/jailview.php';
      return;
    }
    if (!placeHud()) { wantSettings = tab || 'auto'; return; }
    if (!drawer) buildDrawer();
    drawer.hidden = false;
    hud.classList.add('lp-settings-open');
    refreshDrawer();
    showTab(tab && tab !== 'auto' ? tab : (keySource() === 'none' ? 'key' : 'heat'));
    drawer.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function closeDrawer() {
    if (!drawer) return;
    drawer.hidden = true;
    hud.classList.remove('lp-settings-open');
  }
  function toggleDrawer() {
    if (drawer && !drawer.hidden) closeDrawer(); else openDrawer();
  }

  // ---------------------------------------------------------------------------
  // Render loop
  // ---------------------------------------------------------------------------
  let observer = null, rafQueued = false;

  function render() {
    const heat = heatAt(nowSec());
    renderBadge(heat);
    if (onJail()) {
      renderRows(heat);
      renderHud(heat);
      if (wantSettings && hud && hud.isConnected) { const t = wantSettings; wantSettings = null; openDrawer(t); }
      if (observer) observer.takeRecords();
    }
  }
  function onMutations() {
    if (rafQueued) return;
    rafQueued = true;
    requestAnimationFrame(() => { rafQueued = false; checkPending(); render(); });
  }
  function tick() {
    if (document.hidden) return;
    checkPending();
    render();
    if (onJail()) sync({ minGap: JAIL_POLL_MS });
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------
  const CSS = `
  :root{--lp-bg:#14171b;--lp-card:#1a1e23;--lp-raise:#252a32;--lp-line:#2f353e;--lp-text:#e8ebee;--lp-dim:#8d96a0;
    --lp-good:#34c99a;--lp-mid:#f1b33c;--lp-bad:#ef5f5f;--lp-brass:#d6a347;--lp-brass-dk:#a87c2e;
    --lp-num:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
  .lp-ui{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:var(--lp-text);font-size:12px;line-height:1.4;box-sizing:border-box;text-align:left}
  .lp-ui *{box-sizing:border-box}
  .lp-ui button{font-family:inherit}
  .lp-ui [hidden]{display:none!important}

  .lp-ring-track{stroke:var(--lp-line)}
  .lp-ring-arc{stroke:var(--lp-good);transition:stroke-dashoffset .5s ease,stroke .3s}
  .lp-ring-tick{stroke:var(--lp-text);opacity:.7}
  .lp-lv-mid .lp-ring-arc{stroke:var(--lp-mid)}.lp-lv-bad .lp-ring-arc{stroke:var(--lp-bad)}

  /* HUD: sits in the page flow above the prisoner list, full width of the content */
  .lp-hud{width:100%;margin:0 0 8px;background:var(--lp-bg);border:1px solid var(--lp-line);border-radius:10px;overflow:hidden;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
  .lp-bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px;padding:10px 12px}
  .lp-brand{display:inline-flex;align-items:center;gap:6px;color:var(--lp-brass)}
  .lp-brand b{color:var(--lp-text);font-size:12px;letter-spacing:.08em;text-transform:uppercase}
  .lp-gauge{position:relative;width:58px;height:58px;flex:0 0 auto}
  .lp-gauge .lp-ring{position:absolute;top:0;right:0;bottom:0;left:0}
  .lp-gauge-val{position:absolute;top:0;right:0;bottom:0;left:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
  .lp-gauge-val b{font:700 14px var(--lp-num)}
  .lp-gauge-val small{color:var(--lp-dim);font-size:8px;text-transform:uppercase;letter-spacing:.12em}
  .lp-stats{display:flex;gap:18px;margin:0}
  .lp-stats div{display:flex;flex-direction:column}
  .lp-stats dt{color:var(--lp-dim);font-size:10px;text-transform:uppercase;letter-spacing:.08em}
  .lp-stats dd{margin:0;font:700 15px var(--lp-num)}
  .lp-actions{display:flex;flex-direction:column;gap:6px;flex:0 1 250px;min-width:190px}
  .lp-refresh{align-self:center;width:55%;padding:3px 0;border-radius:7px;border:1px solid var(--lp-line);background:var(--lp-raise);color:var(--lp-text);font:700 12px/16px inherit;cursor:pointer}
  .lp-refresh:hover{border-color:var(--lp-brass)}
  .lp-refresh:disabled{opacity:.6;cursor:default}
  .lp-go{width:100%;display:flex;flex-direction:column;align-items:stretch;gap:1px;padding:7px 11px;border-radius:9px;cursor:pointer;text-align:left;
    border:1px solid var(--lp-brass-dk);background:linear-gradient(180deg,var(--lp-brass),var(--lp-brass-dk));color:#1b1406;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.25);transition:filter .15s,transform .05s}
  .lp-go:hover,.lp-go-mini:hover{filter:brightness(1.08)}.lp-go:active,.lp-go-mini:active{transform:translateY(1px)}
  .lp-go:disabled,.lp-go-mini:disabled{filter:grayscale(.6) brightness(.8);cursor:default}
  .lp-go-main{display:flex;align-items:center;gap:7px;font-weight:800;font-size:13px}
  .lp-go-main b{margin-left:auto;font:800 13px var(--lp-num);padding:0 7px;border-radius:999px;background:rgba(0,0,0,.18)}
  .lp-go-sub{font-size:11px;opacity:.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-left:25px}
  .lp-switches{display:grid;gap:5px}
  .lp-tools{display:inline-flex;gap:2px;margin-left:auto}
  .lp-ib{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:7px;border:0;background:transparent;color:var(--lp-dim);cursor:pointer}
  .lp-ib:hover{background:var(--lp-raise);color:var(--lp-text)}
  .lp-settings-open .lp-tools [data-act="settings"]{background:var(--lp-raise);color:var(--lp-brass)}

  /* Compact view: one slim strip */
  .lp-mini{display:none;align-items:center;gap:10px;padding:5px 8px 5px 10px}
  .lp-collapsed .lp-bar{display:none}.lp-collapsed .lp-mini{display:flex}
  .lp-mini-ring{display:inline-flex}
  .lp-mini-text{font:600 12px var(--lp-num);color:var(--lp-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
  .lp-go-bail{background:linear-gradient(180deg,#2d6b5a,#1f4d41);border-color:#1a3f35;color:#e6f7f1}
  .lp-go-bail .lp-go-main b{background:rgba(0,0,0,.25)}
  .lp-go-mini-bail{background:#2d6b5a!important;border-color:#1a3f35!important;color:#e6f7f1!important}
  .lp-go-bail.lp-go-none{background:linear-gradient(180deg,#8a3434,#632222);border-color:#4d1a1a;color:#ffe3e3}
  .lp-go-mini-bail.lp-go-none{background:#7a2e2e!important;border-color:#4d1a1a!important;color:#ffe3e3!important}
  .lp-go.lp-go-ok,.lp-go-mini.lp-go-ok{background:#15803d!important;border-color:#166534!important;color:#fff!important}
  .lp-go.lp-go-ok .lp-go-main b{background:rgba(0,0,0,.25)}
  .lp-go-mini{flex:0 0 auto;padding:4px 10px;border-radius:7px;cursor:pointer;font-weight:800;font-size:12px;
    border:1px solid var(--lp-brass-dk);background:var(--lp-brass);color:#1b1406}

  /* Feed row: alerts and results, inside the HUD */
  .lp-feed{display:flex;flex-wrap:wrap;gap:6px;padding:0 12px}
  .lp-feed > :not([hidden]):first-child,.lp-feed > *{margin-bottom:8px}
  .lp-alert{display:flex;align-items:center;gap:10px;padding:5px 10px;border-radius:999px;background:rgba(239,95,95,.12);color:#ffb3b3;font-size:11px}
  .lp-link{border:0;background:none;color:var(--lp-brass);font-weight:700;cursor:pointer;padding:0;white-space:nowrap}
  .lp-toast{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:var(--lp-card);
    border:1px solid var(--lp-line);font-size:11px;animation:lpIn .25s ease-out;max-width:100%}
  .lp-toast span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .lp-t-note{border-radius:10px;border-color:rgba(214,163,71,.45)}
  .lp-t-note span{white-space:normal}
  .lp-meter,.lp-gauge{cursor:help}
  .lp-t-good{border-color:rgba(52,201,154,.5)}.lp-t-good svg{color:var(--lp-good)}
  .lp-t-bad{border-color:rgba(241,179,60,.5)}.lp-t-bad svg{color:var(--lp-mid)}
  .lp-t-jail{border-color:rgba(239,95,95,.6)}.lp-t-jail svg{color:var(--lp-bad)}
  .lp-toast.lp-out{opacity:0;transition:opacity .3s}
  @keyframes lpIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}

  /* Switches */
  .lp-sw{display:inline-flex;align-items:center;gap:8px;cursor:pointer;color:var(--lp-dim);font-size:11px;user-select:none}
  .lp-sw input{position:absolute;opacity:0;pointer-events:none}
  .lp-sw i{position:relative;flex:0 0 auto;width:30px;height:17px;border-radius:999px;background:var(--lp-line);transition:background .2s}
  .lp-sw i::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#cfd5db;transition:transform .2s}
  .lp-sw input:checked + i{background:var(--lp-good)}
  .lp-sw input:checked + i::after{transform:translateX(13px);background:#fff}
  .lp-sw input:checked ~ span{color:var(--lp-text)}
  .lp-sw input:focus-visible + i{outline:2px solid var(--lp-brass);outline-offset:2px}

  /* Settings: expands inside the HUD */
  .lp-settings{border-top:1px solid var(--lp-line);background:var(--lp-card);padding:12px}
  .lp-sh{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px}
  .lp-summary{flex:1;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;max-width:440px}
  .lp-summary div{background:var(--lp-bg);border:1px solid var(--lp-line);border-radius:9px;padding:6px 8px}
  .lp-summary small{display:block;color:var(--lp-dim);font-size:9px;text-transform:uppercase;letter-spacing:.1em}
  .lp-summary b{font:700 14px var(--lp-num)}
  .lp-summary .lp-t-good{color:var(--lp-good)}.lp-summary .lp-t-mid{color:var(--lp-mid)}.lp-summary .lp-t-bad{color:var(--lp-bad)}
  .lp-sh .lp-ib{margin-left:auto}
  .lp-tabs{display:flex;gap:4px;border-bottom:1px solid var(--lp-line);overflow-x:auto}
  .lp-tabs button{flex:0 0 auto;border:0;background:none;color:var(--lp-dim);padding:7px 8px 8px;cursor:pointer;font-size:12px;font-weight:600;
    border-bottom:2px solid transparent;margin-bottom:-1px}
  .lp-tabs button.on{color:var(--lp-text);border-bottom-color:var(--lp-brass)}
  .lp-panes section{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;padding-top:12px;align-items:start}
  .lp-card2{background:var(--lp-bg);border:1px solid var(--lp-line);border-radius:10px;padding:4px 12px}
  .lp-card2 > .lp-btn,.lp-card2 > .lp-pair,.lp-card2 > .lp-input,.lp-card2 > .lp-keystate{margin:10px 0}
  .lp-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid var(--lp-line);cursor:pointer}
  .lp-row:last-child{border-bottom:0}
  .lp-row-l{color:var(--lp-text);font-weight:600}
  .lp-row-l small{display:block;color:var(--lp-dim);font-weight:400;font-size:11px;margin-top:2px}
  .lp-row-range{flex-wrap:wrap}
  .lp-range{display:flex;align-items:center;gap:8px;width:100%}
  .lp-range input{flex:1;accent-color:var(--lp-brass)}
  .lp-range output{min-width:42px;text-align:right;font:700 12px var(--lp-num)}
  .lp-row select,.lp-num{height:28px;background:var(--lp-card);color:var(--lp-text);border:1px solid var(--lp-line);border-radius:7px;padding:0 6px}
  .lp-num{width:72px;text-align:center;font-family:var(--lp-num)}
  .lp-input{display:block;width:100%;background:var(--lp-card);color:var(--lp-text);border:1px solid var(--lp-line);border-radius:8px;padding:8px}
  .lp-input{font-family:var(--lp-num);-webkit-text-security:disc}
  .lp-btn{display:block;width:100%;text-align:center;text-decoration:none;padding:8px;border-radius:8px;cursor:pointer;font-weight:700;font-size:12px;
    border:1px solid var(--lp-brass-dk);background:var(--lp-brass);color:#1b1406}
  .lp-btn:hover{filter:brightness(1.08)}
  .lp-btn-ghost{background:transparent;color:var(--lp-text);border-color:var(--lp-line)}
  .lp-btn-danger{background:transparent;color:var(--lp-bad);border-color:rgba(239,95,95,.5)}
  .lp-btn.lp-armed{background:var(--lp-bad);color:#fff;border-color:var(--lp-bad)}
  .lp-pair{display:flex;gap:8px}.lp-pair .lp-btn{flex:1}
  .lp-keystate{padding:8px 10px;border-radius:8px;font-size:11px}
  .lp-keystate.lp-ok{background:rgba(52,201,154,.12);color:#9cebd0}
  .lp-keystate.lp-bad{background:rgba(239,95,95,.12);color:#ffb3b3}
  .lp-note{margin:8px 0;color:var(--lp-dim);font-size:11px}
  .lp-acc{padding:4px 0 8px}
  .lp-acc-h{font-weight:700;margin-bottom:8px}
  .lp-bars{display:grid;gap:6px}
  .lp-bars div{display:grid;grid-template-columns:62px 1fr 40px;align-items:center;gap:8px}
  .lp-bars span{color:var(--lp-dim);font-size:11px}
  .lp-bars i{display:block;height:8px;border-radius:999px;background:var(--lp-line);overflow:hidden}
  .lp-bars em{display:block;height:100%;background:var(--lp-brass);border-radius:999px}
  .lp-bars em.lp-act{background:var(--lp-good)}
  .lp-bars b{font:700 12px var(--lp-num);text-align:right}
  .lp-tos{display:block;font-size:11px;line-height:1.4}
  .lp-tos-cap{color:var(--lp-dim);font-size:10px;text-transform:uppercase;letter-spacing:.1em;padding:0 2px 6px}
  .lp-tos-row{display:grid;grid-template-columns:40% 1fr;background:var(--lp-bg);border:1px solid var(--lp-line);border-top:0}
  .lp-tos-cap + .lp-tos-row{border-top:1px solid var(--lp-line);border-radius:10px 10px 0 0}
  .lp-tos-row:last-child{border-radius:0 0 10px 10px}
  .lp-tos-row span{display:block;padding:7px 10px;color:var(--lp-text);font-weight:400}
  .lp-tos-row span:first-child{color:var(--lp-dim);font-weight:600;border-right:1px solid var(--lp-line)}

  /* Rows */
  .lp-meter{display:inline-flex;align-items:center;gap:5px;margin-right:7px;padding:2px 7px 2px 5px;border-radius:6px;vertical-align:middle;
    background:rgba(20,23,27,.82);border:1px solid rgba(255,255,255,.08);line-height:14px}
  .lp-pins{display:inline-flex;gap:2px;align-items:flex-end}
  .lp-pins i{display:block;width:3px;border-radius:1px;background:#3a414b}
  .lp-pins i:nth-child(1){height:5px}.lp-pins i:nth-child(2){height:7px}.lp-pins i:nth-child(3){height:9px}.lp-pins i:nth-child(4){height:11px}.lp-pins i:nth-child(5){height:13px}
  .lp-meter b{font:700 11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e8ebee;min-width:28px;text-align:right}
  .lp-m-good .lp-pins i.on{background:#34c99a}.lp-m-mid .lp-pins i.on{background:#f1b33c}.lp-m-bad .lp-pins i.on{background:#ef5f5f}
  .lp-m-good b{color:#7ee6c3}.lp-m-mid b{color:#ffd27a}.lp-m-bad b{color:#ff9a9a}
  .lp-meter.lp-untested{border-style:dashed;opacity:.8}
  ul.user-info-list-wrap > li a.lp-bail-over{opacity:.3;filter:grayscale(1);cursor:not-allowed}
  ul.user-info-list-wrap > li a.lp-bail-ok{box-shadow:inset 0 -2px 0 #34c99a}
  .lp-cap{font-style:normal;color:var(--lp-brass);font-weight:700}
  .lp-money{width:96px}
  ul.user-info-list-wrap.lp-sorted{display:flex!important;flex-direction:column}
  ul.user-info-list-wrap > li.lp-dim{opacity:.38}
  ul.user-info-list-wrap > li.lp-best{box-shadow:inset 3px 0 0 #d6a347;background-image:linear-gradient(90deg,rgba(214,163,71,.16),transparent 45%)}
  ul.user-info-list-wrap > li.lp-best .lp-meter{border-color:rgba(214,163,71,.7)}
  @keyframes lpFlash{0%{background-color:rgba(214,163,71,.45)}100%{background-color:transparent}}
  ul.user-info-list-wrap > li.lp-flash{animation:lpFlash 1.2s ease-out}

  /* Nav badge */
  .lp-badge{display:inline-flex;align-items:center;gap:4px;margin-left:auto;margin-right:4px;padding:1px 6px 1px 3px;border-radius:999px;
    background:#14171b;border:1px solid #2f353e;line-height:14px}
  .lp-badge b{font:700 10px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e8ebee}
  .lp-badge-hot{border-color:rgba(239,95,95,.7)}
  @media (max-width:1000px){#nav-jail a{position:relative}.lp-badge{position:absolute;top:-2px;right:-2px;margin:0;padding:0 4px 0 2px}.lp-badge .lp-ring{width:10px;height:10px}}

  @media (max-width:700px){
    .lp-bar{gap:8px 12px;padding:8px 10px}
    .lp-bar > .lp-brand{display:none}
    .lp-gauge{width:50px;height:50px}.lp-gauge .lp-ring{width:50px;height:50px}
    .lp-gauge-val b{font-size:12px}
    .lp-stats{gap:12px}.lp-stats dd{font-size:13px}
    .lp-actions{flex:1 1 100%;order:5}
    .lp-switches{order:6;grid-template-columns:1fr 1fr;flex:1 1 100%}
    .lp-summary{grid-template-columns:repeat(2,minmax(0,1fr))}
    .lp-mini-text{font-size:11px}
    .lp-ib{width:36px;height:36px}
    .lp-sw i{width:36px;height:20px}.lp-sw i::after{width:16px;height:16px}.lp-sw input:checked + i::after{transform:translateX(16px)}
    .lp-toast span{white-space:normal}
  }
  @media (prefers-reduced-motion:reduce){.lp-ui *,.lp-ui{transition:none!important;animation:none!important}}
  `;

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    fitLearning();
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('click', onExplainTap);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
    if (typeof GM_registerMenuCommand === 'function') {
      try { GM_registerMenuCommand('Lockpick settings', () => openDrawer()); } catch (e) { /* PDA */ }
    }

    if (onJail()) {
      try { const t = sessionStorage.getItem('lp_open'); if (t) { sessionStorage.removeItem('lp_open'); wantSettings = t; } } catch (e) { /* ignore */ }
      const root = document.querySelector('#mainContainer') || document.querySelector('.content-wrapper') || document.body;
      observer = new MutationObserver(onMutations);
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      sync({ minGap: LOAD_MIN_GAP_MS });
    }
    render();
    // The heat badge on Torn's Jail menu link: Torn draws (and redraws) its side menu after the page loads, so on
    // every page watch for the link and put the badge back the moment it's missing. Page drawing only, no requests.
    let badgeQueued = false;
    new MutationObserver(() => {
      if (badgeQueued) return;
      const a = document.querySelector('#nav-jail a');
      const want = apiKey() && (S.badge === 'everywhere' || (S.badge === 'jail' && onJail()));
      if (!a || !want || a.querySelector('.lp-badge')) return;
      badgeQueued = true;
      requestAnimationFrame(() => { badgeQueued = false; renderBadge(heatAt(nowSec())); });
    }).observe(document.body, { childList: true, subtree: true });

    setInterval(tick, TICK_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
