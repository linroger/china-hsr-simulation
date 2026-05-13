#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
loadEnvFile(path.join(ROOT, '.env'));
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 5174);
const HOST = process.env.HOST || '127.0.0.1';
const USE_ORB_OCEANBASE = shouldUseOrbForLocalOceanBase();
const LEDGER_DIR = process.env.CHINAHSR_LEDGER_DIR || (USE_ORB_OCEANBASE ? path.join(ROOT, '.runtime', 'ledger') : path.join(os.tmpdir(), 'chinahsr-ledger'));
const ENABLE_OB_INGEST = process.env.CHINAHSR_DISABLE_INGEST !== '1' && (Boolean(process.env.OB_PASSWORD) || USE_ORB_OCEANBASE);
const OCEANBASE_EXPORT_TTL_MS = Number(process.env.CHINAHSR_OCEANBASE_EXPORT_TTL_MS || 60_000);
const OCEANBASE_EXPORT_MAX_BYTES = Number(process.env.CHINAHSR_OCEANBASE_EXPORT_MAX_BYTES || 30 * 1024 * 1024);
let oceanbaseExportCache = null;

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
    response.end(JSON.stringify({ ok: true, ledgerIngest: ENABLE_OB_INGEST, ledgerDir: LEDGER_DIR, ledger: ledgerStats() }));
    return;
  }

  if (request.method === 'GET' && pathname === '/ledger-stats') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, ...ledgerStats() }));
    return;
  }

  if (request.method === 'GET' && pathname === '/api/oceanbase-simulation-data') {
    handleOceanBaseSimulationData(response);
    return;
  }

  const safePath = pathname.replace(/^\/+/, '');
  const requested = path.resolve(DIST, safePath);
  const filePath = requested.startsWith(DIST) && fs.existsSync(requested) && fs.statSync(requested).isFile()
    ? requested
    : path.join(DIST, 'index.html');

  response.setHeader('Cache-Control', filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=300');
  response.setHeader('Content-Type', contentType(filePath));

  const acceptEncoding = request.headers['accept-encoding'] || '';
  const ext = path.extname(filePath);
  const compressible = ['.json', '.geojson', '.js', '.css', '.html', '.svg', '.txt'].includes(ext);

  if (compressible && acceptEncoding.includes('gzip')) {
    response.setHeader('Content-Encoding', 'gzip');
    response.setHeader('Vary', 'Accept-Encoding');
    fs.createReadStream(filePath).pipe(zlib.createGzip()).pipe(response);
  } else {
    fs.createReadStream(filePath).pipe(response);
  }
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

async function handleOceanBaseSimulationData(response) {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const payload = await oceanbaseSimulationData();
    response.setHeader('Cache-Control', 'no-cache');
    response.end(payload);
  } catch (error) {
    const fallback = readOceanBaseExportFallback(error);
    if (fallback) {
      response.setHeader('X-ChinaHSR-OceanBase-Fallback', 'file');
      response.end(fallback);
      return;
    }
    response.statusCode = 503;
    response.end(JSON.stringify({ ok: false, reason: error.message }));
  }
}

async function oceanbaseSimulationData() {
  const now = Date.now();
  if (oceanbaseExportCache && oceanbaseExportCache.expiresAt > now) {
    return oceanbaseExportCache.payload;
  }
  const attempts = buildOceanBaseExportAttempts();
  const errors = [];
  for (const attempt of attempts) {
    try {
      const payload = await runJsonExport(attempt);
      oceanbaseExportCache = { payload, expiresAt: now + OCEANBASE_EXPORT_TTL_MS };
      return payload;
    } catch (error) {
      errors.push(`${attempt.label}: ${error.message}`);
    }
  }
  throw new Error(`OceanBase simulation export failed (${errors.join('; ')})`);
}

function buildOceanBaseExportAttempts() {
  const routeLimit = process.env.CHINAHSR_OCEANBASE_ROUTE_LIMIT || '0';
  const includeAll = process.env.CHINAHSR_OCEANBASE_INCLUDE_ALL_CLASSES === '1';
  const directArgs = [path.join(ROOT, 'scripts', 'export_oceanbase_simulation_data.py'), '--stdout', '--route-limit', routeLimit];
  const host = process.env.OB_HOST || '127.0.0.1';
  if (!process.env.OB_PASSWORD && isLocalHost(host)) directArgs.push('--allow-empty-password');
  if (includeAll) directArgs.push('--include-all-classes');

  const orbArgs = ['-m', 'oceanbase-desktop', '-u', 'root', 'bash', '-lc', buildOrbExportCommand({ routeLimit, includeAll })];
  const direct = { label: 'direct', command: process.env.CHINAHSR_PYTHON || 'python3', args: directArgs, env: process.env };
  const orb = { label: 'orb', command: process.env.ORB_BIN || '/opt/homebrew/bin/orb', args: orbArgs, env: process.env };
  const explicitOrb = process.env.CHINAHSR_OCEANBASE_VIA_ORB === '1';
  const explicitDirect = process.env.CHINAHSR_OCEANBASE_VIA_ORB === '0';
  if (explicitOrb) return [orb, direct];
  if (explicitDirect) return [direct];
  return isLocalHost(host) ? [orb, direct] : [direct, orb];
}

