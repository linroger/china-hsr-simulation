import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

test('OceanBase annual generator produces uncapped route-day summary without database credentials', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinahsr-oceanbase-'));
  const summaryPath = path.join(tempDir, 'summary.json');
  try {
    const output = execFileSync('python3', [
      'scripts/oceanbase_seed.py',
      '--skip-db',
      '--days',
      '30',
      '--workers',
      '2',
      '--chunk-days',
      '5',
      '--summary-path',
      summaryPath,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
    });
    assert.match(output, /\[oceanbase:seed\]/);
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    assert.equal(summary.days, 30);
    assert.equal(summary.workerCount, 2);
    assert.equal(summary.oceanbase.enabled, false);
    assert.equal(summary.routeDayRows, summary.routeCount * 30);
    assert.ok(summary.totalTrainServices > summary.routeDayRows * 2);
    assert.ok(summary.estimatedPassengers > summary.totalTrainServices * 200);
    assert.ok(summary.estimatedRevenue > 0);
    assert.ok(summary.surgeDayCount > 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
