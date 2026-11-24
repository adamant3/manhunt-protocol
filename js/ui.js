// Screens. Each screen builds its skeleton once, then update() fills in live values.
import { S, save, SIM } from './state.js';
import * as net from './net.js';
import * as E from './engine.js';
import { createMap, draw } from './map.js';
import { dist, fmtDist, fmtClock } from './geo.js';
import { SETTING_META, DECK, SHOP, TRANSPORT, RADAR, COUNTDOWN_SEC } from './config.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function put(el, html) { if (el && el._h !== html) { el.innerHTML = html; el._h = html; } }
function txt(el, t) { if (el && el.textContent !== String(t)) el.textContent = t; }
const coins = n => Math.floor(n || 0).toLocaleString('en');
const teamWord = (t, plural) => t === 'RUNNER' ? (plural ? 'Runners' : 'Runner') : (plural ? 'Chasers' : 'Chaser');

const MARK = `<svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29"/><path d="M32 14 L50 45 L14 45 Z"/></svg>`;

let A = {};                 // actions from app.js
export function setActions(a) { A = a; }

let root, screen = null, lobbyMap = null, gameMap = null, lastTab = null;

export function init() {
  root = $('#app');
  root.addEventListener('click', onClick);
  root.addEventListener('submit', e => { e.preventDefault(); const f = e.target.dataset.submit; if (f) A[f] && A[f](e.target); });
  root.addEventListener('change', onChange);
}

function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const act = b.dataset.act;
  if (act === 'tab') { S.ui.tab = b.dataset.tab; update(); return; }
  if (A[act]) { e.preventDefault(); A[act](b.dataset, b); }
}

// Settings the host switched to "Custom…" but has not typed a value for yet
const customOpen = new Set();

function onChange(e) {
  const el = e.target, k = el.dataset.setting || el.dataset.custom;
  if (!k) return;
  if (el.dataset.custom) {
    const meta = SETTING_META[k], v = Number(String(el.value).replace(',', '.'));
    if (!isFinite(v) || el.value === '') { el.value = E.settings()[k]; return; }
    const clamped = Math.round(Math.min(meta.max, Math.max(meta.min, v)));
    if (clamped !== v) A.toast && A.toast(`${LABELS[k][0]} must be between ${meta.min} and ${meta.max} ${meta.unit}.`);
    customOpen.delete(k);
    A.setSetting(k, clamped);
    return;
  }
  if (el.value === 'custom') {
    customOpen.add(k); update();
    const inp = document.querySelector(`[data-custom="${k}"]`);
    if (inp) { inp.focus(); inp.select(); }
    return;
  }
  customOpen.delete(k);
  A.setSetting(k, el.value);
}

/* ------------------------------------------------------------- mounting */
export function show(name) {
  if (screen === name) return update();
  if (lobbyMap) { lobbyMap.destroy(); lobbyMap = null; }
  if (gameMap) { gameMap.destroy(); gameMap = null; }
  screen = name; lastTab = null;
  S.ui.toasts = [];
  root.className = 'app is-' + name;
  delete root.dataset.team;
  root.innerHTML = SCREENS[name]();
  const after = AFTER[name];
  if (after) after();
  update();
}

export function update() {
  const fn = UPDATE[screen];
  if (fn) fn();
  renderToasts();
}

