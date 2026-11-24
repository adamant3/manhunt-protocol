// Game rules. Every phone runs this for its own player only; other players' effects
// arrive as events. All timers derive from the room's server start time.
import * as net from './net.js';
import { S, render } from './state.js';
import { dist, offset, pingArea, inBounds } from './geo.js';
import {
  DEFAULT_SETTINGS, RADAR, TAG_RANGE_M, STALE_MS, OOB_GRACE_SEC, FREEZE_MS, FREEZE_RADIUS_M,
  BREACH_MS, TRANSIT_MS, DECK, SHOP, TRANSPORT
} from './config.js';

export let notify = () => {};           // set by the UI: notify(text, tone, opts)
export function setNotifier(fn) { notify = fn; }

/* ------------------------------------------------------------------ derived */
export const settings = () => ({ ...DEFAULT_SETTINGS, ...(S.room && S.room.settings || {}) });
export const gameId = () => S.room && S.room.game_id;
export const isHost = () => !!(S.room && S.room.host_id === S.me.id);
export const evTime = e => Date.parse(e.created_at);

export function times() {
  if (!S.room || !S.room.started_at) return null;
  const st = settings(), t0 = Date.parse(S.room.started_at);
  return { t0, th: t0 + st.headstartMin * 60e3, tend: t0 + st.durationMin * 60e3, ping: st.pingMin * 60e3 };
}

export function zoneRadius(t) {
  const st = settings(), T = times();
  if (!T || t <= T.th) return st.zoneStartM;
  const f = Math.min(1, (t - T.th) / Math.max(1, T.tend - T.th));
  return st.zoneStartM + (st.zoneEndM - st.zoneStartM) * f;
}

export function nextPingAt(t) {
  const T = times();
  if (!T) return null;
  if (t < T.th) return T.th;
  return T.th + (Math.floor((t - T.th) / T.ping) + 1) * T.ping;
}

export function phase(t = net.now()) {
  const T = times();
  if (!S.room) return 'none';
  if (S.room.phase === 'LOBBY') return 'lobby';
  if (S.room.phase === 'ENDED') return 'ended';
  if (!T) return 'lobby';
  if (t < T.t0) return 'countdown';
  if (t >= T.tend) return 'ended';
  return t < T.th ? 'headstart' : 'hunt';
}

const current = p => p && p.data && p.data.gid && p.data.gid === gameId();
export function caughtSet() {
  const s = new Set();
  S.events.forEach(e => { if (e.type === 'catch') s.add(e.payload.runner); });
  return s;
}
export function teamOf(p) {
  if (!p) return null;
  if (settings().mode === 'ZOMBIES' && caughtSet().has(p.id)) return 'CHASER';
  return p.team;
}
export function isOut(p) {
  if (!p) return false;
  if (settings().mode === 'ZOMBIES') return false;
  return caughtSet().has(p.id) || (current(p) && p.data.status === 'CAUGHT');
}
export const isAliveRunner = p => teamOf(p) === 'RUNNER' && !isOut(p);
export const me = () => S.players.get(S.me.id);
export const players = () => [...S.players.values()];
export const myTeam = () => teamOf(me()) || S.myTeam;
export const amOut = () => isOut(me());
export const posOf = p => (p && p.data && p.data.lat != null) ? { lat: p.data.lat, lng: p.data.lng } : null;
export const isStale = p => !p.updated_at || net.now() - Date.parse(p.updated_at) > STALE_MS;

export function isExposed(p, t = net.now()) {
  if (!current(p)) return false;
  const d = p.data;
  return (d.exposedUntil > t) || (d.breachUntil > t) || !!d.oobExposed;
}

export function sweepUntil() {
  let u = 0;
  S.events.forEach(e => { if (e.type === 'sweep') u = Math.max(u, evTime(e) + 30e3); });
  return u;
}

export function activeTrails(t = net.now()) {
  return S.events.filter(e => e.type === 'trail' && t - evTime(e) < 180e3);
}

export function nearestChaser(pos) {
  let best = Infinity;
  players().forEach(p => {
    if (p.id === S.me.id || teamOf(p) !== 'CHASER') return;
    const d = dist(pos, posOf(p));
    if (d < best) best = d;
  });
  return best;
}

