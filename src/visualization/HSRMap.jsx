import { useEffect, useRef, useState } from 'react';
import { withBase } from '../basePath.js';

const PUBLIC_MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || '';
const MAPBOX_STYLE = import.meta.env.VITE_MAPBOX_STYLE || 'mapbox://styles/mapbox/dark-v11';
const HAS_VALID_TOKEN = PUBLIC_MAPBOX_TOKEN && PUBLIC_MAPBOX_TOKEN.startsWith('pk.') && !PUBLIC_MAPBOX_TOKEN.includes('replace_with_your');
// Tokenless fallback basemap: CARTO's free dark vector style needs no API key,
// so the live demo (and any clone without a Mapbox token) still gets a real map.
const FALLBACK_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const CJK_FONT = "'PingFang SC','Microsoft YaHei','Noto Sans CJK SC','Heiti SC',sans-serif";

// Load the map engine lazily so ~1.5 MB of GL code is split into its own chunk
// instead of inflating the initial bundle. Mapbox GL (which requires a token)
// is used when a public token is configured; otherwise we fall back to the
// API-compatible MapLibre GL with a free basemap.
async function loadMapEngine() {
  if (HAS_VALID_TOKEN) {
    const mod = await import('mapbox-gl');
    await import('mapbox-gl/dist/mapbox-gl.css');
    const mapboxgl = mod.default;
    mapboxgl.accessToken = PUBLIC_MAPBOX_TOKEN;
    return { gl: mapboxgl, style: MAPBOX_STYLE, engine: 'mapbox' };
  }
  const mod = await import('maplibre-gl');
  await import('maplibre-gl/dist/maplibre-gl.css');
  return { gl: mod.default, style: FALLBACK_STYLE, engine: 'maplibre' };
}