/* --------------------------------------------------------------- landing */
const SCREENS = {
  landing: () => `
    <main class="landing">
      <div class="landing-top">
        ${MARK}
        <h1 class="wordmark">Manhunt</h1>
        <p class="lede">A chase across your city. Runners hide, chasers hunt, and everyone carries a phone with location on.</p>
      </div>
      <form class="stack" data-submit="host" novalidate>
        <label class="field">
          <span>Your name</span>
          <input id="nameInput" name="name" maxlength="14" autocomplete="nickname" autocapitalize="words" placeholder="What your friends call you" value="${esc(S.me.name)}" required>
        </label>
        <div class="choice">
          <button type="button" class="btn btn-primary" data-act="host">Host a game</button>
          <button type="button" class="btn" data-act="goJoin">Join a game</button>
        </div>
        <p class="error" id="err" role="alert"></p>
      </form>
      <details class="how">
        <summary>How a game works</summary>
        <ol>
          <li>The host shares a 4-letter code. Everyone joins and picks a team.</li>
          <li>Runners get a head start. After that, chasers see a rough area around each runner at every ping.</li>
          <li>Chasers catch a runner by getting their 4-digit code in person. Runners earn coins for surviving and for contracts, chasers for catches.</li>
        </ol>
      </details>
    </main>`,

  join: () => `
    <main class="join">
      <button class="link-back" data-act="back">Back</button>
      <h2>Join a game</h2>
      <p class="muted">Enter the code from the host's screen.</p>
      <form class="stack" data-submit="join" novalidate>
        <input id="codeInput" class="code-input" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Room code" placeholder="ABCD" value="${esc(S.joinCode)}">
        <button class="btn btn-primary" type="submit">Join as ${esc(S.me.name)}</button>
        <p class="error" id="err" role="alert"></p>
      </form>
    </main>`,

  lobby: () => `
    <main class="lobby">
      <header class="lobby-head">
        <button class="icon-btn" data-act="leave" aria-label="Leave room">✕</button>
        <div class="room">
          <span class="muted">Room code</span>
          <strong id="roomCode" class="room-code"></strong>
        </div>
        <button class="btn btn-small" data-act="share">Invite</button>
      </header>
      <section class="teams" aria-label="Teams">
        <div class="team team-runner">
          <h3>Runners <span id="nRunners" class="count"></span></h3>
          <ul id="listRunner" class="roster"></ul>
          <button class="btn btn-team" data-act="pickTeam" data-team="RUNNER" id="pickRunner">Join runners</button>
        </div>
        <div class="team team-chaser">
          <h3>Chasers <span id="nChasers" class="count"></span></h3>
          <ul id="listChaser" class="roster"></ul>
          <button class="btn btn-team" data-act="pickTeam" data-team="CHASER" id="pickChaser">Join chasers</button>
        </div>
      </section>
      <section class="settings">
        <div class="settings-head"><h3>Game settings</h3><span id="setBy" class="muted"></span></div>
        <div class="zone-map-wrap"><div id="lobbyMap" class="zone-map"></div><p id="zoneNote" class="zone-note"></p></div>
        <div id="settingsBody"></div>
      </section>
      <div id="gpsNote" class="gps-note"></div>
      <footer class="lobby-foot">
        <p id="startNote" class="muted"></p>
        <button class="btn btn-primary btn-start" id="startBtn" data-act="start">Start game</button>
      </footer>
    </main>`,

  countdown: () => `
    <main class="countdown">
      ${MARK}
      <div class="cd-num" id="cdNum" aria-live="assertive"></div>
      <p class="cd-role" id="cdRole"></p>
      <p class="muted">Keep this screen on for the whole game.</p>
    </main>`,

  game: () => `
    <main class="game">
      <div id="gameMap" class="map"></div>
      <header class="hud">
        <div class="hud-phase"><span id="phaseLabel"></span><strong id="phaseClock"></strong></div>
        <div class="hud-coins" id="hudCoins"><strong id="coinCount"></strong><span>coins</span></div>
        <button class="icon-btn" data-act="menu" aria-label="Menu">⋯</button>
      </header>
      <div id="alerts" class="alerts" aria-live="polite"></div>
      <div class="map-btns">
        <button class="icon-btn" data-act="recenter" aria-label="Centre on me">◎</button>
        <button class="icon-btn" data-act="fitZone" aria-label="Show whole zone">◯</button>
      </div>
      <section id="sheet" class="sheet" hidden></section>
      <div id="statusBar" class="statusbar"></div>
      <nav id="tabs" class="tabs"></nav>
    </main>`,

  results: () => `
    <main class="results">
      ${MARK}
      <h1 id="winner" class="winner"></h1>
      <p id="winSub" class="muted"></p>
      <ol id="board" class="board"></ol>
      <div class="stack">
        <button class="btn btn-primary" data-act="again" id="againBtn">Back to lobby</button>
        <button class="btn" data-act="leave">Leave room</button>
      </div>
    </main>`,

  loading: () => `<main class="loading">${MARK}<p id="loadMsg" class="muted">Connecting…</p></main>`
};

const AFTER = {
  landing: () => { const i = $('#nameInput'); if (!S.me.name) i.focus(); },
  join: () => { const i = $('#codeInput'); i.focus(); i.addEventListener('input', () => { i.value = i.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); }); },
  lobby: () => {
    lobbyMap = createMap($('#lobbyMap'), {
      center: zoneCenterGuess(), zoom: 13, interactive: true,
      onTap: p => { if (E.isHost()) A.setSetting('center', p); }
    });
  },
  game: () => {
    const c = S.pos || E.settings().center;
    gameMap = createMap($('#gameMap'), { center: c, zoom: 16, onTap: SIM ? p => A.simMove(p) : null });
    gameMap.onUserMove(() => { S.ui.follow = false; });
  }
};

export const setError = msg => txt($('#err'), msg || '');

/* --------------------------------------------------------------- updates */
const UPDATE = {
  lobby: updateLobby,
  countdown: updateCountdown,
  game: updateGame,
  results: updateResults
};

