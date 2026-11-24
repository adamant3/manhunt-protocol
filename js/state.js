// Shared app state, local storage, and a render scheduler.

const params = new URLSearchParams(location.search);
// ?as=2 gives this tab its own identity (for testing several players in one browser)
const NS = 'mh2' + (params.get('as') ? ':' + params.get('as') : '');
export const SIM = params.has('sim');            // ?sim: tap the map to move instead of GPS

function load(k, d) { try { const v = localStorage.getItem(NS + ':' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
export function save(k, v) { try { v == null ? localStorage.removeItem(NS + ':' + k) : localStorage.setItem(NS + ':' + k, JSON.stringify(v)); } catch (e) {} }

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

let id = load('id', null);
if (!id) { id = uid(); save('id', id); }

export const S = {
  me: { id, name: load('name', '') },
  session: load('session', null),   // { code }
  joinCode: (params.get('join') || '').toUpperCase().slice(0, 4),
  screen: 'landing',
  room: null,
  players: new Map(),               // id -> row { id, callsign, team, data, updated_at }
  events: [],                       // events of the current game, by id
  my: null,                         // my own game data (I am its only writer)
  myTeam: 'RUNNER',
  pos: null,                        // { lat, lng, acc, t }
  gpsError: null,
  online: true,
  sound: load('sound', true),
  ui: { tab: 'map', hound: null, toasts: [], revealCode: false, follow: true }
};

const subs = new Set();
let queued = false;
export function onRender(fn) { subs.add(fn); }
export function render() {
  if (queued) return;
  queued = true;
  const run = () => { queued = false; subs.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); };
  // Hidden tabs get no animation frames, so fall back to a timer there
  document.hidden ? setTimeout(run, 0) : requestAnimationFrame(run);
}