export default function HSRMap({ trains, events }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const glRef = useRef(null);
  const currentTrainsRef = useRef([]);
  const previousTrainsRef = useRef([]);
  const targetTrainsRef = useRef([]);
  // Transition duration matches the worker's 200 ms snapshot cadence so
  // markers glide continuously instead of moving for 100 ms and idling.
  const transitionRef = useRef({ started: 0, duration: 200 });
  const frameRef = useRef(null);
  const lastRenderRef = useRef(0);
  const animateRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [engineName, setEngineName] = useState('');

  useEffect(() => {
    let map;
    let cancelled = false;
    loadMapEngine()
      .then(({ gl, style, engine }) => {
        if (cancelled || !containerRef.current) return;
        glRef.current = gl;
        setEngineName(engine);
        try {
          map = new gl.Map({
            container: containerRef.current,
            style,
            center: [104.2, 35.8],
            zoom: 3.7,
            minZoom: 3,
            maxZoom: 12,
            pitch: 24,
            attributionControl: false,
            // Render Chinese station names with a locally rasterised CJK font so
            // labels work even when the basemap's glyph server lacks CJK ranges.
            localIdeographFontFamily: CJK_FONT,
          });
        } catch (constructError) {
          if (!cancelled) setError(constructError?.message || 'Failed to initialise the map.');
          return;
        }
        map.addControl(new gl.NavigationControl({ showCompass: true }), 'bottom-right');
        map.on('load', async () => {
          // Draw the rail network + stations from the committed GeoJSON so the
          // map is self-contained on ANY basemap style (not dependent on a
          // private custom style baking the layers in).
          await addNetworkLayers(map);
          addTrainLayers(map, gl, trains);
          mapRef.current = map;
          if (!cancelled) setReady(true);
        });
        map.on('error', (event) => {
          // Before first load, a style/token failure is fatal. After load, a
          // single failed tile or glyph request must NOT blank the whole map.
          if (!mapRef.current) {
            if (!cancelled) setError(event.error?.message || 'The map could not load.');
          } else if (event?.error?.message) {
            console.warn('[HSRMap] non-fatal map error:', event.error.message);
          }
        });
      })
      .catch((engineError) => {
        if (!cancelled) setError(engineError?.message || 'Map engine failed to load.');
      });
    return () => {
      cancelled = true;
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      if (map) map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    animateRef.current = (timestamp) => {
      if (!mapRef.current?.getSource('trains')) {
        frameRef.current = null;
        return;
      }
      const { started, duration } = transitionRef.current;
      const progress = Math.min(1, Math.max(0, (timestamp - started) / duration));
      const eased = easeInOut(progress);
      const rendered = interpolateTrainSet(previousTrainsRef.current, targetTrainsRef.current, eased);
      currentTrainsRef.current = rendered;
      // Throttle to 100ms to match snapshot interval and reduce GPU upload churn
      if (timestamp - lastRenderRef.current >= 100 || progress >= 1) {
        mapRef.current.getSource('trains').setData(trainGeojson(rendered));
        lastRenderRef.current = timestamp;
      }
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(animateRef.current);
      } else {
        frameRef.current = null;
      }
    };
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [ready]);

  useEffect(() => {
    if (!ready || !mapRef.current?.getSource('trains')) return;
    targetTrainsRef.current = trains;
    if (!frameRef.current) {
      // Start a new transition only if none is currently running.
      previousTrainsRef.current = currentTrainsRef.current.length ? currentTrainsRef.current : trains;
      transitionRef.current = { started: performance.now(), duration: 200 };
      frameRef.current = requestAnimationFrame(animateRef.current);
    }
    // If a transition is already in progress, it will naturally glide toward
    // the updated targetTrainsRef without restarting from the current position.
  }, [ready, trains]);

  if (error) {
    return (
      <div className="map-pane map-pane-fallback">
        <div className="map-token-warning">
          <h2>Map view unavailable</h2>
          <p>The map could not load: {error}</p>
          <p>The Dashboard and Booking views still work without the map — try those tabs. <strong>{(trains || []).length} trains</strong> are running in the simulation right now.</p>
        </div>
        <div className="map-events">
          <b>Recent events</b>
          {(events || []).slice(0, 8).map((event) => <span key={event.id}>{event.message}</span>)}
        </div>
      </div>
    );
  }

  return (
    <div className="map-pane">
      <div ref={containerRef} className="mapbox-container" />
      <div className="map-legend">
        <b>Live algorithm map</b>
        <span><i className="rail" /> Rail network{engineName === 'maplibre' ? ' (tokenless basemap)' : ''}</span>
        <span><i className="train-low" /> Low-load train</span>
        <span><i className="train-high" /> High-load train</span>
      </div>
      <div className="map-events">
        <b>Recent events</b>
        {(events || []).slice(0, 5).map((event) => <span key={event.id}>{event.message}</span>)}
      </div>
    </div>
  );
}

async function addNetworkLayers(map) {
  try {
    const [rails, stations] = await Promise.all([
      fetch(withBase('hsr-rails.geojson')).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(withBase('hsr-stations.geojson')).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (!map || !map.getStyle) return;
    if (rails && !map.getSource('rail-network')) {
      map.addSource('rail-network', { type: 'geojson', data: rails });
      map.addLayer({
        id: 'rail-lines',
        type: 'line',
        source: 'rail-network',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['case', ['==', ['get', 'hsr'], 1], '#38bdf8', '#64748b'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.4, 6, 1.3, 10, 3.4],
          'line-opacity': 0.55,
        },
      });
    }
    if (stations && !map.getSource('stations')) {
      map.addSource('stations', { type: 'geojson', data: stations });
      map.addLayer({
        id: 'station-dots',
        type: 'circle',
        source: 'stations',
        paint: {
          'circle-radius': [
            'match', ['get', 'tier'],
            'national-hub', ['interpolate', ['linear'], ['zoom'], 3, 2.6, 9, 7],
            'regional-hub', ['interpolate', ['linear'], ['zoom'], 3, 1.4, 9, 4.5],
            ['interpolate', ['linear'], ['zoom'], 3, 0.6, 9, 2],
          ],
          'circle-color': ['match', ['get', 'tier'], 'national-hub', '#fbbf24', 'regional-hub', '#22d3ee', '#64748b'],
          'circle-opacity': ['match', ['get', 'tier'], 'national-hub', 0.95, 'regional-hub', 0.8, 0.4],
          'circle-stroke-width': ['match', ['get', 'tier'], 'national-hub', 0.8, 0],
          'circle-stroke-color': '#0f172a',
        },
      });
      map.addLayer({
        id: 'station-labels',
        type: 'symbol',
        source: 'stations',
        minzoom: 5.5,
        filter: ['==', ['get', 'tier'], 'national-hub'],
        layout: {
          'text-field': ['get', 'name'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 5.5, 9, 9, 13],
          'text-offset': [0, 1.1],
          'text-anchor': 'top',
        },
        paint: {
          'text-color': '#e2e8f0',
          'text-halo-color': '#020617',
          'text-halo-width': 1.4,
          'text-opacity': ['interpolate', ['linear'], ['zoom'], 5.5, 0, 6.5, 0.9],
        },
      });
    }
  } catch (networkError) {
    console.warn('[HSRMap] rail/station layer load failed:', networkError?.message || networkError);
  }
}

function addTrainLayers(map, gl, trains) {
  map.addSource('trains', { type: 'geojson', data: trainGeojson(trains) });
  map.addLayer({
    id: 'corridor-heat',
    type: 'heatmap',
    source: 'trains',
    minzoom: 5,
    paint: {
      'heatmap-weight': ['interpolate', ['linear'], ['get', 'pax'], 0, 0, 100, 0.2, 400, 0.8],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 5, 0.15, 7, 0.5, 9, 1.0],
      'heatmap-color': [
        'interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(0,0,0,0)',
        0.1, 'rgba(59,130,246,0.2)',
        0.3, 'rgba(6,182,212,0.4)',
        0.6, 'rgba(245,158,11,0.5)',
        1, 'rgba(239,68,68,0.6)',
      ],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 5, 15, 7, 30, 9, 45],
      'heatmap-opacity': 0.4,
    },
  });
  map.addLayer({
    id: 'train-circles',
    type: 'circle',
    source: 'trains',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'load'], 0, 2.3, 1, 5.8],
      'circle-color': ['interpolate', ['linear'], ['get', 'load'], 0, '#10b981', 0.72, '#f59e0b', 0.95, '#ef4444'],
      'circle-stroke-width': 0.9,
      'circle-stroke-color': '#ffffff',
    },
  });
  map.addLayer({
    id: 'train-labels',
    type: 'symbol',
    source: 'trains',
    minzoom: 5,
    layout: {
      'text-field': ['get', 'code'],
      'text-size': 10,
      'text-offset': [0, 1.7],
      'text-anchor': 'top',
      'text-allow-overlap': ['step', ['zoom'], false, 9, true],
    },
    paint: {
      'text-color': '#e0f2fe',
      'text-halo-color': '#020617',
      'text-halo-width': 2,
      'text-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0, 6.5, 0.6, 8, 1],
    },
  });
  map.on('click', 'train-circles', (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    const p = feature.properties;
    new gl.Popup({ offset: 18 })
      .setLngLat(feature.geometry.coordinates)
      .setHTML(`<div class="popup"><b>${escapeHtml(p.code)}</b><span>${escapeHtml(p.direction)}: ${escapeHtml(p.current)} to ${escapeHtml(p.next)}</span><span>Load ${(Number(p.load) * 100).toFixed(1)}% · ${escapeHtml(p.pax)}/${escapeHtml(p.capacity)}</span></div>`)
      .addTo(map);
  });
  map.on('mouseenter', 'train-circles', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'train-circles', () => { map.getCanvas().style.cursor = ''; });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function trainGeojson(trains = []) {
  return {
    type: 'FeatureCollection',
    features: trains
      .filter((train) => train.coords && train.status !== 'completed')
      .map((train) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [train.coords.lng, train.coords.lat] },
        properties: {
          id: train.id,
          code: train.code,
          direction: train.direction || 'outbound',
          routeVariantId: train.routeVariantId || '',
          load: train.loadFactor,
          pax: train.passengerCount,
          capacity: train.capacity,
          current: train.currentStation,
          next: train.nextStation,
        },
    })),
  };
}

