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
const OCEANBASE_EXPORT_TTL_MS = Number(process.env.CHINAHSR_OCEANBASE_EXPORT_TTL_MS || 300_000);
const OCEANBASE_EXPORT_MAX_BYTES = Number(process.env.CHINAHSR_OCEANBASE_EXPORT_MAX_BYTES || 30 * 1024 * 1024);
const PREBUILT_EXPORT_PATH = path.join(ROOT, 'public', 'oceanbase-simulation-data.json');
const PREBUILT_FRESH_HOURS = Number(process.env.CHINAHSR_PREBUILT_FRESH_HOURS || 48);
const LEDGER_RETRY_INTERVAL_MS = Number(process.env.CHINAHSR_LEDGER_RETRY_MS || 90_000);
let oceanbaseExportCache = null;
let ledgerSweepInFlight = false;

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
  const normalized = path.normalize(safePath);
  // Reject any path containing parent-directory traversal.
  if (normalized.includes('..')) {
    response.statusCode = 403;
    response.end('Forbidden');
    return;
  }
  const requested = path.resolve(DIST, normalized);
  const withinDist = !path.relative(DIST, requested).startsWith('..') && requested !== DIST;
  const filePath = withinDist && fs.existsSync(requested) && fs.statSync(requested).isFile()
    ? requested
    : path.join(DIST, 'index.html');

  response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
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
  const chunks = [];
  let bytes = 0;
  request.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) {
      request.destroy();
      response.statusCode = 413;
      response.end(JSON.stringify({ ok: false, reason: 'payload too large' }));
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
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
  response.setHeader('Cache-Control', 'no-cache');
  // A fresh pre-generated export avoids needing a live OceanBase connection.
  const prebuilt = readPrebuiltOceanBaseExport();
  if (prebuilt && prebuilt.ageHours <= PREBUILT_FRESH_HOURS) {
    response.setHeader('X-ChinaHSR-Data-Source', 'prebuilt-12306-export');
    response.end(prebuilt.payload);
    return;
  }
  try {
    const payload = await oceanbaseSimulationData();
    response.end(payload);
  } catch (error) {
    // A stale OceanBase-derived export is still the same dataset the app
    // expects — strictly better than 503ing into the static-JSON fallback.
    if (prebuilt) {
      console.error(`[serve] live OceanBase export failed (${error.message}); serving prebuilt export (${Math.round(prebuilt.ageHours)}h old).`);
      response.setHeader('X-ChinaHSR-OceanBase-Fallback', 'stale-prebuilt');
      response.end(prebuilt.payload);
      return;
    }
    response.statusCode = 503;
    console.error('[serve] OceanBase export failed:', error.message);
    response.end(JSON.stringify({ ok: false, reason: 'OceanBase data export unavailable. Please try again later.' }));
  }
}

function readPrebuiltOceanBaseExport() {
  if (!fs.existsSync(PREBUILT_EXPORT_PATH)) return null;
  const stats = fs.statSync(PREBUILT_EXPORT_PATH);
  const ageHours = (Date.now() - stats.mtimeMs) / 3600000;
  try {
    const parsed = JSON.parse(fs.readFileSync(PREBUILT_EXPORT_PATH, 'utf8'));
    if (!Array.isArray(parsed.routes) || !Array.isArray(parsed.stations)) return null;
    return {
      ageHours,
      payload: JSON.stringify({ ok: true, source: '12306.db-prebuilt', exportAgeHours: Math.round(ageHours * 10) / 10, ...parsed }),
    };
  } catch {
    return null;
  }
}

/**
 * Persist a successful live export so the prebuilt cache refreshes itself:
 * the next server start (or request inside the freshness window) serves the
 * new file without touching OceanBase again.
 */