export function nearestRunner(pos) {
  let best = Infinity, who = null;
  players().forEach(p => {
    if (p.id === S.me.id || !isAliveRunner(p)) return;
    const d = dist(pos, posOf(p));
    if (d < best) { best = d; who = p; }
  });
  return { d: best, p: who };
}

export const multiplier = s => s >= 1200 ? 4 : s >= 600 ? 2.5 : s >= 180 ? 1.5 : 1;
const tol = () => Math.min(15, Math.max(0, ((S.pos && S.pos.acc) || 10) * 0.5));

/* ---------------------------------------------------------- my game data */
export function freshGameData() {
  const st = settings(), p = S.pos || {};
  return {
    gid: gameId(), status: 'ALIVE', coins: st.startCoins,
    code: String(1000 + Math.floor(Math.random() * 9000)),
    tickets: Object.fromEntries(TRANSPORT.map(m => [m.id, 1])),
    transit: null, contract: null, cooldownUntil: 0,
    frozenUntil: 0, freezeAnchor: null, breachUntil: 0, exposedUntil: 0,
    oobSec: 0, oobExposed: false, ghost: false, decoy: false, houndUntil: 0,
    ping: null, prevPing: null, pingDone: [], precUsed: [], evDone: [],
    anchor: null, stillSec: 0, patrolM: 0, lastStep: null,
    stats: { catches: 0, contracts: 0, earned: 0 },
    lat: p.lat ?? null, lng: p.lng ?? null, acc: p.acc ?? null
  };
}

export function lobbyData() {
  const p = S.pos || {};
  return { gid: null, lat: p.lat ?? null, lng: p.lng ?? null, acc: p.acc ?? null };
}

export function myRow() {
  const data = S.my || lobbyData();
  if (S.pos) { data.lat = S.pos.lat; data.lng = S.pos.lng; data.acc = S.pos.acc; }
  return { id: S.me.id, room_code: S.room.code, callsign: S.me.name, team: S.myTeam, data };
}

// Mirror my row into the local player list right away so the UI never waits on the network
function mirror() {
  if (!S.room) return;
  const old = S.players.get(S.me.id) || {};
  S.players.set(S.me.id, { ...old, ...myRow(), updated_at: new Date(net.now()).toISOString() });
}

let pushing = false, pushAgain = false;
export async function push() {
  if (!S.room) return;
  mirror();
  if (pushing) { pushAgain = true; return; }
  pushing = true;
  try { await net.upsertPlayer(myRow()); S.online = true; }
  catch (e) { S.online = false; }
  pushing = false;
  if (pushAgain) { pushAgain = false; push(); }
  render();
}

/* ------------------------------------------------------------- position */
let lastPushPos = null, lastPushAt = 0;
export function onPosition(p) {
  S.pos = { lat: p.lat, lng: p.lng, acc: p.acc, t: net.now() };
  if (S.my) { S.my.lat = p.lat; S.my.lng = p.lng; S.my.acc = p.acc; }
  const ph = phase();
  if (S.my && (ph === 'headstart' || ph === 'hunt') && !amOut()) {
    if (myTeam() === 'RUNNER') countContractDistance();
    if (myTeam() === 'CHASER') countPatrol();
  }
  mirror();
  if (!lastPushPos || dist(lastPushPos, S.pos) > 8 || Date.now() - lastPushAt > 3000) {
    lastPushPos = S.pos; lastPushAt = Date.now(); push();
  }
  render();
}

/* -------------------------------------------------------------- the tick */
let tickN = 0;
export function tick() {
  tickN++;
  const t = net.now(), ph = phase(t);
  if (!S.my || S.my.gid !== gameId() || !(ph === 'headstart' || ph === 'hunt')) return;
  applyEvents();
  if (amOut() || !S.pos) return;

  const team = myTeam();
  freezeCheck(t);
  if (team === 'RUNNER') runnerTick(t, ph);
  else chaserTick(t);
  if (tickN % 3 === 0) push();
}

function freezeCheck(t) {
  const m = S.my;
  if (m.frozenUntil > t && m.freezeAnchor) {
    if (dist(m.freezeAnchor, S.pos) > FREEZE_RADIUS_M + tol() && !(m.breachUntil > t)) {
      m.breachUntil = t + BREACH_MS;
      notify('You moved while frozen. Your location is visible to the other team for 5 minutes.', 'bad', { buzz: true });
      push();
    }
  }
}

