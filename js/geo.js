// Geodesy helpers.
const R = 6371000;
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;

export function dist(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return Infinity;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function offset(p, north, east) {
  return {
    lat: p.lat + deg(north / R),
    lng: p.lng + deg(east / (R * Math.cos(rad(p.lat))))
  };
}

// Square ping area that contains the player but is never centred on them.
export function pingArea(p, size) {
  const sn = Math.random() < 0.5 ? -1 : 1, se = Math.random() < 0.5 ? -1 : 1;
  const c = offset(p, sn * (0.12 + Math.random() * 0.25) * size, se * (0.12 + Math.random() * 0.25) * size);
  const sw = offset(c, -size / 2, -size / 2), ne = offset(c, size / 2, size / 2);
  return { center: c, bounds: [[sw.lat, sw.lng], [ne.lat, ne.lng]], size: Math.round(size) };
}

export function inBounds(p, b) {
  return !!(p && b && p.lat >= b[0][0] && p.lat <= b[1][0] && p.lng >= b[0][1] && p.lng <= b[1][1]);
}

export function bearing(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function fmtDist(m) {
  if (!isFinite(m)) return '—';
  return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' km' : Math.round(m) + ' m';
}

export function fmtClock(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
