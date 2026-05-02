import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

const PUBLIC_MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || '';
const MAPBOX_STYLE = import.meta.env.VITE_MAPBOX_STYLE || 'mapbox://styles/linroger023/cmoo6ced0003m01sa25xq2hig';

export default function HSRMap({ trains, events }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
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
        id: 'stations',
        type: 'circle',
        source: 'stations',
        paint: {
          'circle-radius': ['case', ['==', ['get', 'tier'], 'national-hub'], 4.8, ['==', ['get', 'tier'], 'regional-hub'], 3.1, 1.8],
          'circle-color': ['case', ['==', ['get', 'tier'], 'national-hub'], '#f59e0b', ['==', ['get', 'tier'], 'regional-hub'], '#22c55e', '#93c5fd'],
          'circle-opacity': 0.78,
          'circle-stroke-color': '#06111f',
          'circle-stroke-width': 0.7,
        },
      });
      map.addSource('trains', { type: 'geojson', data: trainGeojson(trains) });
      map.addLayer({
        id: 'train-circles',
        type: 'circle',
        source: 'trains',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'load'], 0, 7, 1, 15],
          'circle-color': ['interpolate', ['linear'], ['get', 'load'], 0, '#10b981', 0.72, '#f59e0b', 0.95, '#ef4444'],
          'circle-stroke-width': 2.5,
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
          'text-size': 11,
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
    if (!ready || !mapRef.current?.getSource('trains')) return;
    mapRef.current.getSource('trains').setData(trainGeojson(trains));
  }, [ready, trains]);

  return (
    <div className="map-pane">
      <div ref={containerRef} className="mapbox-container" />
      {error && <div className="map-error">{error}</div>}
      <div className="map-legend">
        <b>Live algorithm map</b>
        <span><i className="rail" /> OSM rail layer</span>
        <span><i className="hub" /> National hubs</span>
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
