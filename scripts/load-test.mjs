import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createApp } from '../server.mjs';

// Isolated, short demo workload: never modifies the user's running demo data.
const total = integer(process.env.LOAD_REQUESTS, 200, 20, 2000);
const concurrency = integer(process.env.LOAD_CONCURRENCY, 10, 1, 50);
const dataDir = await mkdtemp(join(tmpdir(), 'campus-found-load-'));
let app;
try {
  app = await createApp({ dataDir, seed: true });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ email: 'minji@kaist.ac.kr', password: 'CampusDemo!24' })
  });
  if (!login.ok) throw new Error(`Login failed (${login.status}): ${await login.text()}`);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Login did not issue a session cookie.');

  const samples = [];
  const failures = [];
  let cursor = 0;
  const start = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= total) return;
      const write = index % 10 === 0;
      const since = performance.now();
      try {
        const response = await fetch(`${base}${write ? '/api/items' : '/api/data'}`, {
          method: write ? 'POST' : 'GET',
          headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
          ...(write ? { body: JSON.stringify({ kind: 'lost', name: `부하 검증 물품 ${index}`, category: '기타', location: '도서관', date: '2026-01-01', description: '격리된 부하 테스트 데이터입니다.' }) } : {}),
          signal: AbortSignal.timeout(10000)
        });
        const result = await response.json();
        if (!response.ok) throw new Error(`${response.status}: ${result.error || 'request failed'}`);
        if (write ? !result.item?.id : !Array.isArray(result.items)) throw new Error('Unexpected API response.');
        samples.push({ ms: performance.now() - since, write });
      } catch (error) {
        failures.push({ index, write, error: error.message });
      }
    }
  }));
  const elapsed = performance.now() - start;
  const reads = samples.filter(s => !s.write).map(s => s.ms);
  const writes = samples.filter(s => s.write).map(s => s.ms);
  const readStats = stats(reads), writeStats = stats(writes);
  const thresholds = { readAverageMs: 3000, writeAverageMs: 5000 };
  const performancePassed = Boolean(readStats && writeStats && readStats.averageMs <= thresholds.readAverageMs && writeStats.averageMs <= thresholds.writeAverageMs);
  const result = {
    workload: '격리된 로컬 시연 API: 조회 90%, 분실 신고 등록 10%',
    total, concurrency, succeeded: samples.length, failed: failures.length,
    successRate: `${(samples.length / total * 100).toFixed(2)}%`,
    durationMs: round(elapsed), requestsPerSecond: round(total / (elapsed / 1000)),
    reads: readStats, writes: writeStats,
    thresholds, performancePassed,
    limitations: '로컬 단일 서버·소량 데이터 측정. 학기 가용성 또는 운영 규모를 보증하지 않습니다.',
    ...(failures.length ? { failures: failures.slice(0, 10) } : {})
  };
  console.log(JSON.stringify(result, null, 2));
  if (failures.length || !performancePassed) process.exitCode = 1;
} finally {
  if (app?.server.listening) await new Promise(resolve => app.server.close(resolve));
  if (app?.close) await app.close();
  const cleanupPath = resolve(dataDir);
  if (dirname(cleanupPath) !== resolve(tmpdir()) || !basename(cleanupPath).startsWith('campus-found-load-')) throw new Error('Refusing unexpected cleanup path.');
  await rm(cleanupPath, { recursive: true, force: true });
}

function integer(value, fallback, min, max) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`Expected an integer between ${min} and ${max}.`);
  return result;
}
function round(value) { return Math.round(value * 100) / 100; }
function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, averageMs: round(values.reduce((a, b) => a + b, 0) / values.length), p50Ms: round(sorted[Math.ceil(sorted.length * .5) - 1]), p95Ms: round(sorted[Math.ceil(sorted.length * .95) - 1]), maxMs: round(sorted.at(-1)) };
}
