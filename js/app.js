// App controller: session, room lifecycle, routing between screens, GPS, sound, wake lock.
import { S, save, render, onRender, SIM } from './state.js';
import * as net from './net.js';
import * as E from './engine.js';
import * as UI from './ui.js';
import { DEFAULT_SETTINGS, COUNTDOWN_SEC } from './config.js';

/* ------------------------------------------------------------- feedback */
let audio = null;
function beep(kind) {
  if (!S.sound) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
    const f = { ping: [880, 520], coin: [990, 1320], alert: [520, 760], tick: [660, 660], go: [520, 1040] }[kind] || [700, 700];
    o.type = 'sine';
    o.frequency.setValueAtTime(f[0], t); o.frequency.exponentialRampToValueAtTime(f[1], t + 0.25);
    g.gain.setValueAtTime(0.15, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + 0.32);
  } catch (e) {}
}

function notify(text, tone = 'info', opts = {}) {
  UI.pushToast(text, tone);
  if (opts.buzz && navigator.vibrate) navigator.vibrate([120, 60, 120]);
  if (opts.sound) beep(opts.sound);
}

let wakeLock = null;
async function keepAwake() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch (e) {}
}

/* ------------------------------------------------------------------ GPS */
let watchId = null;
function startGps() {
  if (SIM) {
    if (!S.pos) {
      const c = E.settings().center || { lat: 44.8154, lng: 20.4522 };
      E.onPosition({ lat: c.lat + (Math.random() - 0.5) * 0.004, lng: c.lng + (Math.random() - 0.5) * 0.006, acc: 5 });
    }
    return;
  }
  if (watchId != null) return;
  if (!navigator.geolocation) { S.gpsError = 'This browser cannot share your location.'; return render(); }
  watchId = navigator.geolocation.watchPosition(p => {
    const acc = p.coords.accuracy;
    if (S.pos && acc > 150) return;                 // ignore very rough fixes once we have a good one
    S.gpsError = null;
    E.onPosition({ lat: p.coords.latitude, lng: p.coords.longitude, acc });
  }, err => {
    S.gpsError = err.code === 1
      ? 'Location is blocked. Allow location for this site in your browser settings, then reload.'
      : 'Cannot get your location. Check that location services are on and try open sky.';
    render();
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
}

/* ----------------------------------------------------------------- room */
function ensureGameData() {
  if (!S.room) return;
  const gid = S.room.game_id;
  if (gid && S.room.phase !== 'LOBBY') {
    if (!S.my || S.my.gid !== gid) { S.my = E.freshGameData(); E.push(); }
  } else if (S.my) { S.my = null; E.push(); }
}

async function loadEvents() {
  const gid = S.room && S.room.game_id;
  const list = gid ? await net.listEvents(S.room.code, gid) : [];
  if (!S.room || S.room.game_id !== gid) return;
  list.forEach(ev => E.addEvent(ev, false));
}

async function enterRoom(code) {
  const room = await net.getRoom(code);
  if (!room) throw new Error(`There is no game with the code ${code}. Check the code and try again.`);
  S.room = room;
  const rows = await net.listPlayers(code);
  S.players = new Map(rows.map(r => [r.id, r]));
  const mine = S.players.get(S.me.id);
  if (mine) {
    S.myTeam = mine.team;
    if (mine.data && mine.data.gid && mine.data.gid === room.game_id) S.my = mine.data;
  } else if (room.phase !== 'LOBBY') {
    S.myTeam = 'CHASER';
  } else {
    const r = rows.filter(x => x.team === 'RUNNER').length, c = rows.filter(x => x.team === 'CHASER').length;
    S.myTeam = c < r ? 'CHASER' : 'RUNNER';
  }
  S.events = [];
  await loadEvents();
  S.session = { code }; save('session', S.session);
  net.subscribe(code, handlers);
  startGps();
  ensureGameData();
  await E.push();
  if (location.search.includes('join=')) history.replaceState(null, '', location.pathname + location.search.replace(/[?&]join=[^&]*/, '').replace(/^&/, '?'));
  route();
}

let resubTimer = null;
const handlers = {
  room(p) {
    if (!S.room) return;
    if (p.eventType === 'DELETE') { if (p.old && p.old.code === S.room.code) leaveLocal('The host closed the room.'); return; }
    const prev = S.room.game_id;
    S.room = p.new;
    if (S.room.game_id !== prev) { S.events = []; loadEvents(); }
    ensureGameData();
    route();
  },
  player(p) {
    if (p.eventType === 'DELETE') {
      // Supabase does not filter delete events by room, so only act on ids we know
      const id = p.old && p.old.id;
      if (!S.players.has(id)) return;
      if (id === S.me.id) return leaveLocal('The host removed you from the room.');
      S.players.delete(id);
    } else if (p.new.id === S.me.id) {
      const local = S.players.get(S.me.id);
      if (local) local.updated_at = p.new.updated_at;
    } else S.players.set(p.new.id, p.new);
    render();
  },
  event(row) { E.addEvent(row, true); },
  status(s) {
    if (s === 'SUBSCRIBED') { S.online = true; resync(); }
    if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') {
      S.online = false; render();
      clearTimeout(resubTimer);
      resubTimer = setTimeout(() => { if (S.room) net.subscribe(S.room.code, handlers); }, 3000);
    }
  }
};

async function resync() {
  if (!S.room) return;
  try {
    const room = await net.getRoom(S.room.code);
    if (!room) return leaveLocal('The host closed the room.');
    const gidChanged = room.game_id !== S.room.game_id;
    S.room = room;
    if (gidChanged) S.events = [];
    const rows = await net.listPlayers(room.code);
    if (!rows.some(r => r.id === S.me.id) && S.players.has(S.me.id) && rows.length) {
      // our row is missing (removed while offline)
      return leaveLocal('You were removed from the room.');
    }
    const local = S.players.get(S.me.id);
    S.players = new Map(rows.map(r => [r.id, r]));
    if (local) S.players.set(S.me.id, { ...local, updated_at: (S.players.get(S.me.id) || local).updated_at });
    await loadEvents();
    ensureGameData();
    S.online = true;
  } catch (e) { S.online = false; }
  route();
}

function leaveLocal(msg) {
  net.unsubscribe();
  S.room = null; S.players = new Map(); S.events = []; S.my = null;
  S.session = null; save('session', null);
  UI.show('landing');
  if (msg) notify(msg, 'info');
}

/* --------------------------------------------------------------- routing */
let endWritten = false, activeWritten = false;
function route() {
  if (!S.room) return;
  ensureGameData();
  const ph = E.phase();
  const live = ph === 'headstart' || ph === 'hunt';
  const ended = ph === 'ended' || (live && E.allRunnersCaught());
  const name = ph === 'lobby' ? 'lobby' : ph === 'countdown' ? 'countdown' : ended ? 'results' : live ? 'game' : 'lobby';
  if (name !== UI.currentScreen()) {
    if (name === 'game') { S.ui.tab = 'map'; S.ui.follow = true; beep('go'); keepAwake(); }
    if (name === 'countdown') keepAwake();
    if (name === 'lobby') { endWritten = false; activeWritten = false; }
  }
  UI.show(name);

  if (E.isHost()) {
    if (live && S.room.phase === 'COUNTDOWN' && !activeWritten) { activeWritten = true; net.updateRoom(S.room.code, { phase: 'ACTIVE' }).catch(() => { activeWritten = false; }); }
    if (ended && S.room.phase !== 'ENDED' && !endWritten) { endWritten = true; net.updateRoom(S.room.code, { phase: 'ENDED' }).catch(() => { endWritten = false; }); }
  }
}

/* --------------------------------------------------------------- actions */
function readName() {
  const v = (document.getElementById('nameInput') || {}).value;
  const name = String(v ?? S.me.name).trim().replace(/\s+/g, ' ').slice(0, 14);
  if (!name) { UI.setError('Enter your name first.'); document.getElementById('nameInput')?.focus(); return null; }
  S.me.name = name; save('name', name);
  return name;
}

async function confirmBox(title, body, yes, danger) {
  return UI.modal({ title, body, actions: [{ label: yes, value: true, primary: !danger, danger }, { label: 'Cancel', value: false }] });
}

let settingsTimer = null;
const actions = {
  beep,
  async host() {
    if (!readName()) return;
    UI.show('loading');
    try {
      const room = await net.createRoom(S.me.id, { ...DEFAULT_SETTINGS });
      await enterRoom(room.code);
    } catch (e) { UI.show('landing'); UI.setError(e.message); }
  },
  goJoin() { if (readName()) UI.show('join'); },
  back() { UI.show('landing'); },
  async join(form) {
    const code = form.querySelector('#codeInput').value.trim().toUpperCase();
    if (code.length !== 4) return UI.setError('The code has 4 letters or numbers.');
    UI.setError('');
    const btn = form.querySelector('button'); btn.disabled = true; btn.textContent = 'Joining…';
    try { await enterRoom(code); }
    catch (e) { btn.disabled = false; btn.textContent = `Join as ${S.me.name}`; UI.setError(e.message); }
  },
  pickTeam({ team }) { if (S.room.phase !== 'LOBBY') return; S.myTeam = team; E.push(); render(); },
  async kick({ id }) {
    const p = S.players.get(id);
    if (await confirmBox(`Remove ${p ? p.callsign : 'this player'}?`, 'They can join again with the code.', 'Remove', true)) {
      S.players.delete(id); render();
      net.deletePlayer(id).catch(() => notify('Could not remove them. Try again.', 'bad'));
    }
  },
  async share() {
    const url = `${location.origin}${location.pathname}?join=${S.room.code}`;
    const text = `Join my Manhunt game. Code ${S.room.code}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Manhunt', text, url });
      else { await navigator.clipboard.writeText(`${text}: ${url}`); notify('Invite link copied.', 'good'); }
    } catch (e) {}
  },
  setSetting(k, v) {
    if (!E.isHost() || S.room.phase !== 'LOBBY') return;
    const st = { ...E.settings() };
    st[k] = (k === 'center' || k === 'mode') ? v : Number(v);
    if (st.zoneEndM >= st.zoneStartM) st.zoneEndM = Math.min(...[100, 200, 300, 500, 750, 1000].filter(x => x < st.zoneStartM));
    S.room = { ...S.room, settings: st };
    render();
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => net.updateRoom(S.room.code, { settings: S.room.settings }).catch(() => notify('Could not save settings. Check your connection.', 'bad')), 300);
  },
  setMode({ mode }) { actions.setSetting('mode', mode); },
  centerOnMe() { actions.setSetting('center', null); },
  async start(_, btn) {
    if (!E.isHost()) return;
    const st = { ...E.settings() };
    st.center = st.center || (S.pos && { lat: S.pos.lat, lng: S.pos.lng });
    if (!st.center) return notify('Place the zone on the map first.', 'bad');
    btn.disabled = true;
    beep('tick');                                   // unlocks audio on iOS while we have a tap
    try {
      clearTimeout(settingsTimer);
      const room = await net.startGame(S.room.code, S.me.id, st, COUNTDOWN_SEC);
      if (room) S.room = Array.isArray(room) ? room[0] : room;
      S.events = [];
      route();
    } catch (e) { btn.disabled = false; notify('Could not start the game. Check your connection and try again.', 'bad'); }
  },
  async leave() {
    const host = E.isHost(), live = S.room && S.room.phase !== 'LOBBY';
    const ok = await confirmBox(host ? 'End the room for everyone?' : 'Leave this game?',
      host ? 'Everyone will be sent back to the start screen.' : live ? 'You will be removed from the game in progress.' : '',
      host ? 'End room' : 'Leave', true);
    if (!ok) return;
    const code = S.room.code;
    try { host ? await net.deleteRoom(code) : await net.deletePlayer(S.me.id); } catch (e) {}
    leaveLocal();
  },
  async menu() {
    const host = E.isHost();
    const choice = await UI.modal({ title: 'Menu', actions: [
      { label: S.sound ? 'Turn sound off' : 'Turn sound on', value: 'sound' },
      ...(host ? [{ label: 'End the game for everyone', value: 'end', danger: true }] : []),
      { label: host ? 'Close the room' : 'Leave the game', value: 'leave', danger: !host },
      { label: 'Back to the game', value: null, primary: true }
    ] });
    if (choice === 'sound') { S.sound = !S.sound; save('sound', S.sound); notify(S.sound ? 'Sound on.' : 'Sound off.', 'info'); }
    if (choice === 'end' && await confirmBox('End the game now?', 'Everyone goes to the results.', 'End game', true)) net.updateRoom(S.room.code, { phase: 'ENDED' });
    if (choice === 'leave') actions.leave();
  },
  again() { if (E.isHost()) net.updateRoom(S.room.code, { phase: 'LOBBY', game_id: null, started_at: null }).catch(() => notify('Could not reset the room.', 'bad')); },
  draw() { E.drawContract(); render(); },
  async veto() { if (await confirmBox('Drop this contract?', 'You will have to wait before drawing another.', 'Drop it', true)) { E.vetoContract(); render(); } },
  ride({ mode }) { E.useTicket(mode); render(); },
  buy({ item }) { E.buy(item, { mode: UI.shopOpt('ticket'), target: UI.shopOpt(item) }); render(); },
  async tag({ id }) {
    const p = S.players.get(id);
    if (await confirmBox(`Tag ${p.callsign}?`, 'Only tag someone you have actually caught.', 'Tag', false)) E.catchRunner(id);
  },
  async catchCode(form) {
    const input = form.querySelector('input'), code = input.value.trim();
    if (!/^\d{4}$/.test(code)) return notify('Catch codes have 4 digits.', 'bad');
    if (await E.catchByCode(code)) input.value = '';
  },
  toggleCode() { S.ui.revealCode = !S.ui.revealCode; render(); },
  recenter() { UI.recenter(); },
  fitZone() { UI.fitZone(); },
  simMove(p) { E.onPosition({ ...p, acc: 5 }); }
};

/* ------------------------------------------------------------------ boot */
async function boot() {
  UI.init();
  UI.setActions(actions);
  E.setNotifier(notify);
  onRender(() => { if (S.room) route(); else UI.update(); });
  UI.show('loading');
  try { await net.init(); }
  catch (e) { UI.setLoading('Could not connect. Check your internet connection and reload.'); return; }

  if (S.session && S.session.code) {
    try { await enterRoom(S.session.code); }
    catch (e) { leaveLocal(); }
  } else UI.show(S.joinCode && S.me.name ? 'join' : 'landing');

  setInterval(() => { E.tick(); render(); }, 1000);
  setInterval(() => { if (UI.currentScreen() === 'countdown') render(); }, 200);
  setInterval(resync, 15000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { keepAwake(); resync(); }
  });
  window.addEventListener('online', resync);
}

boot();