function zoneCenterGuess() {
  const st = E.settings();
  if (st.center) return st.center;
  const host = S.room && S.players.get(S.room.host_id);
  return E.posOf(host) || S.pos || null;
}

function gpsBadge(p) {
  const d = p.data || {};
  if (d.lat == null) return '<span class="gps gps-off">No location yet</span>';
  return `<span class="gps gps-on">±${Math.round(d.acc || 0)} m</span>`;
}

function updateLobby() {
  const host = E.isHost(), st = E.settings(), all = E.players();
  root.dataset.team = S.myTeam;
  txt($('#roomCode'), S.room.code);
  const row = p => `<li class="${p.id === S.me.id ? 'is-me' : ''}">
      <span class="who">${esc(p.callsign)}${p.id === S.me.id ? ' <em>you</em>' : ''}${p.id === S.room.host_id ? ' <em>host</em>' : ''}</span>
      ${gpsBadge(p)}
      ${host && p.id !== S.me.id ? `<button class="icon-btn icon-sm" data-act="kick" data-id="${esc(p.id)}" aria-label="Remove ${esc(p.callsign)}">✕</button>` : ''}
    </li>`;
  const runners = all.filter(p => p.team === 'RUNNER'), chasers = all.filter(p => p.team === 'CHASER');
  put($('#listRunner'), runners.map(row).join('') || '<li class="empty">Nobody yet</li>');
  put($('#listChaser'), chasers.map(row).join('') || '<li class="empty">Nobody yet</li>');
  txt($('#nRunners'), runners.length); txt($('#nChasers'), chasers.length);
  $('#pickRunner').hidden = S.myTeam === 'RUNNER';
  $('#pickChaser').hidden = S.myTeam === 'CHASER';

  txt($('#setBy'), host ? 'Only you can change these' : 'Set by the host');
  put($('#settingsBody'), host ? settingsForm(st) : settingsSummary(st));

  // Zone preview
  const c = zoneCenterGuess();
  if (lobbyMap) {
    const items = [];
    if (c) items.push({ key: 'zone', type: 'zone', lat: c.lat, lng: c.lng, r: st.zoneStartM });
    if (c && st.zoneEndM) items.push({ key: 'zoneEnd', type: 'ring', cls: 'ring-end', lat: c.lat, lng: c.lng, r: st.zoneEndM });
    all.forEach(p => { const pp = E.posOf(p); if (pp) items.push({ key: 'p' + p.id, type: 'player', lat: pp.lat, lng: pp.lng, cls: (p.team === 'RUNNER' ? 'is-runner' : 'is-chaser') + (p.id === S.me.id ? ' is-me' : '') }); });
    draw(lobbyMap, items);
    // Refit when the zone is first known, resized or moved on purpose (not on every GPS update)
    const fitKey = `${st.zoneStartM}|${st.center ? st.center.lat + ',' + st.center.lng : 'host'}`;
    if (c && lobbyMap._fitKey !== fitKey) { lobbyMap.fitCircle(c, st.zoneStartM, 12); lobbyMap._fitKey = fitKey; }
  }
  txt($('#zoneNote'), !c ? (host ? 'Waiting for your location. You can also tap the map to place the zone.' : 'The host has not placed the zone yet.')
    : host ? (st.center ? 'Tap the map to move the zone.' : 'The zone is centred on you. Tap the map to move it.')
    : `Zone radius ${fmtDist(st.zoneStartM)}, shrinking to ${fmtDist(st.zoneEndM)} by the end.`);

  put($('#gpsNote'), S.pos ? '' : S.gpsError
    ? `<p class="warn-box">${esc(S.gpsError)}</p>`
    : SIM ? '<p class="warn-box">Test mode: tap the game map to move.</p>' : '<p class="muted">Waiting for your location…</p>');

  const btn = $('#startBtn');
  btn.hidden = !host;
  const issues = [];
  if (!runners.length) issues.push('no runners');
  if (!chasers.length) issues.push('no chasers');
  if (host) {
    btn.disabled = !c;
    txt($('#startNote'), !c ? 'Place the zone first.' : issues.length ? `Heads up: ${issues.join(' and ')}. You can still start a test game.` : `${all.length} players ready. Everyone gets a ${COUNTDOWN_SEC}-second countdown.`);
  } else txt($('#startNote'), 'Waiting for the host to start.');
}

