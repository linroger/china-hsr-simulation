import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

const PUBLIC_MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || '';
const MAPBOX_STYLE = import.meta.env.VITE_MAPBOX_STYLE || 'mapbox://styles/mapbox/dark-v11';

export default function HSRMap({ trains, events }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const currentTrainsRef = useRef([]);
  const previousTrainsRef = useRef([]);
  const targetTrainsRef = useRef([]);
  const transitionRef = useRef({ started: 0, duration: 140 });
  const frameRef = useRef(null);
  const animateRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (mapRef.current) return undefined;
    mapboxgl.accessToken = PUBLIC_MAPBOX_TOKEN;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: MAPBOX_STYLE,
      center: [104.2, 35.8],
      zoom: 3.7,
      minZoom: 3,
      maxZoom: 12,
      pitch: 24,
      attributionControl: false,
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: true }), 'bottom-right');
    map.on('load', () => {
      map.addSource('rails', { type: 'geojson', data: '/hsr-rails.geojson' });
      map.addLayer({
        id: 'rails',
        type: 'line',
        source: 'rails',
        paint: {
          'line-color': ['interpolate', ['linear'], ['zoom'], 3, '#3b82f6', 9, '#06b6d4'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.7, 8, 2.3, 12, 5],
          'line-opacity': 0.58,
        },
      });
      map.addSource('stations', { type: 'geojson', data: '/hsr-stations.geojson' });
      map.addLayer({
        id: 'local-station-dots',
        type: 'circle',
        source: 'stations',
        filter: ['==', ['get', 'tier'], 'local'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 0.8, 7, 1.7, 11, 3],
          'circle-color': '#64748b',
          'circle-opacity': 0.48,
          'circle-stroke-color': '#e2e8f0',
          'circle-stroke-width': 0.25,
        },
      });
      map.addLayer({
        id: 'regional-station-squares',
        type: 'symbol',
        source: 'stations',
        filter: ['==', ['get', 'tier'], 'regional-hub'],
        layout: {
          'text-field': '▪',
          'text-size': ['interpolate', ['linear'], ['zoom'], 3, 8, 7, 12, 11, 17],
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#06b6d4',
          'text-halo-color': '#082f49',
          'text-halo-width': 0.8,
        },
      });
      map.addLayer({
        id: 'national-station-diamonds',
        type: 'symbol',
        source: 'stations',
        filter: ['==', ['get', 'tier'], 'national-hub'],
        layout: {
          'text-field': '◆',
          'text-size': ['interpolate', ['linear'], ['zoom'], 3, 9, 7, 14, 11, 20],
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#f59e0b',
          'text-halo-color': '#451a03',
          'text-halo-width': 1,
        },
      });
      map.addSource('trains', { type: 'geojson', data: trainGeojson(trains) });
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
        minzoom: 7.2,
        layout: {
          'text-field': ['get', 'code'],
          'text-size': 10,
          'text-offset': [0, 1.7],
          'text-anchor': 'top',
        },
        paint: {
          'text-color': '#e0f2fe',
          'text-halo-color': '#020617',
          'text-halo-width': 2,
        },
      });
      map.on('click', 'train-circles', (event) => {
        const feature = event.features?.[0];
        if (!feature) return;
        const p = feature.properties;
        new mapboxgl.Popup({ offset: 18 })
          .setLngLat(feature.geometry.coordinates)
          .setHTML(`<div class="popup"><b>${p.code}</b><span>${p.current} to ${p.next}</span><span>Load ${(Number(p.load) * 100).toFixed(1)}% · ${p.pax}/${p.capacity}</span></div>`)
          .addTo(map);
      });
      mapRef.current = map;
      setReady(true);
    });
    map.on('error', (event) => setError(event.error?.message || 'Mapbox rendering error.'));
    return () => map.remove();
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
      mapRef.current.getSource('trains').setData(trainGeojson(rendered));
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
    const start = performance.now();
    previousTrainsRef.current = currentTrainsRef.current.length ? currentTrainsRef.current : trains;
    targetTrainsRef.current = trains;
    transitionRef.current = { started: start, duration: 150 };
    if (!frameRef.current) frameRef.current = requestAnimationFrame(animateRef.current);
  }, [ready, trains]);

  return (
    <div className="map-pane">
      <div ref={containerRef} className="mapbox-container" />
      {error && <div className="map-error">{error}</div>}
      <div className="map-legend">
        <b>Live algorithm map</b>
        <span><i className="rail" /> OSM rail layer</span>
        <span><i className="hub" /> National hub diamonds</span>
        <span><i className="regional" /> Regional hub squares</span>
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
    return {
      ...train,
      coords: {
        lng: previous.coords.lng + (train.coords.lng - previous.coords.lng) * progress,
        lat: previous.coords.lat + (train.coords.lat - previous.coords.lat) * progress,
      },
    };
  });
}

function easeInOut(value) {
  return value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2;
}
