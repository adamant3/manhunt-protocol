// Static configuration: backend, defaults, contract deck, shop.

export const SUPABASE_URL = 'https://egwtbemyfbqnfzajdhof.supabase.co';
export const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVnd3RiZW15ZmJxbmZ6YWpkaG9mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU0NzA2NTcsImV4cCI6MjExMTA0NjY1N30.VXsxitgUtBqxI8bc2hZF24KqgXsYR_lKHIDJdplx_6I';
export const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

export const COUNTDOWN_SEC = 10;
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const RADAR = { caution: 250, danger: 100, extreme: 50 };
export const TAG_RANGE_M = 25;
export const STALE_MS = 90_000;        // runner not heard from this long: chasers see last known spot
export const OOB_GRACE_SEC = 60;
export const FREEZE_MS = 120_000;
export const FREEZE_RADIUS_M = 15;
export const BREACH_MS = 5 * 60_000;
export const TRANSIT_MS = 20 * 60_000;

// Host-editable settings (minutes / metres / coins)
export const DEFAULT_SETTINGS = {
  mode: 'ELIMINATION',      // or 'ZOMBIES'
  durationMin: 90,
  headstartMin: 10,
  pingMin: 10,
  pingSizeM: 500,
  zoneStartM: 2500,
  zoneEndM: 300,
  center: null,             // {lat,lng}; null = host's location at start
  startCoins: 150,
  bounty: 500,
  dripPerMin: 10,
  cardCooldownMin: 60
};

// Lobby choices: presets for quick picks, plus a custom value within [min, max]
export const SETTING_META = {
  durationMin: { options: [15, 30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 480, 720], min: 5, max: 720, unit: 'minutes' },
  headstartMin: { options: [0, 1, 2, 3, 5, 10, 15, 20, 30, 45, 60], min: 0, max: 180, unit: 'minutes' },
  pingMin: { options: [1, 2, 3, 5, 8, 10, 15, 20, 30, 45, 60], min: 1, max: 180, unit: 'minutes' },
  pingSizeM: { options: [100, 200, 300, 400, 500, 750, 1000, 1500, 2000], min: 50, max: 10000, unit: 'metres' },
  zoneStartM: { options: [300, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000], min: 100, max: 50000, unit: 'metres' },
  zoneEndM: { options: [50, 100, 200, 300, 500, 750, 1000, 1500, 2000], min: 25, max: 50000, unit: 'metres' },
  startCoins: { options: [0, 100, 150, 250, 300, 500, 1000], min: 0, max: 100000, unit: 'coins' },
  bounty: { options: [100, 250, 500, 750, 1000, 1500, 2000], min: 0, max: 100000, unit: 'coins' },
  dripPerMin: { options: [0, 5, 10, 15, 20, 30, 50], min: 0, max: 1000, unit: 'coins a minute' },
  cardCooldownMin: { options: [0, 5, 10, 15, 20, 30, 45, 60, 90, 120], min: 0, max: 600, unit: 'minutes' }
};

export const TRANSPORT = [
  { id: 'bus', name: 'Bus', icon: '🚌' },
  { id: 'tram', name: 'Tram or trolley', icon: '🚋' },
  { id: 'train', name: 'Train or metro', icon: '🚆' },
  { id: 'bike', name: 'Bike or scooter', icon: '🚲' },
  { id: 'ferry', name: 'Ferry or boat', icon: '⛴️' }
];

// Runner contracts. Every one is verified by GPS; none can be claimed by hand.
// kind drives the engine logic in engine.js.
export const DECK = [
  { id: 'flare', title: 'Flare gun', reward: 800, kind: 'survive', durationSec: 600,
    desc: 'Your exact location is shown to every chaser for 10 seconds. Then stay uncaught for 10 minutes.' },
  { id: 'statue', title: 'Statue', reward: 650, kind: 'statue', pings: 2, radiusM: 30,
    desc: 'Stay within 30 m of where you are now through the next two pings.' },
  { id: 'den', title: "Lion's den", reward: 750, kind: 'den', durationSec: 180,
    desc: 'Get within 100 m of a chaser, then stay within 250 m of them for 3 minutes.' },
  { id: 'deaddrop', title: 'Dead drop', reward: 600, kind: 'waypoint', radiusM: 25, limitSec: 1800,
    desc: 'A pin has been dropped about 800 m away. Reach it on foot within 30 minutes.' },
  { id: 'cafe', title: 'Plain sight', reward: 500, kind: 'hold', durationSec: 900, radiusM: 15,
    desc: 'Pick a café, bench or plaza and stay within 15 m of it for 15 minutes.' },
  { id: 'edge', title: 'Edge runner', reward: 550, kind: 'distance', meters: 800, ring: true,
    desc: 'Cover 800 m on foot in the outer 250 m of the zone. Leaving the zone fails the contract.' },
  { id: 'blind', title: 'Radio silence', reward: 500, kind: 'blind', durationSec: 900,
    desc: 'Your proximity radar and ping timer go dark for 15 minutes. Stay uncaught.' },
  { id: 'lookout', title: 'Lookout', reward: 600, kind: 'hold', durationSec: 600, radiusM: 50,
    desc: 'Stand at a bridge or big crossroads and stay within 50 m of it for 10 minutes.' },
  { id: 'sprint', title: 'On foot', reward: 650, kind: 'distance', meters: 600, noTransit: true,
    desc: 'Cover 600 m on foot. Using a transport ticket fails the contract.' },
  { id: 'boxhold', title: 'Hide in the box', reward: 700, kind: 'box', durationSec: 300,
    desc: 'Stay inside your current ping area for 5 minutes. Starts once you have a ping.' }
];

export const SHOP = {
  RUNNER: [
    { id: 'ticket', name: 'Transport ticket', price: 250, desc: 'One more ride of the type you pick.' },
    { id: 'sweep', name: 'Counter-sweep', price: 350, desc: 'Every runner sees all chasers for 30 seconds.' },
    { id: 'ghost', name: 'Ghost', price: 300, desc: 'You are left out of your next ping.' },
    { id: 'decoy', name: 'Decoy', price: 200, desc: 'Your next ping shows a second, fake area 400 m away.' },
    { id: 'freeze', name: 'Freeze a chaser', price: 800, desc: 'They must stay within 15 m for 2 minutes or be exposed for 5.', target: 'CHASER' }
  ],
  CHASER: [
    { id: 'ping', name: 'Instant ping', price: 350, desc: 'Every runner pings right now.' },
    { id: 'precision', name: 'Precision', price: 250, desc: 'The next ping areas are half the size.' },
    { id: 'trail', name: 'Trail', price: 300, desc: 'Shows up to 120 m of a random runner’s recent path.' },
    { id: 'bloodhound', name: 'Bloodhound', price: 200, desc: 'Warmer or colder towards the nearest runner for 3 minutes.' },
    { id: 'freeze', name: 'Freeze a runner', price: 800, desc: 'They must stay within 15 m for 2 minutes or be exposed for 5.', target: 'RUNNER' }
  ]
};