const LABELS = {
  durationMin: ['Game length', v => fmtMin(v)],
  headstartMin: ['Runner head start', v => v ? fmtMin(v) : 'None'],
  pingMin: ['Ping every', v => fmtMin(v)],
  pingSizeM: ['Ping area size', v => fmtDist(v)],
  zoneStartM: ['Zone radius at start', v => fmtDist(v)],
  zoneEndM: ['Zone radius at the end', v => fmtDist(v)],
  startCoins: ['Starting coins', v => v],
  bounty: ['Catch bounty', v => v + ' coins'],
  dripPerMin: ['Runner income', v => v + ' a minute'],
  cardCooldownMin: ['Time between contracts', v => fmtMin(v)]
};
const MAIN_KEYS = ['durationMin', 'headstartMin', 'pingMin', 'pingSizeM', 'zoneStartM', 'zoneEndM'];
const MORE_KEYS = ['startCoins', 'bounty', 'dripPerMin', 'cardCooldownMin'];
function fmtMin(v) { return v >= 60 && v % 60 === 0 ? `${v / 60} h` : v >= 60 ? `${Math.floor(v / 60)} h ${v % 60} min` : `${v} min`; }

function settingsForm(st) {
  const sel = k => {
    const meta = SETTING_META[k], v = +st[k];
    const custom = customOpen.has(k) || !meta.options.includes(v);
    const opts = meta.options.map(o => `<option value="${o}" ${!custom && v === o ? 'selected' : ''}>${LABELS[k][1](o)}</option>`).join('')
      + `<option value="custom" ${custom ? 'selected' : ''}>${custom && !customOpen.has(k) ? `Custom: ${LABELS[k][1](v)}` : 'Custom…'}</option>`;
    return `<div class="field-row-wrap"><label class="field field-row"><span>${LABELS[k][0]}</span>
      <select data-setting="${k}">${opts}</select></label>
      ${custom ? `<label class="custom-input"><input type="number" inputmode="numeric" min="${meta.min}" max="${meta.max}" step="1" data-custom="${k}" value="${v}" aria-label="${LABELS[k][0]} in ${meta.unit}"><span>${meta.unit}</span></label>` : ''}</div>`;
  };
  return `
    <div class="segmented" role="radiogroup" aria-label="Game mode">
      <button class="${st.mode === 'ELIMINATION' ? 'on' : ''}" data-act="setMode" data-mode="ELIMINATION" role="radio" aria-checked="${st.mode === 'ELIMINATION'}">Elimination<small>Caught runners are out</small></button>
      <button class="${st.mode === 'ZOMBIES' ? 'on' : ''}" data-act="setMode" data-mode="ZOMBIES" role="radio" aria-checked="${st.mode === 'ZOMBIES'}">Zombies<small>Caught runners join the chasers</small></button>
    </div>
    <div class="fields">${MAIN_KEYS.map(sel).join('')}</div>
    <details class="more"><summary>Economy</summary><div class="fields">${MORE_KEYS.map(sel).join('')}</div></details>
    ${st.center ? '<button class="btn btn-small btn-quiet" data-act="centerOnMe">Centre the zone on me</button>' : ''}`;
}

function settingsSummary(st) {
  const item = k => `<div><dt>${LABELS[k][0]}</dt><dd>${LABELS[k][1](st[k])}</dd></div>`;
  return `<dl class="summary">
    <div><dt>Mode</dt><dd>${st.mode === 'ZOMBIES' ? 'Zombies' : 'Elimination'}</dd></div>
    ${MAIN_KEYS.map(item).join('')}${MORE_KEYS.map(item).join('')}</dl>`;
}

/* ------------------------------------------------------------- countdown */
let lastCd = null;
function updateCountdown() {
  const T = E.times();
  if (!T) return;
  const left = Math.ceil((T.t0 - net.now()) / 1000);
  const n = Math.max(0, Math.min(COUNTDOWN_SEC, left));
  const el = $('#cdNum');
  if (n !== lastCd) {
    txt(el, n > 0 ? n : 'Go');
    el.classList.remove('tick'); void el.offsetWidth; el.classList.add('tick');
    if (n > 0 && n <= 3) A.beep && A.beep('tick');
    lastCd = n;
  }
  const st = E.settings(), team = S.myTeam;
  txt($('#cdRole'), team === 'RUNNER'
    ? (st.headstartMin ? `You are a runner. Get moving: chasers start pinging you in ${fmtMin(st.headstartMin)}.` : 'You are a runner. Chasers can see your first ping right away.')
    : (st.headstartMin ? `You are a chaser. Runners have a ${fmtMin(st.headstartMin)} head start.` : 'You are a chaser. Pings start right away.'));
  root.dataset.team = team;
}

/* ------------------------------------------------------------------ game */
function tabsFor() {
  if (E.amOut()) return [['map', 'Map'], ['feed', 'Activity']];
  return E.myTeam() === 'RUNNER'
    ? [['map', 'Map'], ['contracts', 'Contracts'], ['travel', 'Travel'], ['shop', 'Shop'], ['feed', 'Activity']]
    : [['map', 'Map'], ['catch', 'Catch'], ['shop', 'Shop'], ['feed', 'Activity']];
}

