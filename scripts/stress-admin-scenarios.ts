// stress-admin-scenarios.ts — ISAFlow Admin Stress Test Scenarios

export interface Measurement {
  endpoint: string;
  method: string;
  statusCode: number;
  durationMs: number;
}

export interface ScenarioResult {
  name: string;
  measurements: Measurement[];
  durationMs: number;
}

export const THRESHOLDS: Record<string, number> = {
  '/api/admin/dashboard-stats': 500,
  '/api/admin/health': 500,
  '/api/admin/analytics/trends': 2000,
  '/api/admin/analytics/revenue': 2000,
  '/api/admin/analytics/usage': 2000,
  '/api/admin/companies': 1000,
  '/api/admin/users': 1000,
  '/api/admin/email-log': 1000,
  '/api/admin/audit': 1000,
  '/api/admin/job-queue': 1000,
  '/api/admin/webhooks': 1000,
  '/api/admin/trials': 1000,
  '/api/admin/billing/subscriptions': 1000,
};

// ─── Timed Fetch ──────────────────────────────────────────────────────────────

export async function timedFetch(
  url: string,
  init: RequestInit,
  cookie: string,
): Promise<Measurement & { ok: boolean; body: unknown }> {
  const parsed = new URL(url);
  const endpoint = parsed.pathname;
  const method = (init.method ?? 'GET').toUpperCase();
  const start = Date.now();
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Cookie: cookie,
      },
    });
    const durationMs = Date.now() - start;
    let body: unknown;
    try { body = await res.json(); } catch { body = null; }
    return { endpoint, method, statusCode: res.status, durationMs, ok: res.ok, body };
  } catch (err) {
    const durationMs = Date.now() - start;
    return { endpoint, method, statusCode: 0, durationMs, ok: false, body: String(err) };
  }
}

// ─── Percentile ───────────────────────────────────────────────────────────────

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!;
}

// ─── Report ───────────────────────────────────────────────────────────────────

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

export function printReport(result: ScenarioResult): boolean {
  console.log(`\n=== SCENARIO: ${result.name} ===`);
  console.log(`Duration: ${result.durationMs}ms  Total requests: ${result.measurements.length}`);

  // Group by endpoint+method
  const groups: Record<string, Measurement[]> = {};
  for (const m of result.measurements) {
    const key = `${m.method} ${m.endpoint}`;
    if (!groups[key]) groups[key] = [];
    groups[key]!.push(m);
  }

  const colW = [32, 7, 6, 6, 6, 12];
  const header = [
    'Endpoint'.padEnd(colW[0]!),
    'Count'.padStart(colW[1]!),
    'p50'.padStart(colW[2]!),
    'p95'.padStart(colW[3]!),
    'p99'.padStart(colW[4]!),
    'Errors'.padEnd(colW[5]!),
  ].join(' | ');
  const sep = colW.map(w => '-'.repeat(w)).join('-+-');
  console.log(`\n${BOLD}${header}${RESET}`);
  console.log(sep);

  let anyFail = false;

  for (const [key, ms] of Object.entries(groups)) {
    const durations = ms.map(m => m.durationMs).sort((a, b) => a - b);
    const errors = ms.filter(m => m.statusCode === 0 || m.statusCode >= 500);
    const p50 = percentile(durations, 50);
    const p95 = percentile(durations, 95);
    const p99 = percentile(durations, 99);
    const errorRate = errors.length / ms.length;

    // Threshold check: match by path (strip query)
    const path = key.replace(/^GET |^POST /, '').split('?')[0]!;
    const threshold = THRESHOLDS[path];
    const overThreshold = threshold !== undefined && p95 > threshold;
    if (overThreshold) anyFail = true;

    const p95Str = overThreshold
      ? `${RED}${p95}ms${RESET}`
      : `${p95}ms`;

    const errStr = errors.length > 0
      ? `${RED}${errors.length} (${(errorRate * 100).toFixed(1)}%)${RESET}`
      : `${GREEN}0 (0.0%)${RESET}`;

    const endpointLabel = key.slice(0, colW[0]!).padEnd(colW[0]!);
    console.log(
      `${endpointLabel} | ` +
      `${String(ms.length).padStart(colW[1]!)} | ` +
      `${`${p50}ms`.padStart(colW[2]!)} | ` +
      `${p95Str.padStart(colW[3]! + (overThreshold ? RED.length + RESET.length : 0))} | ` +
      `${`${p99}ms`.padStart(colW[4]!)} | ` +
      `${errStr}`,
    );
  }

  if (anyFail) {
    console.log(`\n${RED}[FAIL] Some p95 values exceeded thresholds${RESET}`);
  } else {
    console.log(`\n${GREEN}[PASS] All p95 within thresholds${RESET}`);
  }
  return !anyFail;
}

// ─── Scenario Builders ────────────────────────────────────────────────────────

export async function scenarioDashboardPolling(
  base: string,
  cookies: string[],
  vu: number,
): Promise<ScenarioResult> {
  const ITERATIONS = 5;
  console.log(`Running ${vu} VU × ${ITERATIONS} iterations...`);
  const start = Date.now();
  const all: Measurement[] = [];

  const vuWork = cookies.slice(0, vu).map(async (cookie) => {
    for (let i = 0; i < ITERATIONS; i++) {
      const results = await Promise.all([
        timedFetch(`${base}/api/admin/dashboard-stats`, {}, cookie),
        timedFetch(`${base}/api/admin/health`, {}, cookie),
        timedFetch(`${base}/api/admin/analytics/trends`, {}, cookie),
      ]);
      all.push(...results);
    }
  });
  await Promise.all(vuWork);
  return { name: 'Dashboard Polling', measurements: all, durationMs: Date.now() - start };
}

