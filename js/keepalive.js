// Best-effort "stay on" helpers. A web page cannot truly run in the background; these keep it alive as long as the phone allows.
//  1. Screen wake lock: stops the screen from locking while the game is open.
//  2. Silent audio + media session: a quiet looping track makes phones treat the page as "playing media",
//     which usually keeps it (and its GPS) running with the screen off or in another app.
let lock = null, wanted = false, el = null, armed = false, bgOn = false;

export async function holdScreen() {
  wanted = true;
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || lock) return;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => { lock = null; });
  } catch (e) { lock = null; }
}
export function releaseScreen() { wanted = false; if (lock) { lock.release().catch(() => {}); lock = null; } }

function silentWav() {
  const rate = 8000, n = rate, buf = new Uint8Array(44 + n), v = new DataView(buf.buffer);
  const w = (o, s) => [...s].forEach((c, i) => buf[o + i] = c.charCodeAt(0));
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, 'data'); v.setUint32(40, n, true); buf.fill(128, 44);
  let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return 'data:audio/wav;base64,' + btoa(s);
}

function setMedia() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: 'Manhunt is running', artist: 'Game in progress', artwork: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }] });
    navigator.mediaSession.playbackState = 'playing';
    ['pause', 'stop'].forEach(a => { try { navigator.mediaSession.setActionHandler(a, () => el && el.play().catch(() => {})); } catch (e) {} });
  } catch (e) {}
}

function playNow() {
  if (!bgOn) return;
  if (!el) { el = new Audio(silentWav()); el.loop = true; el.volume = 0.01; el.setAttribute('playsinline', ''); }
  el.play().then(setMedia).catch(() => arm());
}

// Audio may only start after a tap, so wait for the next one if needed.
function arm() {
  if (armed) return;
  armed = true;
  const go = () => { armed = false; ['pointerdown', 'keydown', 'touchend'].forEach(t => removeEventListener(t, go, true)); playNow(); };
  ['pointerdown', 'keydown', 'touchend'].forEach(t => addEventListener(t, go, true));
}

export function startBackground() { bgOn = true; playNow(); }
export function stopBackground() {
  bgOn = false;
  if (el) { el.pause(); el = null; }
  if ('mediaSession' in navigator) { try { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; } catch (e) {} }
}
export const backgroundActive = () => bgOn && !!el && !el.paused;

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (wanted) holdScreen();
    if (bgOn && el && el.paused) el.play().catch(() => {});
  }
});