function buildOrbExportCommand({ routeLimit, includeAll }) {
  const parts = [
    `cd ${shellQuote(ROOT)}`,
    `OB_HOST=${shellQuote(process.env.CHINAHSR_ORB_OB_HOST || '127.0.0.1')}`,
    `OB_PORT=${shellQuote(process.env.CHINAHSR_ORB_OB_PORT || '2881')}`,
    `OB_USER=${shellQuote(process.env.CHINAHSR_ORB_OB_USER || 'root')}`,
    `OB_DATABASE=${shellQuote(process.env.CHINAHSR_ORB_OB_DATABASE || process.env.OB_DATABASE || 'chinahsr')}`,
    `OB_PASSWORD=${shellQuote(process.env.CHINAHSR_ORB_OB_PASSWORD || '')}`,
    'python3 scripts/export_oceanbase_simulation_data.py --stdout --allow-empty-password',
    `--route-limit ${shellQuote(routeLimit || '0')}`,
  ];
  if (includeAll) parts.push('--include-all-classes');
  return `${parts[0]} && ${parts.slice(1, 6).join(' ')} ${parts.slice(6).join(' ')}`;
}

function runJsonExport(attempt) {
  return new Promise((resolve, reject) => {
    const child = spawn(attempt.command, attempt.args, {
      cwd: ROOT,
      env: attempt.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > OCEANBASE_EXPORT_MAX_BYTES) {
        child.kill('SIGTERM');
        reject(new Error(`export exceeded ${OCEANBASE_EXPORT_MAX_BYTES} bytes`));
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error((stderr || `exit ${code}`).trim().slice(0, 1000)));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (!Array.isArray(parsed.routes) || !Array.isArray(parsed.stations)) {
          reject(new Error('export payload is missing routes/stations arrays'));
          return;
        }
        resolve(JSON.stringify({ ok: true, ...parsed }));
      } catch (error) {
        reject(new Error(`invalid JSON export: ${error.message}`));
      }
    });
  });
}

function readOceanBaseExportFallback(error) {
  const fallbackPath = path.join(ROOT, 'public', 'oceanbase-simulation-data.json');
  if (!fs.existsSync(fallbackPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
    return JSON.stringify({ ok: true, fallback: 'public/oceanbase-simulation-data.json', fallbackReason: error.message, ...parsed });
  } catch {
    return null;
  }
}

function runIngestProcess(filePath, count) {
  const child = USE_ORB_OCEANBASE
    ? spawn(process.env.ORB_BIN || '/opt/homebrew/bin/orb', ['-m', 'oceanbase-desktop', '-u', 'root', 'bash', '-lc', buildOrbIngestCommand(filePath)], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    : spawn(process.env.CHINAHSR_PYTHON || 'python3', buildDirectIngestArgs(filePath), {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
  child.stdout.on('data', (chunk) => process.stdout.write(`[ledger ${count}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[ledger ${count}] ${chunk}`));
  child.on('error', (error) => {
    console.error('[serve] failed to spawn booking ingest:', error.message);
  });
}

function buildDirectIngestArgs(filePath) {
  const args = [path.join(ROOT, 'scripts', 'oceanbase_booking_ingest.py'), '--input', filePath];
  if (!process.env.OB_PASSWORD && isLocalHost(process.env.OB_HOST || '127.0.0.1')) args.push('--allow-empty-password');
  return args;
}

function buildOrbIngestCommand(filePath) {
  return [
    `cd ${shellQuote(ROOT)}`,
    '&&',
    `OB_HOST=${shellQuote(process.env.CHINAHSR_ORB_OB_HOST || '127.0.0.1')}`,
    `OB_PORT=${shellQuote(process.env.CHINAHSR_ORB_OB_PORT || '2881')}`,
    `OB_USER=${shellQuote(process.env.CHINAHSR_ORB_OB_USER || 'root')}`,
    `OB_DATABASE=${shellQuote(process.env.CHINAHSR_ORB_OB_DATABASE || process.env.OB_DATABASE || 'chinahsr')}`,
    `OB_PASSWORD=${shellQuote(process.env.CHINAHSR_ORB_OB_PASSWORD || '')}`,
    'python3 scripts/oceanbase_booking_ingest.py --allow-empty-password --input',
    shellQuote(filePath),
  ].join(' ');
}

function ledgerStats() {
  const files = fs.readdirSync(LEDGER_DIR)
    .filter((name) => name.endsWith('.ndjson'))
    .map((name) => {
      const filePath = path.join(LEDGER_DIR, name);
      const stat = fs.statSync(filePath);
      return { name, path: filePath, bytes: stat.size, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  const pendingBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  return {
    ingestEnabled: ENABLE_OB_INGEST,
    dir: LEDGER_DIR,
    pendingFiles: files.length,
    pendingBytes,
    oldestPendingFile: files[0]?.name || null,
    newestPendingFile: files[files.length - 1]?.name || null,
  };
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function isLocalHost(host) {
  return ['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(String(host || '').toLowerCase());
}

function shouldUseOrbForLocalOceanBase() {
  if (process.env.CHINAHSR_OCEANBASE_VIA_ORB === '1') return true;
  if (process.env.CHINAHSR_OCEANBASE_VIA_ORB === '0') return false;
  return isLocalHost(process.env.OB_HOST || '127.0.0.1');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
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
    '.woff2': 'font/woff2',
    '.webp': 'image/webp',
    '.wasm': 'application/wasm',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
  }[ext] || 'application/octet-stream';
}
