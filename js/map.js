// MapLibre wrapper: sharp vector map (OpenFreeMap) with overlays drawn into the map itself,
// so zones and ping areas scale smoothly while zooming. Same keyed-items API as before.
/* global maplibregl */
import { offset } from './geo.js';

const DARK = matchMedia('(prefers-color-scheme: dark)').matches;
const STYLE = `https://tiles.openfreemap.org/styles/${DARK ? 'dark' : 'positron'}`;
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function circle(c, r, n = 72) {
  const ring = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2, p = offset(c, Math.cos(a) * r, Math.sin(a) * r);
    ring.push([p.lng, p.lat]);
  }
  return ring;
}
const rectRing = b => [[b[0][1], b[0][0]], [b[1][1], b[0][0]], [b[1][1], b[1][0]], [b[0][1], b[1][0]], [b[0][1], b[0][0]]];

export function createMap(el, { center, zoom = 15, interactive = true, onTap } = {}) {
  const c = center || { lat: 44.8154, lng: 20.4522 };
  const map = new maplibregl.Map({
    container: el, style: STYLE, center: [c.lng, c.lat], zoom,
    interactive, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false,
    fadeDuration: 0
  });
  map.touchZoomRotate && map.touchZoomRotate.disableRotation();
  const m = { map, ready: false, pending: null, markers: new Map(), shapesSig: '' };

  map.on('load', () => {
    const col = { over: css('--overprint'), run: css('--runner'), chase: css('--chaser') };
    map.addSource('shapes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    const kind = k => ['==', ['get', 'kind'], k];
    map.addLayer({ id: 'fill', type: 'fill', source: 'shapes', filter: ['==', ['geometry-type'], 'Polygon'],
      paint: {
        'fill-color': ['match', ['get', 'kind'], 'task', col.run, 'freeze', col.chase, col.over],
        'fill-opacity': ['match', ['get', 'kind'], 'zone', 0.05, 'area', 0.13, 'own', 0.06, 'task', 0.1, 'freeze', 0.12, 0]
      } });
    map.addLayer({ id: 'line-solid', type: 'line', source: 'shapes',
      filter: ['any', kind('zone'), kind('task'), kind('freeze')],
      paint: { 'line-color': ['match', ['get', 'kind'], 'task', col.run, 'freeze', col.chase, col.over], 'line-width': 3 } });
    map.addLayer({ id: 'line-dash', type: 'line', source: 'shapes',
      filter: ['any', kind('area'), kind('own'), kind('end')],
      paint: { 'line-color': col.over, 'line-width': ['match', ['get', 'kind'], 'end', 2, 2.5],
        'line-opacity': ['match', ['get', 'kind'], 'own', 0.6, 1], 'line-dasharray': [3, 2] } });
    map.addLayer({ id: 'trail', type: 'line', source: 'shapes', filter: kind('trail'),
      layout: { 'line-cap': 'round' },
      paint: { 'line-color': col.over, 'line-width': 5, 'line-dasharray': [0.2, 2] } });
    m.ready = true;
    if (m.pending) { draw(m, m.pending); m.pending = null; }
  });
  if (onTap) map.on('click', e => onTap({ lat: e.lngLat.lat, lng: e.lngLat.lng }));

  const ro = new ResizeObserver(() => map.resize());
  ro.observe(el);

  m.center = () => { const p = map.getCenter(); return { lat: p.lat, lng: p.lng }; };
  m.zoom = () => map.getZoom();
  m.panTo = p => map.easeTo({ center: [p.lng, p.lat], duration: 600 });
  m.setView = (p, z) => map.easeTo({ center: [p.lng, p.lat], zoom: z, duration: 500 });
  m.fitCircle = (p, r, pad = 16) => {
    const ring = circle(p, r, 16), lngs = ring.map(x => x[0]), lats = ring.map(x => x[1]);
    map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: pad, duration: 500 });
  };
  m.onUserMove = fn => map.on('dragstart', fn);
  m.destroy = () => { ro.disconnect(); map.remove(); };
  return m;
}

function markerEl(cls, html) {
  const el = document.createElement('div');
  el.className = cls; el.innerHTML = html;
  return el;
}

// items: [{ key, type, ... }]. Types: zone, ring, rect, line (shapes) and player, flag (markers)
export function draw(m, items) {
  if (!m.ready) { m.pending = items; return; }
  const features = [], seen = new Set();

  for (const it of items) {
    if (it.type === 'zone' || it.type === 'ring') {
      const kind = it.type === 'zone' ? 'zone' : it.cls === 'ring-task' ? 'task' : it.cls === 'ring-freeze' ? 'freeze' : 'end';
      features.push({ type: 'Feature', properties: { kind }, geometry: { type: 'Polygon', coordinates: [circle(it, it.r)] } });
    } else if (it.type === 'rect') {
      features.push({ type: 'Feature', properties: { kind: it.cls === 'area-own' ? 'own' : 'area' }, geometry: { type: 'Polygon', coordinates: [rectRing(it.bounds)] } });
      if (it.label) {
        const top = { lat: it.bounds[1][0], lng: (it.bounds[0][1] + it.bounds[1][1]) / 2 };
        marker(m, seen, 'lbl' + it.key, top, 'area-label', it.label, 'top');
      }
    } else if (it.type === 'line') {
      features.push({ type: 'Feature', properties: { kind: 'trail' }, geometry: { type: 'LineString', coordinates: it.points.map(p => [p[1], p[0]]) } });
    } else if (it.type === 'player') {
      marker(m, seen, it.key, it, 'pin ' + it.cls, `<span class="pin-dot"></span>${it.label ? `<span class="pin-label">${it.label}</span>` : ''}`, 'center');
    } else if (it.type === 'flag') {
      marker(m, seen, it.key, it, 'flag', '<span></span>', 'center');
    }
  }

  const sig = JSON.stringify(features);
  if (sig !== m.shapesSig) { m.shapesSig = sig; m.map.getSource('shapes').setData({ type: 'FeatureCollection', features }); }
  for (const [k, mk] of m.markers) if (!seen.has(k)) { mk.remove(); m.markers.delete(k); }
}

function marker(m, seen, key, p, cls, html, anchor) {
  seen.add(key);
  let mk = m.markers.get(key);
  if (!mk) {
    mk = new maplibregl.Marker({ element: markerEl(cls, html), anchor }).setLngLat([p.lng, p.lat]).addTo(m.map);
    mk._cls = cls; mk._html = html;
    m.markers.set(key, mk);
    return;
  }
  const ll = mk.getLngLat();
  if (ll.lng !== p.lng || ll.lat !== p.lat) mk.setLngLat([p.lng, p.lat]);
  const el = mk.getElement();
  // maplibre adds its own classes to the element; keep them and swap ours
  if (mk._cls !== cls) { mk._cls.split(' ').forEach(c => c && el.classList.remove(c)); cls.split(' ').forEach(c => c && el.classList.add(c)); mk._cls = cls; }
  if (mk._html !== html) { el.innerHTML = html; mk._html = html; }
}
