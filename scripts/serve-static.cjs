#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 5174);
const HOST = process.env.HOST || '127.0.0.1';
const LEDGER_DIR = path.join(os.tmpdir(), 'chinahsr-ledger');
const ENABLE_OB_INGEST = Boolean(process.env.OB_PASSWORD) && process.env.CHINAHSR_DISABLE_INGEST !== '1';

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('[serve] dist/index.html is missing. Run npm run build first.');
  process.exit(1);
}
fs.mkdirSync(LEDGER_DIR, { recursive: true });

const server = http.createServer((request, response) => {
  const parsed = new URL(request.url || '/', `http://${HOST}:${PORT}`);
  const pathname = decodeURIComponent(parsed.pathname || '/');

  if (request.method === 'POST' && pathname === '/ingest-bookings') {
    handleIngestBookings(request, response);
    return;
  }

  if (request.method === 'GET' && pathname === '/healthz') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, ledgerIngest: ENABLE_OB_INGEST, ledgerDir: LEDGER_DIR }));
    return;
  }

  const safePath = pathname.replace(/^\/+/, '');
  const requested = path.resolve(DIST, safePath);
  const filePath = requested.startsWith(DIST) && fs.existsSync(requested) && fs.statSync(requested).isFile()
    ? requested
    : path.join(DIST, 'index.html');

  response.setHeader('Cache-Control', filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=300');
  response.setHeader('Content-Type', contentType(filePath));
  fs.createReadStream(filePath).pipe(response);
});

function handleIngestBookings(request, response) {
  let body = '';
  let bytes = 0;
  request.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) {
      request.destroy();
      response.statusCode = 413;
      response.end(JSON.stringify({ ok: false, reason: 'payload too large' }));
      return;
    }
    body += chunk.toString('utf8');
  });
  request.on('end', () => {
    if (!body.trim()) {
      response.statusCode = 200;
      response.end(JSON.stringify({ ok: true, count: 0 }));
      return;
    }
    const lines = body.split(/\r?\n/).filter(Boolean);
    const fileName = `bookings-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.ndjson`;
    const filePath = path.join(LEDGER_DIR, fileName);
    try {
      fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ ok: false, reason: error.message }));
      return;
    }
    if (ENABLE_OB_INGEST) {
      runIngestProcess(filePath, lines.length);
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, count: lines.length, path: filePath, dispatched: ENABLE_OB_INGEST }));
  });
  request.on('error', (error) => {
    response.statusCode = 400;
    response.end(JSON.stringify({ ok: false, reason: error.message }));
  });
}

function runIngestProcess(filePath, count) {
  const pythonBin = process.env.CHINAHSR_PYTHON || 'python3';
  const child = spawn(pythonBin, [path.join(ROOT, 'scripts', 'oceanbase_booking_ingest.py'), '--input', filePath], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[ledger ${count}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[ledger ${count}] ${chunk}`));
  child.on('error', (error) => {
    console.error('[serve] failed to spawn booking ingest:', error.message);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`[serve] China HSR Simulation available at http://${HOST}:${PORT}/`);
  console.log(`[serve] booking ledger directory: ${LEDGER_DIR} (OceanBase ingest: ${ENABLE_OB_INGEST ? 'enabled' : 'disabled'})`);
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
