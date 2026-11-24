// Leaflet wrapper: one keyed layer set per map, updated from a plain view model.
/* global L */

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

export function createMap(el, { center, zoom = 15, interactive = true, onTap } = {}) {
  const map = L.map(el, {
    zoomControl: false, attributionControl: true,
    dragging: interactive, touchZoom: interactive, scrollWheelZoom: interactive,
    doubleClickZoom: interactive, boxZoom: false, keyboard: interactive, tap: true
  }).setView(center ? [center.lat, center.lng] : [44.8154, 20.4522], zoom);
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTR, className: 'tiles' }).addTo(map);
  map.attributionControl.setPrefix(false);
  if (onTap) map.on('click', e => onTap({ lat: e.latlng.lat, lng: e.latlng.lng }));
  const layers = new Map();
  // Leaflet needs a size check after the container is laid out or rotated
  const ro = new ResizeObserver(() => map.invalidateSize());
  ro.observe(el);
  return { map, layers, destroy() { ro.disconnect(); map.remove(); } };
}

function dot(cls, label) {
  return L.divIcon({
    className: 'pin ' + cls,
    html: `<span class="pin-dot"></span>${label ? `<span class="pin-label">${label}</span>` : ''}`,
    iconSize: [18, 18], iconAnchor: [9, 9]
  });
}

// items: [{ key, type, ... }]. Types: zone, player, rect, ring, line, flag
export function draw(m, items) {
  const seen = new Set();
  for (const it of items) {
    seen.add(it.key);
    let l = m.layers.get(it.key);
    const sig = JSON.stringify(it);
    if (l && l._sig === sig) continue;
    if (l && it.type === 'player' && l._type === 'player') {
      l.setLatLng([it.lat, it.lng]);
      if (l._cls !== it.cls + it.label) { l.setIcon(dot(it.cls, it.label)); l._cls = it.cls + it.label; }
      l._sig = sig; continue;
    }
    if (l) { l.remove(); }
    switch (it.type) {
      case 'zone':
        l = L.circle([it.lat, it.lng], { radius: it.r, className: 'zone', interactive: false }); break;
      case 'ring':
        l = L.circle([it.lat, it.lng], { radius: it.r, className: 'ring ' + (it.cls || ''), interactive: false }); break;
      case 'rect':
        l = L.rectangle(it.bounds, { className: 'area ' + (it.cls || ''), interactive: false });
        if (it.label) l.bindTooltip(it.label, { permanent: true, direction: 'center', className: 'area-label' });
        break;
      case 'line':
        l = L.polyline(it.points, { className: 'trail', interactive: false }); break;
      case 'flag':
        l = L.marker([it.lat, it.lng], { icon: L.divIcon({ className: 'flag', html: '<span></span>', iconSize: [26, 26], iconAnchor: [13, 13] }), interactive: false }); break;
      case 'player':
        l = L.marker([it.lat, it.lng], { icon: dot(it.cls, it.label), interactive: false, zIndexOffset: it.z || 0 });
        l._cls = it.cls + it.label; break;
    }
    l._sig = sig; l._type = it.type;
    l.addTo(m.map);
    m.layers.set(it.key, l);
  }
  for (const [k, l] of m.layers) if (!seen.has(k)) { l.remove(); m.layers.delete(k); }
}