function runnerTick(t, ph) {
  const m = S.my, st = settings(), pos = S.pos;

  // Stillness multiplier: stay within 25 m to build it up
  if (!m.anchor || dist(m.anchor, pos) > 25 + tol()) {
    if (m.stillSec >= 180) notify('You moved more than 25 m. Your income multiplier is back to 1×.', 'info');
    m.anchor = { lat: pos.lat, lng: pos.lng }; m.stillSec = 0;
  } else m.stillSec++;
  const earn = st.dripPerMin / 60 * multiplier(m.stillSec);
  m.coins += earn; m.stats.earned += earn;

  // Adrenaline bonus near chasers
  const near = nearestChaser(pos);
  if (tickN % 10 === 0) {
    if (near <= RADAR.extreme) { m.coins += 40; m.stats.earned += 40; }
    else if (near <= RADAR.danger) { m.coins += 15; m.stats.earned += 15; }
  }

  // Zone
  const center = settings().center;
  if (center) {
    if (dist(pos, center) > zoneRadius(t)) {
      m.oobSec++;
      if (m.oobSec === 1) notify(`You are outside the zone. Get back in within ${OOB_GRACE_SEC} seconds.`, 'bad', { buzz: true });
      if (m.oobSec > OOB_GRACE_SEC && !m.oobExposed) {
        m.oobExposed = true;
        notify('You stayed outside the zone. Chasers can see your location until you return.', 'bad', { buzz: true });
        push();
      }
    } else if (m.oobSec) {
      if (m.oobExposed) notify('Back inside the zone. Your location is hidden again.', 'good');
      m.oobSec = 0; m.oobExposed = false;
    }
  }

  if (ph === 'hunt') maybePing(t);
  contractTick(t);
}

function maybePing(t) {
  const m = S.my, T = times(), due = [];
  const k = Math.floor((t - T.th) / T.ping);
  if (!m.pingDone.includes('s' + k)) due.push('s' + k);
  S.events.forEach(e => {
    if (e.type === 'ping_now' && !m.pingDone.includes('e' + e.id)) due.push('e' + e.id);
  });
  if (!due.length) return;

  const st = settings();
  let size = Math.max(80, st.pingSizeM * zoneRadius(t) / st.zoneStartM);
  const sinceT = m.ping ? m.ping.at : T.t0;
  const prec = S.events.filter(e => e.type === 'precision' && !m.precUsed.includes(e.id) && evTime(e) >= sinceT - 5000);
  if (prec.length) { size = Math.max(50, size / 2); prec.forEach(e => m.precUsed.push(e.id)); }

  const key = due[due.length - 1];
  if (m.ghost) {
    m.ghost = false;
    m.ping = { key, at: t, ghost: true };
    notify('Ghost used: you were left out of this ping.', 'good', { buzz: true });
  } else {
    m.ping = { key, at: t, ...pingArea(S.pos, size) };
    if (m.decoy) {
      m.decoy = false;
      const a = Math.random() * Math.PI * 2;
      m.ping.decoy = pingArea(offset(S.pos, Math.cos(a) * 400, Math.sin(a) * 400), size).bounds;
    }
    notify(`Ping sent. Chasers now see a ${m.ping.size} m area around you.`, 'warn', { buzz: true, sound: 'ping' });
  }
  m.prevPing = { lat: S.pos.lat, lng: S.pos.lng };
  m.pingDone.push(...due);

  const c = m.contract;
  if (c && c.kind === 'statue') {
    c.pings = (c.pings || 0) + 1;
    const card = DECK.find(d => d.id === c.id);
    if (c.pings >= card.pings) completeContract();
  }
  push();
}

function chaserTick(t) {
  const m = S.my;
  // Recon bonus: first chaser into a runner's real ping area
  players().forEach(p => {
    if (!isAliveRunner(p) || !current(p)) return;
    const pg = p.data.ping;
    if (!pg || pg.ghost || !inBounds(S.pos, pg.bounds)) return;
    const key = p.id + ':' + pg.key;
    if (reconSent.has(key) || S.events.some(e => e.type === 'recon' && e.payload.key === key)) return;
    reconSent.add(key);
    sendEvent('recon', { key, runner: p.id });
  });
  // Bloodhound
  if (m.houndUntil > t && tickN % 5 === 0) {
    const { d } = nearestRunner(S.pos);
    if (isFinite(d)) {
      if (houndLast != null) S.ui.hound = d < houndLast - 3 ? 'warmer' : d > houndLast + 3 ? 'colder' : S.ui.hound || 'steady';
      else S.ui.hound = 'steady';
      houndLast = d;
    }
  } else if (!(m.houndUntil > t)) { S.ui.hound = null; houndLast = null; }
}
const reconSent = new Set();
let houndLast = null;