function persistPrebuiltExport(payload) {
  const tempPath = `${PREBUILT_EXPORT_PATH}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tempPath, payload, 'utf8');
    fs.renameSync(tempPath, PREBUILT_EXPORT_PATH);
    console.log('[serve] refreshed prebuilt OceanBase export from live database.');
  } catch (error) {
    console.error('[serve] failed to refresh prebuilt export:', error.message);
    try { fs.unlinkSync(tempPath); } catch { /* already gone */ }
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
      persistPrebuiltExport(payload);
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
  if (includeAll) directArgs.push('--include-all-classes');
  // Local OceanBase Desktop tenants run with an empty root password; the
  // export script refuses an empty OB_PASSWORD without this explicit opt-in.
  if (!process.env.OB_PASSWORD) directArgs.push('--allow-empty-password');

  const direct = { label: 'direct', command: process.env.CHINAHSR_PYTHON || 'python3', args: directArgs, env: process.env };
  const explicitOrb = process.env.CHINAHSR_OCEANBASE_VIA_ORB === '1';
  const explicitDirect = process.env.CHINAHSR_OCEANBASE_VIA_ORB === '0';
  if (explicitDirect) return [direct];

  const orbBin = process.env.ORB_BIN || '/opt/homebrew/bin/orb';
  const orbAvailable = (() => {
    try { return require('fs').existsSync(orbBin); } catch { return false; }
  })();
  if (orbAvailable || explicitOrb) {
    const orbArgs = ['-m', process.env.ORB_VM_NAME || 'oceanbase-desktop', '-u', 'root', 'bash', '-lc', buildOrbExportCommand({ routeLimit, includeAll })];
    const orb = { label: 'orb', command: orbBin, args: orbArgs, env: process.env };
    if (explicitOrb) return [orb, direct];
    return isLocalHost(process.env.OB_HOST || '127.0.0.1') ? [orb, direct] : [direct, orb];
  }
  return [direct];
}

function buildOrbExportCommand({ routeLimit, includeAll }) {
  const parts = [
    `cd ${shellQuote(ROOT)}`,
    `OB_HOST=${shellQuote(process.env.CHINAHSR_ORB_OB_HOST || '127.0.0.1')}`,
    `OB_PORT=${shellQuote(process.env.CHINAHSR_ORB_OB_PORT || '2881')}`,
    `OB_USER=${shellQuote(process.env.CHINAHSR_ORB_OB_USER || 'root')}`,
    `OB_DATABASE=${shellQuote(process.env.CHINAHSR_ORB_OB_DATABASE || process.env.OB_DATABASE || 'chinahsr')}`,
    `OB_PASSWORD=${shellQuote(process.env.CHINAHSR_ORB_OB_PASSWORD || '')}`,
    'python3 scripts/export_oceanbase_simulation_data.py --stdout',
    `--route-limit ${shellQuote(routeLimit || '0')}`,
  ];
  if (includeAll) parts.push('--include-all-classes');
  if (!process.env.CHINAHSR_ORB_OB_PASSWORD) parts.push('--allow-empty-password');
  return `${parts[0]} && ${parts.slice(1, 6).join(' ')} ${parts.slice(6).join(' ')}`;
}

function runJsonExport(attempt) {
  return new Promise((resolve, reject) => {
    const child = spawn(attempt.command, attempt.args, {
      cwd: ROOT,
      env: attempt.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let bytes = 0;
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > OCEANBASE_EXPORT_MAX_BYTES) {
        child.kill('SIGTERM');
        reject(new Error(`export exceeded ${OCEANBASE_EXPORT_MAX_BYTES} bytes`));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk);
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
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

function runIngestProcess(filePath, count, onExit) {
  const child = USE_ORB_OCEANBASE
    ? spawn(process.env.ORB_BIN || '/opt/homebrew/bin/orb', ['-m', process.env.ORB_VM_NAME || 'oceanbase-desktop', '-u', 'root', 'bash', '-lc', buildOrbIngestCommand(filePath)], {
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
    onExit?.(error);
  });
  child.on('close', (code) => onExit?.(code === 0 ? null : new Error(`ingest exited ${code}`)));
}

/**
 * Re-dispatch ledger batches whose first ingest attempt failed (the Python
 * ingest deletes its input on success, so any file older than a couple of
 * minutes is a stranded batch). Inserts are idempotent upserts keyed by
 * ticket_id, so re-running a file is safe.
 */
function sweepPendingLedger() {
  if (ledgerSweepInFlight) return;
  const cutoff = Date.now() - 120_000;
  let files;
  try {
    files = fs.readdirSync(LEDGER_DIR)
      .filter((name) => name.endsWith('.ndjson'))
      .map((name) => ({ name, path: path.join(LEDGER_DIR, name), mtimeMs: fs.statSync(path.join(LEDGER_DIR, name)).mtimeMs }))
      .filter((file) => file.mtimeMs < cutoff)
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
      .slice(0, 3);
  } catch (error) {
    console.error('[serve] ledger sweep failed to list pending files:', error.message);
    return;
  }
  if (!files.length) return;
  ledgerSweepInFlight = true;
  console.log(`[serve] retrying ${files.length} stranded ledger batch(es).`);
  let remaining = files.length;
  for (const file of files) {
    runIngestProcess(file.path, `retry:${file.name}`, () => {
      remaining -= 1;
      if (remaining === 0) ledgerSweepInFlight = false;
    });
  }
}

function buildDirectIngestArgs(filePath) {
  const args = [path.join(ROOT, 'scripts', 'oceanbase_booking_ingest.py'), '--input', filePath];
  if (!process.env.OB_PASSWORD) args.push('--allow-empty-password');
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
    'python3 scripts/oceanbase_booking_ingest.py --input',
    shellQuote(filePath),
    process.env.CHINAHSR_ORB_OB_PASSWORD ? '' : '--allow-empty-password',
  ].join(' ').trim();
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
  const orbBin = process.env.ORB_BIN || '/opt/homebrew/bin/orb';
  const orbAvailable = (() => { try { return fs.existsSync(orbBin); } catch { return false; } })();
  return orbAvailable && isLocalHost(process.env.OB_HOST || '127.0.0.1');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

server.listen(PORT, HOST, () => {
  console.log(`[serve] China HSR Simulation available at http://${HOST}:${PORT}/`);
  console.log(`[serve] booking ledger directory: ${LEDGER_DIR} (OceanBase ingest: ${ENABLE_OB_INGEST ? 'enabled' : 'disabled'})`);
});

if (ENABLE_OB_INGEST) {
  const sweepTimer = setInterval(sweepPendingLedger, LEDGER_RETRY_INTERVAL_MS);
  sweepTimer.unref?.();
}

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