function updateGame() {
  const t = net.now(), ph = E.phase(t), T = E.times(), st = E.settings(), m = S.my, team = E.myTeam();
  root.dataset.team = E.amOut() ? 'OUT' : team;

  // HUD
  const label = ph === 'headstart' ? (team === 'RUNNER' ? 'Head start' : 'Chasers wait') : 'Time left';
  const clock = ph === 'headstart' ? (T.th - t) / 1000 : (T.tend - t) / 1000;
  txt($('#phaseLabel'), label); txt($('#phaseClock'), fmtClock(clock));
  txt($('#coinCount'), coins(m && m.coins));

  // Tabs
  const tabs = tabsFor();
  if (!tabs.some(x => x[0] === S.ui.tab)) S.ui.tab = 'map';
  put($('#tabs'), tabs.map(([k, l]) => `<button data-act="tab" data-tab="${k}" class="${S.ui.tab === k ? 'on' : ''}" aria-pressed="${S.ui.tab === k}">${l}${k === 'contracts' && E.contractState().state === 'ready' ? '<i class="badge" aria-label="new"></i>' : ''}</button>`).join(''));

  // Sheet
  const sheet = $('#sheet');
  sheet.hidden = S.ui.tab === 'map';
  if (S.ui.tab !== lastTab) { lastTab = S.ui.tab; sheet.innerHTML = SHEETS[S.ui.tab] ? SHEETS[S.ui.tab].skel() : ''; sheet._h = null; sheet.scrollTop = 0; }
  if (SHEETS[S.ui.tab]) SHEETS[S.ui.tab].fill(sheet, t);

  put($('#statusBar'), S.ui.tab === 'map' ? statusBar(t, ph) : '');
  put($('#alerts'), alerts(t));
  drawGameMap(t);
}

function statusBar(t, ph) {
  const m = S.my;
  if (!m) return '';
  if (E.amOut()) return '<div class="chip chip-out">You are out. You can still watch the game.</div>';
  const blind = m.contract && m.contract.kind === 'blind';
  const np = E.nextPingAt(t), pingText = blind ? 'Hidden' : ph === 'headstart' ? 'After head start' : fmtClock((np - t) / 1000);
  if (E.myTeam() === 'RUNNER') {
    const d = E.nearestChaser(S.pos);
    const band = blind ? ['Radar off', 'off'] : d <= RADAR.extreme ? ['Chaser very close', 'hot'] : d <= RADAR.danger ? ['Chaser within 100 m', 'hot'] : d <= RADAR.caution ? ['Chaser within 250 m', 'warm'] : ['No chaser near', 'calm'];
    const mult = E.multiplier(m.stillSec);
    return `<div class="chip chip-radar is-${band[1]}">${band[0]}</div>
      <div class="chip"><span>Next ping</span><strong>${pingText}</strong></div>
      <div class="chip"><span>Income</span><strong>${mult}×</strong></div>
      <button class="chip chip-code" data-act="toggleCode">${S.ui.revealCode ? `<span>Your code</span><strong class="code">${m.code}</strong>` : '<span>Your code</span><strong>Show</strong>'}</button>`;
  }
  const hound = S.ui.hound ? `<div class="chip chip-hound is-${S.ui.hound}"><span>Bloodhound</span><strong>${S.ui.hound === 'warmer' ? 'Warmer' : S.ui.hound === 'colder' ? 'Colder' : 'Keep moving'}</strong></div>` : '';
  const alive = E.players().filter(E.isAliveRunner).length;
  return `<div class="chip"><span>Next ping</span><strong>${pingText}</strong></div>
    <div class="chip"><span>Runners left</span><strong>${alive}</strong></div>${hound}`;
}

function alerts(t) {
  const m = S.my, out = [];
  if (!S.online) out.push(['bad', 'Connection lost. Retrying…']);
  if (!S.pos && !SIM) out.push(['bad', S.gpsError || 'Waiting for your location…']);
  if (!m || E.amOut()) return out.map(([c, x]) => `<p class="alert alert-${c}">${esc(x)}</p>`).join('');
  if (m.oobSec > 0) out.push(['bad', m.oobExposed ? 'Outside the zone. Chasers can see you.' : `Outside the zone. ${Math.max(0, 60 - m.oobSec)} s to get back in.`]);
  if (m.frozenUntil > t) out.push(['bad', `Frozen for ${fmtClock((m.frozenUntil - t) / 1000)}. Stay within 15 m.`]);
  if (m.breachUntil > t) out.push(['bad', `Exposed for ${fmtClock((m.breachUntil - t) / 1000)}.`]);
  if (m.exposedUntil > t) out.push(['bad', 'Flare: chasers can see you right now.']);
  if (m.contract && m.contract.warn) out.push(['warn', `${m.contract.warn} ${5 - m.contract.outSec} s to fix it.`]);
  if (E.sweepUntil() > t && E.myTeam() === 'RUNNER') out.push(['good', `Counter-sweep: chasers visible for ${Math.ceil((E.sweepUntil() - t) / 1000)} s.`]);
  return out.map(([c, x]) => `<p class="alert alert-${c}">${esc(x)}</p>`).join('');
}

