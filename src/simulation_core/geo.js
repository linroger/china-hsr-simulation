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

function toRad(value) {
  return value * Math.PI / 180;
}