export async function scenarioHeavyAnalytics(
  base: string,
  cookies: string[],
  vu: number,
): Promise<ScenarioResult> {
  const VU_COUNT = Math.min(5, vu);
  const ITERATIONS = 3;
  console.log(`Running ${VU_COUNT} VU × ${ITERATIONS} iterations...`);
  const start = Date.now();
  const all: Measurement[] = [];

  const vuWork = cookies.slice(0, VU_COUNT).map(async (cookie) => {
    for (let i = 0; i < ITERATIONS; i++) {
      const results = await Promise.all([
        timedFetch(`${base}/api/admin/analytics/revenue`, {}, cookie),
        timedFetch(`${base}/api/admin/analytics/trends`, {}, cookie),
        timedFetch(`${base}/api/admin/analytics/usage`, {}, cookie),
      ]);
      all.push(...results);
    }
  });
  await Promise.all(vuWork);
  return { name: 'Heavy Analytics', measurements: all, durationMs: Date.now() - start };
}

export async function scenarioPaginatedListSweep(
  base: string,
  cookies: string[],
  vu: number,
): Promise<ScenarioResult> {
  const VU_COUNT = Math.min(15, vu);
  const ITERATIONS = 2;
  console.log(`Running ${VU_COUNT} VU × ${ITERATIONS} iterations...`);
  const start = Date.now();
  const all: Measurement[] = [];

  const listUrls = [
    `${base}/api/admin/companies?page=1&limit=25&sort_by=created_at&sort_dir=desc`,
    `${base}/api/admin/companies?page=1&limit=25&search=test`,
    `${base}/api/admin/users?page=1&limit=50`,
    `${base}/api/admin/billing/subscriptions?page=1`,
    `${base}/api/admin/billing/invoices?page=1`,
    `${base}/api/admin/email-log?page=1`,
    `${base}/api/admin/audit?page=1`,
    `${base}/api/admin/webhooks?page=1`,
    `${base}/api/admin/job-queue?status=failed`,
    `${base}/api/admin/trials`,
    `${base}/api/admin/trials/stats`,
  ];

  const vuWork = cookies.slice(0, VU_COUNT).map(async (cookie) => {
    for (let i = 0; i < ITERATIONS; i++) {
      for (const url of listUrls) {
        const m = await timedFetch(url, {}, cookie);
        all.push(m);
      }
    }
  });
  await Promise.all(vuWork);
  return { name: 'Paginated List Sweep', measurements: all, durationMs: Date.now() - start };
}

export async function scenarioRateLimiterCheck(
  base: string,
  cookie: string,
): Promise<ScenarioResult> {
  const REQUESTS = 35;
  console.log(`Running 1 VU, ${REQUESTS} concurrent requests to /api/admin/health...`);
  const start = Date.now();
  const results = await Promise.all(
    Array.from({ length: REQUESTS }, () =>
      timedFetch(`${base}/api/admin/health`, {}, cookie),
    ),
  );
  const count429 = results.filter(r => r.statusCode === 429).length;
  const pass = count429 >= 5;
  console.log(
    `Rate limit check: ${count429} / ${REQUESTS} returned 429 — ` +
    (pass ? `${GREEN}[PASS]${RESET}` : `\x1b[33m[WARN] expected >= 5${RESET}`),
  );
  return {
    name: 'Rate Limiter Check',
    measurements: results,
    durationMs: Date.now() - start,
  };
}

export async function scenarioMixedLoad(
  base: string,
  cookies: string[],
  vu: number,
): Promise<ScenarioResult> {
  const analyticsVU = Math.min(5, Math.floor(vu / 3));
  const listVU = Math.min(10, vu - analyticsVU);
  console.log(`Running ${analyticsVU} analytics VU + ${listVU} list VU concurrently...`);
  const start = Date.now();

  const analyticsWork = cookies.slice(0, analyticsVU).map(async (cookie) => {
    const results = await Promise.all([
      timedFetch(`${base}/api/admin/analytics/revenue`, {}, cookie),
      timedFetch(`${base}/api/admin/analytics/trends`, {}, cookie),
      timedFetch(`${base}/api/admin/analytics/usage`, {}, cookie),
    ]);
    return results;
  });

  const listUrls = [
    `${base}/api/admin/companies?page=1&limit=25`,
    `${base}/api/admin/users?page=1&limit=50`,
    `${base}/api/admin/billing/subscriptions?page=1`,
    `${base}/api/admin/email-log?page=1`,
    `${base}/api/admin/audit?page=1`,
  ];

  const listWork = cookies.slice(analyticsVU, analyticsVU + listVU).map(async (cookie) => {
    const batch = await Promise.all(listUrls.map(url => timedFetch(url, {}, cookie)));
    return batch;
  });

  const [analyticsResults, listResults] = await Promise.all([
    Promise.all(analyticsWork),
    Promise.all(listWork),
  ]);

  const all: Measurement[] = [
    ...analyticsResults.flat(),
    ...listResults.flat(),
  ];
  return { name: 'Concurrent Analytics vs List Reads', measurements: all, durationMs: Date.now() - start };
}
