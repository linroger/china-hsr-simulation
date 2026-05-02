#!/usr/bin/env node
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 5174);
const HOST = process.env.HOST || '127.0.0.1';

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('[serve] dist/index.html is missing. Run npm run build first.');
  process.exit(1);
}

const server = http.createServer((request, response) => {
  const parsed = new URL(request.url || '/', `http://${HOST}:${PORT}`);
  const safePath = decodeURIComponent(parsed.pathname || '/').replace(/^\/+/, '');
  const requested = path.resolve(DIST, safePath);
  const filePath = requested.startsWith(DIST) && fs.existsSync(requested) && fs.statSync(requested).isFile()
    ? requested
    : path.join(DIST, 'index.html');

  response.setHeader('Cache-Control', filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=300');
  response.setHeader('Content-Type', contentType(filePath));
  fs.createReadStream(filePath).pipe(response);
});

server.listen(PORT, HOST, () => {
  console.log(`[serve] China HSR Simulation available at http://${HOST}:${PORT}/`);
});

function contentType(filePath) {
  const ext = path.extname(filePath);
  return {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  }[ext] || 'application/octet-stream';
}