function drawGameMap(t) {
  if (!gameMap) return;
  const items = [], st = E.settings(), center = st.center, m = S.my, team = E.myTeam(), out = E.amOut();
  if (center) items.push({ key: 'zone', type: 'zone', lat: center.lat, lng: center.lng, r: Math.round(E.zoneRadius(t)) });
  const sweep = E.sweepUntil() > t;

  E.players().forEach(p => {
    const pos = E.posOf(p);
    if (!pos) return;
    const pt = E.teamOf(p), mine = p.id === S.me.id, caught = E.isOut(p);
    if (caught && !mine) return;
    let cls = pt === 'RUNNER' ? 'is-runner' : 'is-chaser', show = false;
    if (mine) { show = true; cls += ' is-me'; }
    else if (out || pt === team) show = true;
    else if (E.isExposed(p, t)) { show = true; cls += ' is-exposed'; }
    else if (pt === 'CHASER' && sweep) show = true;
    else if (pt === 'RUNNER' && E.isStale(p) && E.phase(t) === 'hunt') { show = true; cls += ' is-stale'; }
    if (show) items.push({ key: 'p' + p.id, type: 'player', lat: pos.lat, lng: pos.lng, cls, label: mine ? '' : esc(p.callsign), z: mine ? 1000 : 0 });
  });

  // Ping areas: chasers and spectators see everyone's; runners see their own
  E.players().forEach(p => {
    if (!E.isAliveRunner(p) || !p.data || p.data.gid !== E.gameId()) return;
    const pg = p.data.ping;
    if (!pg || pg.ghost || !pg.bounds) return;
    if (!(out || team === 'CHASER' || p.id === S.me.id)) return;
    const age = Math.max(0, Math.round((t - pg.at) / 60000));
    const label = p.id === S.me.id ? 'Your last ping' : `${esc(p.callsign)} · ${age ? age + ' min ago' : 'now'}`;
    items.push({ key: 'ping' + p.id + pg.key, type: 'rect', bounds: pg.bounds, cls: p.id === S.me.id ? 'area-own' : '', label });
    if (pg.decoy && p.id !== S.me.id) items.push({ key: 'decoy' + p.id + pg.key, type: 'rect', bounds: pg.decoy, label });
  });

  if (team === 'CHASER' || out) E.activeTrails(t).forEach(e => items.push({ key: 'trail' + e.id, type: 'line', points: e.payload.points }));

  if (m && S.pos && !out) {
    const c = m.contract;
    if (c && c.kind === 'waypoint') items.push({ key: 'drop', type: 'flag', lat: c.target.lat, lng: c.target.lng });
    if (c && (c.kind === 'hold' || c.kind === 'statue')) {
      const card = DECK.find(d => d.id === c.id);
      items.push({ key: 'anchor' + c.startedAt, type: 'ring', cls: 'ring-task', lat: c.anchor.lat, lng: c.anchor.lng, r: card.radiusM });
    }
    if (m.frozenUntil > t && m.freezeAnchor) items.push({ key: 'freeze', type: 'ring', cls: 'ring-freeze', lat: m.freezeAnchor.lat, lng: m.freezeAnchor.lng, r: 15 });
  }
  draw(gameMap, items);

  if (S.pos && S.ui.follow && !gameMap.map.isMoving() && dist(gameMap.center(), S.pos) > 30) gameMap.panTo(S.pos);
}

export function recenter() {
  S.ui.follow = true;
  if (gameMap && S.pos) gameMap.setView(S.pos, Math.max(gameMap.zoom(), 16));
}
export function fitZone() {
  S.ui.follow = false;
  const c = E.settings().center;
  if (gameMap && c) gameMap.fitCircle(c, E.zoneRadius(net.now()), 24);
}