function countPatrol() {
  const m = S.my, p = S.pos, t = net.now();
  if (!m.lastStep) { m.lastStep = { lat: p.lat, lng: p.lng, t }; return; }
  const d = dist(m.lastStep, p);
  if (d < 10) return;
  const speed = d / Math.max(1, (t - m.lastStep.t) / 1000);
  m.lastStep = { lat: p.lat, lng: p.lng, t };
  if (speed > 12) return;
  m.patrolM += d;
  while (m.patrolM >= 500) {
    m.patrolM -= 500; m.coins += 25; m.stats.earned += 25;
    notify('Patrol bonus: +25 for covering 500 m.', 'good');
  }
}

/* ------------------------------------------------------------- contracts */
export function contractState(t = net.now()) {
  const m = S.my;
  if (!m) return { state: 'none' };
  if (m.contract) return { state: 'active', c: m.contract, card: DECK.find(d => d.id === m.contract.id) };
  if (m.cooldownUntil > t) return { state: 'cooldown', left: (m.cooldownUntil - t) / 1000 };
  return { state: 'ready' };
}

export function drawContract() {
  const m = S.my, t = net.now();
  if (!m || m.contract || m.cooldownUntil > t || myTeam() !== 'RUNNER' || amOut() || !S.pos) return;
  const pool = DECK.filter(d => d.id !== m.lastCard);
  const card = pool[Math.floor(Math.random() * pool.length)];
  const c = { id: card.id, kind: card.kind, startedAt: t, outSec: 0, progress: 0,
    anchor: { lat: S.pos.lat, lng: S.pos.lng } };
  if (card.id === 'flare') m.exposedUntil = t + 10e3;
  if (card.kind === 'waypoint') c.target = deadDrop();
  m.contract = c; m.lastCard = card.id;
  notify(`New contract: ${card.title}.`, 'info');
  push();
}

function deadDrop() {
  const center = settings().center, r = zoneRadius(net.now());
  for (let i = 0; i < 30; i++) {
    const a = Math.random() * Math.PI * 2, d = 650 + Math.random() * 250;
    const p = offset(S.pos, Math.cos(a) * d, Math.sin(a) * d);
    if (!center || dist(p, center) < r * 0.9) return p;
  }
  return center ? offset(center, 0, 0) : offset(S.pos, 800, 0);
}

export function vetoContract() {
  const m = S.my;
  if (!m || !m.contract) return;
  const card = DECK.find(d => d.id === m.contract.id);
  m.contract = null;
  m.cooldownUntil = net.now() + settings().cardCooldownMin * 60e3;
  notify(`You dropped "${card.title}". Next contract in ${settings().cardCooldownMin} minutes.`, 'info');
  push();
}

function completeContract() {
  const m = S.my, card = DECK.find(d => d.id === m.contract.id);
  m.coins += card.reward; m.stats.earned += card.reward; m.stats.contracts++;
  m.contract = null;
  m.cooldownUntil = net.now() + settings().cardCooldownMin * 60e3;
  notify(`Contract complete: ${card.title}. +${card.reward} coins.`, 'good', { buzz: true, sound: 'coin' });
  sendEvent('contract', { title: card.title, reward: card.reward });
  push();
}

function failContract(why) {
  const m = S.my, card = DECK.find(d => d.id === m.contract.id);
  m.contract = null;
  m.cooldownUntil = net.now() + settings().cardCooldownMin * 60e3;
  notify(`Contract failed: ${card.title}. ${why}`, 'bad', { buzz: true });
  push();
}

// A rule broken for 5 seconds in a row fails the contract (absorbs GPS jitter)
function strike(c, broken, why) {
  if (broken) { c.outSec++; c.warn = why; if (c.outSec >= 5) { failContract(why); return true; } }
  else { c.outSec = 0; c.warn = null; }
  return false;
}

