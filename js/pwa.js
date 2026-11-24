// "Add to home screen" support: service worker, Android install prompt, iOS instructions.
let deferred = null;
const listeners = new Set();
export const onChange = fn => listeners.add(fn);
const fire = () => listeners.forEach(fn => { try { fn(); } catch (e) {} });

export const isStandalone = () =>
  (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;

export function platform() {
  const ua = navigator.userAgent || '';
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios) return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? 'ios-other' : 'ios-safari';
  if (/Android/.test(ua)) return /Firefox/.test(ua) ? 'android-firefox' : 'android';
  return 'desktop';
}

export const canPrompt = () => !!deferred;

export async function promptInstall() {
  if (!deferred) return 'unavailable';
  const d = deferred; deferred = null;
  try { d.prompt(); const r = await d.userChoice; fire(); return r.outcome; } catch (e) { fire(); return 'unavailable'; }
}

export function steps() {
  const p = platform();
  if (p === 'ios-safari') return {
    title: 'Add Manhunt to your home screen',
    items: ['Tap the Share button (the square with an arrow) in Safari’s toolbar.', 'Scroll down and tap Add to Home Screen.', 'Tap Add. Open Manhunt from your home screen.']
  };
  if (p === 'ios-other') return {
    title: 'Open this page in Safari first',
    items: ['On iPhone and iPad, only Safari can add web apps to the home screen (newer iOS versions also allow it from other browsers’ Share menu).', 'Open this page in Safari, tap Share, then Add to Home Screen.']
  };
  if (p === 'android') return {
    title: 'Add Manhunt to your home screen',
    items: ['Tap the ⋮ menu in your browser.', 'Tap Install app or Add to Home screen.', 'Confirm. Open Manhunt from your home screen.']
  };
  if (p === 'android-firefox') return {
    title: 'Add Manhunt to your home screen',
    items: ['Tap the ⋮ menu in Firefox.', 'Tap Install, then confirm.']
  };
  return {
    title: 'Install Manhunt',
    items: ['Manhunt is made for phones. Open this page on your phone and use Add to Home Screen from the browser menu.', 'On desktop Chrome or Edge, look for the install icon in the address bar.']
  };
}

window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; fire(); });
window.addEventListener('appinstalled', () => { deferred = null; fire(); });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