/* ----------------------------------------------------------------- sheets */
const SHEETS = {
  contracts: {
    skel: () => `<h2>Contracts</h2><div data-dyn="body"></div>`,
    fill(el, t) {
      const cs = E.contractState(t);
      let h;
      if (cs.state === 'active') {
        const c = cs.c, card = cs.card, pct = Math.round(Math.min(1, c.progress || 0) * 100);
        let detail = '';
        if (c.kind === 'survive' || c.kind === 'blind' || c.kind === 'hold') detail = `${fmtClock(card.durationSec - (t - c.startedAt) / 1000)} left`;
        if (c.kind === 'statue') detail = `${c.pings || 0} of ${card.pings} pings survived`;
        if (c.kind === 'den') detail = c.enteredAt ? `${fmtClock(card.durationSec - (t - c.enteredAt) / 1000)} left in the den` : 'Get within 100 m of a chaser to start';
        if (c.kind === 'waypoint') detail = `${fmtDist(c.left)} to the pin · ${fmtClock(card.limitSec - (t - c.startedAt) / 1000)} left`;
        if (c.kind === 'distance') detail = `${Math.round(c.meters || 0)} of ${card.meters} m`;
        if (c.kind === 'box') detail = c.waiting ? 'Waiting for your next ping' : `${fmtClock(card.durationSec - (c.held || 0))} left in the area`;
        h = `<article class="contract">
          <header><h3>${esc(card.title)}</h3><span class="reward">+${card.reward}</span></header>
          <p>${esc(card.desc)}</p>
          <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
          <p class="detail">${detail}</p>
          <p class="muted small">Checked by GPS. It completes by itself.</p>
          <button class="btn btn-quiet" data-act="veto">Drop this contract</button>
        </article>`;
      } else if (cs.state === 'cooldown') {
        h = `<div class="empty-state"><p>Next contract in <strong>${fmtClock(cs.left)}</strong>.</p><p class="muted">Contracts pay 500–800 coins.</p></div>`;
      } else {
        h = `<div class="empty-state"><p>Take on a contract for 500–800 coins. You get one at a time, and a new one every ${fmtMin(E.settings().cardCooldownMin)}.</p>
          <button class="btn btn-primary" data-act="draw" ${S.pos ? '' : 'disabled'}>Draw a contract</button></div>`;
      }
      put(el.querySelector('[data-dyn=body]'), h);
    }
  },

  travel: {
    skel: () => `<h2>Travel</h2><p class="muted">No cars. Each ticket gives you 20 minutes on that kind of transport.</p><div data-dyn="body"></div>`,
    fill(el, t) {
      const m = S.my; if (!m) return;
      const riding = m.transit && m.transit.until > t;
      const head = riding ? `<p class="riding">${TRANSPORT.find(x => x.id === m.transit.mode).icon} On the ${TRANSPORT.find(x => x.id === m.transit.mode).name.toLowerCase()} for ${fmtClock((m.transit.until - t) / 1000)}</p>` : '';
      put(el.querySelector('[data-dyn=body]'), head + `<ul class="list">${TRANSPORT.map(x => {
        const n = m.tickets[x.id] || 0;
        return `<li><span class="li-main">${x.icon} ${x.name}</span><span class="muted">${n} left</span>
          <button class="btn btn-small" data-act="ride" data-mode="${x.id}" ${n > 0 && !riding ? '' : 'disabled'}>Use</button></li>`;
      }).join('')}</ul>`);
    }
  },

  shop: {
    skel: () => `<h2>Shop</h2><p class="muted">The other team is told when you buy something, but not who bought it.</p><div data-dyn="body"></div>`,
    fill(el) {
      const m = S.my, team = E.myTeam(); if (!m) return;
      const targets = E.players().filter(p => p.id !== S.me.id && E.teamOf(p) !== team && !E.isOut(p));
      const items = SHOP[team].map(it => {
        let extra = '';
        if (it.id === 'ticket') extra = `<select data-shopopt="ticket" aria-label="Ticket type">${TRANSPORT.map(x => `<option value="${x.id}">${x.name}</option>`).join('')}</select>`;
        if (it.target) extra = targets.length ? `<select data-shopopt="${it.id}" aria-label="Who to freeze">${targets.map(p => `<option value="${esc(p.id)}">${esc(p.callsign)}</option>`).join('')}</select>` : '<span class="muted small">Nobody to target</span>';
        const can = m.coins >= it.price && (!it.target || targets.length);
        return `<li class="shop-item"><div class="li-text"><strong>${it.name}</strong><span class="muted">${it.desc}</span></div>
          <div class="li-act">${extra}<button class="btn btn-small ${can ? 'btn-primary' : ''}" data-act="buy" data-item="${it.id}" ${can ? '' : 'disabled'}>${it.price}</button></div></li>`;
      }).join('');
      // keep selected options while the list re-renders
      const keep = {}; el.querySelectorAll('[data-shopopt]').forEach(s => keep[s.dataset.shopopt] = s.value);
      put(el.querySelector('[data-dyn=body]'), `<ul class="list">${items}</ul>`);
      el.querySelectorAll('[data-shopopt]').forEach(s => { if (keep[s.dataset.shopopt]) s.value = keep[s.dataset.shopopt]; });
    }
  },

  catch: {
    skel: () => `<h2>Catch a runner</h2>
      <p class="muted">When you reach a runner, ask for the 4-digit code on their screen.</p>
      <form class="catch-form" data-submit="catchCode" novalidate>
        <input name="code" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="0000" aria-label="Runner's code" class="code-input">
        <button class="btn btn-primary" type="submit">Catch</button>
      </form>
      <div data-dyn="near"></div>`,
    fill(el) {
      const near = E.taggable();
      put(el.querySelector('[data-dyn=near]'), near.length
        ? `<h3>Within 25 m</h3><ul class="list">${near.map(p => `<li><span class="li-main">${esc(p.callsign)}</span><button class="btn btn-small btn-primary" data-act="tag" data-id="${esc(p.id)}">Tag</button></li>`).join('')}</ul>`
        : '');
    }
  },

  feed: {
    skel: () => `<h2>Activity</h2><div data-dyn="body"></div>`,
    fill(el) {
      put(el.querySelector('[data-dyn=body]'), S.ui.feed && S.ui.feed.length
        ? `<ol class="feed">${S.ui.feed.slice(0, 60).map(f => `<li class="tone-${f.tone}"><time>${f.time}</time><span>${esc(f.text)}</span></li>`).join('')}</ol>`
        : '<p class="muted">Nothing yet. Pings, catches and power-ups show up here.</p>');
    }
  }
};