function contractTick(t) {
  const m = S.my, c = m.contract;
  if (!c) return;
  const card = DECK.find(d => d.id === c.id), el = (t - c.startedAt) / 1000;
  switch (c.kind) {
    case 'survive':
    case 'blind':
      c.progress = el / card.durationSec;
      if (el >= card.durationSec) completeContract();
      break;
    case 'statue':
      c.progress = (c.pings || 0) / card.pings;
      strike(c, dist(c.anchor, S.pos) > card.radiusM + tol(), `You moved more than ${card.radiusM} m.`);
      break;
    case 'hold':
      c.progress = el / card.durationSec;
      if (strike(c, dist(c.anchor, S.pos) > card.radiusM + tol(), `You moved more than ${card.radiusM} m.`)) return;
      if (el >= card.durationSec) completeContract();
      break;
    case 'den': {
      const d = nearestChaser(S.pos);
      if (!c.enteredAt) {
        c.progress = 0;
        if (d <= RADAR.danger) { c.enteredAt = t; notify('You are in the den. Stay within 250 m of them for 3 minutes.', 'warn'); }
        break;
      }
      if (strike(c, d > RADAR.caution, 'You left the den.')) return;
      c.progress = (t - c.enteredAt) / 1000 / card.durationSec;
      if (c.progress >= 1) completeContract();
      break;
    }
    case 'waypoint':
      c.left = dist(S.pos, c.target);
      c.progress = Math.max(0, 1 - c.left / 850);
      if (c.left <= card.radiusM + tol()) completeContract();
      else if (el > card.limitSec) failContract('Time ran out.');
      break;
    case 'distance':
      c.progress = (c.meters || 0) / card.meters;
      if (card.ring && settings().center && dist(S.pos, settings().center) > zoneRadius(t)) {
        if (strike(c, true, 'You left the zone.')) return;
      } else if (c.warn) { c.outSec = 0; c.warn = null; }
      if ((c.meters || 0) >= card.meters) completeContract();
      break;
    case 'box': {
      const pg = m.ping;
      if (!pg || pg.ghost || !pg.bounds) { c.waiting = true; c.progress = 0; break; }
      if (c.waiting || c.boxKey !== pg.key) { c.waiting = false; c.boxKey = pg.key; c.held = c.held || 0; }
      if (strike(c, !inBounds(S.pos, pg.bounds), 'You left your ping area.')) return;
      c.held = (c.held || 0) + 1;
      c.progress = c.held / card.durationSec;
      if (c.held >= card.durationSec) completeContract();
      break;
    }
  }
}

function countContractDistance() {
  const c = S.my.contract;
  if (!c || c.kind !== 'distance') return;
  const card = DECK.find(d => d.id === c.id), p = S.pos, t = net.now();
  if (!c.cp) { c.cp = { lat: p.lat, lng: p.lng, t }; return; }
  if (card.ring && settings().center) {
    const zd = dist(p, settings().center), R = zoneRadius(t);
    if (zd < R - 250) { c.cp = { lat: p.lat, lng: p.lng, t }; return; }   // inside: no credit
  }
  const d = dist(c.cp, p);
  if (d < 10) return;                                                     // jitter
  const speed = d / Math.max(0.5, (t - c.cp.t) / 1000);
  c.cp = { lat: p.lat, lng: p.lng, t };
  if (speed > 7.5) return;                                                // not on foot
  c.meters = (c.meters || 0) + d;
}

/* ---------------------------------------------------------------- events */
export async function sendEvent(type, payload = {}) {
  try {
    const ev = await net.insertEvent({ room_code: S.room.code, game_id: gameId(), type, actor_id: S.me.id, payload });
    addEvent(ev, false);
    return ev;
  } catch (e) {
    notify('Could not reach the server. Check your connection and try again.', 'bad');
    throw e;
  }
}

export function addEvent(ev, live) {
  if (!ev || ev.game_id !== gameId() || S.events.some(e => e.id === ev.id)) return false;
  S.events.push(ev);
  S.events.sort((a, b) => a.id - b.id);
  if (live) announce(ev);
  applyEvents();
  render();
  return true;
}