function interpolateTrainSet(previousTrains = [], targetTrains = [], progress = 1) {
  const previousById = new Map(previousTrains.map((train) => [train.id, train]));
  return targetTrains.map((train) => {
    const previous = previousById.get(train.id);
    if (!previous?.coords || !train.coords || previous.status !== train.status) return train;
    if (previous.routeVariantId && train.routeVariantId && previous.routeVariantId !== train.routeVariantId) return train;
    if (isRouteRegression(previous, train) || isLargeRouteJump(previous, train)) return train;
    return {
      ...train,
      coords: {
        lng: previous.coords.lng + (train.coords.lng - previous.coords.lng) * progress,
        lat: previous.coords.lat + (train.coords.lat - previous.coords.lat) * progress,
      },
    };
  });
}

function isRouteRegression(previous, train) {
  if (!Number.isFinite(previous.routeProgress) || !Number.isFinite(train.routeProgress)) return false;
  return train.routeProgress + 0.00001 < previous.routeProgress;
}

function isLargeRouteJump(previous, train) {
  const previousSegment = Number(previous.currentSegmentIndex);
  const currentSegment = Number(train.currentSegmentIndex);
  if (Number.isFinite(previousSegment) && Number.isFinite(currentSegment) && Math.abs(currentSegment - previousSegment) > 1) {
    return true;
  }
  const lngDelta = Math.abs((train.coords.lng || 0) - (previous.coords.lng || 0));
  const latDelta = Math.abs((train.coords.lat || 0) - (previous.coords.lat || 0));
  // Threshold lowered from 0.35° (~39 km) to 0.08° (~9 km) to catch more
  // coordinate jumps and snap trains to their route instead of drawing chords.
  return Math.max(lngDelta, latDelta) > 0.08;
}

function easeInOut(value) {
  return value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2;
}