/* --------------------------------------------------------------- results */
function updateResults() {
  const o = E.outcome(), team = E.myTeam(), host = E.isHost();
  const head = o.winner == null ? 'Game over' : o.winner === 'RUNNER' ? 'Runners win' : 'Chasers win';
  txt($('#winner'), head);
  root.dataset.team = o.winner || '';
  txt($('#winSub'), o.winner == null ? '' : o.winner === 'RUNNER'
    ? `${o.alive} of ${o.runnersEver} runners stayed free.` : 'Every runner was caught.');
  const rows = E.players().map(p => ({ p, d: p.data && p.data.gid === E.gameId() ? p.data : {} }))
    .sort((a, b) => (b.d.coins || 0) - (a.d.coins || 0));
  put($('#board'), rows.map(({ p, d }) => `<li class="${p.id === S.me.id ? 'is-me' : ''}">
      <span class="who">${esc(p.callsign)}<small>${teamWord(E.teamOf(p))}${E.isOut(p) ? ', caught' : ''}${d.stats && d.stats.catches ? `, ${d.stats.catches} catch${d.stats.catches > 1 ? 'es' : ''}` : ''}</small></span>
      <strong>${coins(d.coins)}</strong></li>`).join(''));
  $('#againBtn').hidden = !host;
  void team;
}

/* ------------------------------------------------------------ toasts/feed */
export function pushToast(text, tone) {
  const id = Math.random().toString(36).slice(2);
  S.ui.toasts.push({ id, text, tone, until: Date.now() + 4000 });
  if (S.ui.toasts.length > 2) S.ui.toasts.shift();
  const d = new Date();
  S.ui.feed = S.ui.feed || [];
  S.ui.feed.unshift({ text, tone, time: `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}` });
  renderToasts();
  setTimeout(renderToasts, 4100);
}

function renderToasts() {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.className = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
  S.ui.toasts = S.ui.toasts.filter(x => x.until > Date.now());
  put(box, S.ui.toasts.map(x => `<p class="toast tone-${x.tone}">${esc(x.text)}</p>`).join(''));
}

/* ---------------------------------------------------------------- modals */
export function modal({ title, body = '', actions }) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h2>${esc(title)}</h2>${body ? `<p>${esc(body)}</p>` : ''}
      <div class="stack">${actions.map((a, i) => `<button class="btn ${a.primary ? 'btn-primary' : ''} ${a.danger ? 'btn-danger' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div></div>`;
    wrap.addEventListener('click', e => {
      const b = e.target.closest('[data-i]');
      if (b) { wrap.remove(); resolve(actions[+b.dataset.i].value); }
      else if (e.target === wrap) { wrap.remove(); resolve(null); }
    });
    document.body.appendChild(wrap);
    wrap.querySelector('button').focus();
  });
}

export const shopOpt = id => { const s = document.querySelector(`[data-shopopt="${id}"]`); return s && s.value; };
export const currentScreen = () => screen;
export function setLoading(msg) { const el = $('#loadMsg'); if (el) el.textContent = msg; }
export { save };