// Effects of other players' actions on me. Each event is applied once.
export function applyEvents() {
  const m = S.my;
  if (!m || m.gid !== gameId()) return;
  let changed = false;
  for (const e of S.events) {
    if (m.evDone.includes(e.id)) continue;
    m.evDone.push(e.id); changed = true;
    const p = e.payload || {};
    if (e.type === 'catch') {
      if (p.runner === S.me.id) {
        m.status = 'CAUGHT'; m.contract = null;
        if (settings().mode === 'ZOMBIES') { S.myTeam = 'CHASER'; m.status = 'ALIVE'; m.code = null; }
      }
      if (p.chaser === S.me.id) { m.coins += p.payout; m.stats.earned += p.payout; m.stats.catches++; }
      else if ((p.assists || []).includes(S.me.id)) { m.coins += p.assist; m.stats.earned += p.assist; }
      if ((p.survivors || []).includes(S.me.id)) { m.coins += p.split; m.stats.earned += p.split; }
    } else if (e.type === 'freeze' && p.target === S.me.id) {
      m.frozenUntil = evTime(e) + FREEZE_MS;
      m.freezeAnchor = S.pos ? { lat: S.pos.lat, lng: S.pos.lng } : null;
    } else if (e.type === 'recon' && e.actor_id === S.me.id) {
      const first = S.events.find(x => x.type === 'recon' && x.payload.key === p.key);
      if (first && first.id === e.id) { m.coins += 75; m.stats.earned += 75; }
    }
  }
  if (changed) push();
}

// Live notification for an event that just arrived
function announce(e) {
  const p = e.payload || {}, mine = e.actor_id === S.me.id, team = myTeam();
  const name = id => (S.players.get(id) || {}).callsign || 'Someone';
  switch (e.type) {
    case 'catch':
      if (p.runner === S.me.id) notify(settings().mode === 'ZOMBIES' ? `${name(p.chaser)} caught you. You are a chaser now.` : `${name(p.chaser)} caught you. You are out.`, 'bad', { buzz: true, sound: 'alert' });
      else notify(`${name(p.chaser)} caught ${name(p.runner)}.`, team === 'CHASER' ? 'good' : 'bad', { buzz: true, sound: 'alert' });
      break;
    case 'freeze':
      if (p.target === S.me.id) notify('You are frozen. Stay within 15 m for 2 minutes or your location is shown for 5.', 'bad', { buzz: true, sound: 'alert' });
      else if (!mine && p.team !== team) notify(`The ${p.team === 'RUNNER' ? 'runners' : 'chasers'} used a freeze.`, 'warn');
      break;
    case 'sweep':
      if (team === 'RUNNER') notify('Counter-sweep: all chasers are visible for 30 seconds.', 'good', { sound: 'ping' });
      else notify('The runners used a power-up.', 'warn');
      break;
    case 'ping_now':
      if (team === 'CHASER' && !mine) notify('A chaser triggered an instant ping.', 'good');
      if (team === 'RUNNER') notify('Chasers triggered an instant ping.', 'warn');
      break;
    case 'powerup': case 'precision': case 'trail':
      if (p.team !== team) notify(`The ${p.team === 'RUNNER' ? 'runners' : 'chasers'} used a power-up.`, 'warn');
      else if (!mine && e.type === 'trail') notify('A trail is on the map for 3 minutes.', 'good');
      break;
    case 'recon':
      if (!mine && team === 'CHASER') notify(`${name(e.actor_id)} reached a ping area.`, 'info');
      break;
  }
}

