// Supabase access: rooms, players, events, realtime, and a server-synced clock.
import { SUPABASE_URL, SUPABASE_KEY, SUPABASE_JS, CODE_ALPHABET } from './config.js';

let sb = null;
let clockOffset = 0;            // serverTime - localTime, in ms
let channel = null;

export async function init() {
  if (sb) return sb;
  const mod = await import(SUPABASE_JS);
  sb = mod.createClient(SUPABASE_URL, SUPABASE_KEY, { realtime: { params: { eventsPerSecond: 20 } } });
  syncClock();
  setInterval(syncClock, 60_000);
  return sb;
}

export const now = () => Date.now() + clockOffset;

export async function syncClock() {
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const { data, error } = await sb.rpc('server_now');
    const t1 = Date.now();
    if (error || !data) continue;
    samples.push({ rtt: t1 - t0, off: new Date(data).getTime() - (t0 + t1) / 2 });
  }
  if (samples.length) {
    samples.sort((a, b) => a.rtt - b.rtt);
    clockOffset = samples[0].off;
  }
}

function check({ data, error }) {
  if (error) throw new Error(error.message || 'Network error');
  return data;
}

function newCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return c;
}

export async function createRoom(hostId, settings) {
  for (let i = 0; i < 8; i++) {
    const { data, error } = await sb.from('rooms')
      .insert({ code: newCode(), host_id: hostId, phase: 'LOBBY', settings }).select().single();
    if (!error) return data;
    if (!/duplicate|unique/i.test(error.message)) throw new Error(error.message);
  }
  throw new Error('Could not create a room. Try again.');
}

export const getRoom = async code =>
  check(await sb.from('rooms').select('*').eq('code', code).maybeSingle());

export const updateRoom = async (code, patch) =>
  check(await sb.from('rooms').update(patch).eq('code', code).select().maybeSingle());

export const deleteRoom = async code => check(await sb.from('rooms').delete().eq('code', code));

export const startGame = async (code, hostId, settings, delay) =>
  check(await sb.rpc('start_game', { p_code: code, p_host: hostId, p_settings: settings, p_delay: delay }));

export const listPlayers = async code =>
  check(await sb.from('players').select('*').eq('room_code', code).order('joined_at'));

export const upsertPlayer = async row => check(await sb.from('players').upsert(row));
export const deletePlayer = async id => check(await sb.from('players').delete().eq('id', id));

export async function listEvents(code, gameId) {
  if (!gameId) return [];
  return check(await sb.from('events').select('*').eq('room_code', code).eq('game_id', gameId).order('id'));
}

export const insertEvent = async ev =>
  check(await sb.from('events').insert(ev).select().single());

export function subscribe(code, h) {
  unsubscribe();
  channel = sb.channel('room:' + code)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: 'code=eq.' + code }, p => h.room(p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: 'room_code=eq.' + code }, p => h.player(p))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events', filter: 'room_code=eq.' + code }, p => h.event(p.new))
    .subscribe(status => h.status && h.status(status));
}

export function unsubscribe() {
  if (channel) { try { sb.removeChannel(channel); } catch (e) {} channel = null; }
}
