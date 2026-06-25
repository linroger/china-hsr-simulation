// Resolve a runtime asset/endpoint against the deployment base path. The app is
// served at "/" locally (Vite dev + the zero-dependency static server) and at
// "/china-hsr-simulation/" on GitHub Pages. Routing every fetch through
// withBase() keeps the same bundle correct in both cases.
export function withBase(path) {
  const base = import.meta.env.BASE_URL || '/';
  return `${base.replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`;
}