/* --------------------------------------------------------------- actions */
export async function buy(itemId, opt = {}) {
  const m = S.my, team = myTeam(), item = SHOP[team].find(i => i.id === itemId), t = net.now();
  if (!m || !item || amOut()) return;
  if (m.coins < item.price) { notify(`You need ${item.price - Math.floor(m.coins)} more coins.`, 'bad'); return; }
  if (item.target && !opt.target) { notify('Pick who to freeze first.', 'bad'); return; }
  m.coins -= item.price;
  try {
    if (team === 'RUNNER') {
      if (itemId === 'ticket') { m.tickets[opt.mode] = (m.tickets[opt.mode] || 0) + 1; notify('Ticket added.', 'good'); await sendEvent('powerup', { team, item: itemId }); }
      if (itemId === 'sweep') await sendEvent('sweep', { team });
      if (itemId === 'ghost') { m.ghost = true; notify('Ghost ready. You will be left out of the next ping.', 'good'); await sendEvent('powerup', { team, item: itemId }); }
      if (itemId === 'decoy') { m.decoy = true; notify('Decoy ready. Your next ping will show a fake second area.', 'good'); await sendEvent('powerup', { team, item: itemId }); }
      if (itemId === 'freeze') { await sendEvent('freeze', { team, target: opt.target }); notify(`${(S.players.get(opt.target) || {}).callsign} is frozen for 2 minutes.`, 'good'); }
    } else {
      if (itemId === 'ping') await sendEvent('ping_now', { team });
      if (itemId === 'precision') { await sendEvent('precision', { team }); notify('The next ping areas will be half the size.', 'good'); }
      if (itemId === 'trail') {
        const pts = makeTrail();
        if (!pts) { m.coins += item.price; notify('No runner has a trail yet. Try after the first ping.', 'info'); return; }
        await sendEvent('trail', { team, points: pts });
      }
      if (itemId === 'bloodhound') { m.houndUntil = t + 180e3; S.ui.hound = 'steady'; notify('Bloodhound on. Move and watch warmer or colder.', 'good'); await sendEvent('powerup', { team, item: itemId }); }
      if (itemId === 'freeze') { await sendEvent('freeze', { team, target: opt.target }); notify(`${(S.players.get(opt.target) || {}).callsign} is frozen for 2 minutes.`, 'good'); }
    }
  } catch (e) { m.coins += item.price; }
  push();
}

function makeTrail() {
  const rs = players().filter(p => isAliveRunner(p) && current(p) && p.data.prevPing && posOf(p));
  if (!rs.length) return null;
  const r = rs[Math.floor(Math.random() * rs.length)], a = r.data.prevPing, b = posOf(r);
  const d = dist(a, b), k = d > 120 ? 120 / d : 1;
  const end = { lat: a.lat + (b.lat - a.lat) * k, lng: a.lng + (b.lng - a.lng) * k };
  return [[a.lat, a.lng], [(a.lat + end.lat) / 2, (a.lng + end.lng) / 2], [end.lat, end.lng]];
}

export function useTicket(mode) {
  const m = S.my, t = net.now();
  if (!m || !(m.tickets[mode] > 0) || (m.transit && m.transit.until > t)) return;
  m.tickets[mode]--;
  m.transit = { mode, until: t + TRANSIT_MS };
  if (m.contract && m.contract.kind === 'distance' && DECK.find(d => d.id === m.contract.id).noTransit) failContract('You used a ticket.');
  notify(`${TRANSPORT.find(x => x.id === mode).name} ticket active for 20 minutes.`, 'good');
  push();
}

export async function catchRunner(runnerId) {
  const runner = S.players.get(runnerId);
  if (!runner || !isAliveRunner(runner) || myTeam() !== 'CHASER' || amOut()) return false;
  const st = settings();
  const assist = Math.round(st.bounty * 0.1), payout = st.bounty + assist;
  const assists = players().filter(p => p.id !== S.me.id && teamOf(p) === 'CHASER').map(p => p.id);
  const survivors = players().filter(p => p.id !== runnerId && isAliveRunner(p)).map(p => p.id);
  const split = survivors.length ? Math.round(payout / survivors.length) : 0;
  await sendEvent('catch', { runner: runnerId, chaser: S.me.id, payout, assist, assists, split, survivors });
  return true;
}

export function catchByCode(code) {
  const r = players().find(p => isAliveRunner(p) && current(p) && p.data.code === code);
  if (!r) { notify('That code does not match any runner still in the game.', 'bad'); return false; }
  return catchRunner(r.id);
}

export function taggable() {
  if (!S.pos || myTeam() !== 'CHASER') return [];
  return players().filter(p => isAliveRunner(p) && dist(S.pos, posOf(p)) <= TAG_RANGE_M);
}

/* ------------------------------------------------------------------- end */
export function outcome() {
  const runnersEver = players().filter(p => p.team === 'RUNNER' || caughtSet().has(p.id)).length;
  const alive = players().filter(isAliveRunner).length;
  if (runnersEver === 0) return { winner: null, alive };
  return { winner: alive > 0 ? 'RUNNER' : 'CHASER', alive, runnersEver };
}

export function allRunnersCaught() {
  const o = outcome();
  return o.runnersEver > 0 && o.alive === 0;
}
