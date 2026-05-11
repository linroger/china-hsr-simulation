const lineMetricCache = new WeakMap();

export function haversineKm(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export function interpolateCoord(a, b, progress) {
  const p = Math.max(0, Math.min(1, progress));
  return {
    lng: a.lng + (b.lng - a.lng) * p,
    lat: a.lat + (b.lat - a.lat) * p,
  };
}

export function interpolateLine(coordinates, progress) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return null;
  if (coordinates.length === 1) return { lng: coordinates[0][0], lat: coordinates[0][1] };
  const p = Math.max(0, Math.min(1, progress));
  const { segmentLengths, total } = lineMetrics(coordinates);
  if (total <= 0) return { lng: coordinates[0][0], lat: coordinates[0][1] };
  let target = total * p;
  for (let i = 0; i < segmentLengths.length; i += 1) {
    if (target <= segmentLengths[i]) {
      return interpolateCoord(
        { lng: coordinates[i][0], lat: coordinates[i][1] },
        { lng: coordinates[i + 1][0], lat: coordinates[i + 1][1] },
        segmentLengths[i] ? target / segmentLengths[i] : 0,
      );
    }
    target -= segmentLengths[i];
  }
  const last = coordinates[coordinates.length - 1];
  return { lng: last[0], lat: last[1] };
}

function lineMetrics(coordinates) {
  const cached = lineMetricCache.get(coordinates);
  if (cached) return cached;
  const segmentLengths = [];
  let total = 0;
  for (let i = 0; i < coordinates.length - 1; i += 1) {
    const length = haversineKm(
      { lng: coordinates[i][0], lat: coordinates[i][1] },
      { lng: coordinates[i + 1][0], lat: coordinates[i + 1][1] },
    );
    segmentLengths.push(length);
    total += length;
  }
  const metrics = { segmentLengths, total };
  lineMetricCache.set(coordinates, metrics);
  return metrics;
}

function toRad(value) {
  return value * Math.PI / 180;
}
