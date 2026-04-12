/**
 * stress-admin.ts — ISAFlow Admin API Stress Test
 *
 * Usage: bun run scripts/stress-admin.ts --email admin@example.com --password secret --vu 10
 * Env fallback: ADMIN_EMAIL, ADMIN_PASSWORD
 */

import {
  type ScenarioResult,
  THRESHOLDS,
  percentile,
  printReport,
  scenarioDashboardPolling,
  scenarioHeavyAnalytics,
  scenarioMixedLoad,
  scenarioPaginatedListSweep,
  scenarioRateLimiterCheck,
} from './stress-admin-scenarios';

const BASE_URL = 'https://admin.isaflow.co.za';

// ─── CLI Args ─────────────────────────────────────────────────────────────────

function parseArgs(): { email: string; password: string; token: string; vu: number; scenario: number | null } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const email = get('--email') ?? process.env['ADMIN_EMAIL'] ?? '';
  const password = get('--password') ?? process.env['ADMIN_PASSWORD'] ?? '';
  const token = get('--token') ?? process.env['ADMIN_JWT'] ?? '';
  const vuStr = get('--vu');
  const scenarioStr = get('--scenario');

  if (!token && (!email || !password)) {
    console.error('ERROR: provide --token <jwt> OR --email + --password');
    process.exit(1);
  }

  return {
    email,
    password,
    token,
    vu: vuStr ? parseInt(vuStr, 10) : 10,
    scenario: scenarioStr ? parseInt(scenarioStr, 10) : null,
  };
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getAdminCookie(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Login failed (HTTP ${res.status}): ${body}`);
  }

  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = setCookie.match(/ff_auth_token=([^;]+)/);
  if (!match) {
    throw new Error('No ff_auth_token cookie in login response. Check credentials or admin access.');
  }

  return `ff_auth_token=${match[1]}`;
}

// ─── Summary Report ───────────────────────────────────────────────────────────

function printFinalSummary(results: ScenarioResult[]): boolean {
  const all = results.flatMap(r => r.measurements);
  const errors = all.filter(m => m.statusCode === 0 || m.statusCode >= 500);
  const durations = all.map(m => m.durationMs).sort((a, b) => a - b);
  const overallP95 = percentile(durations, 95);

  console.log('\n' + '═'.repeat(60));
  console.log('  FINAL SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Total requests : ${all.length}`);
  console.log(`  Total errors   : ${errors.length} (${((errors.length / all.length) * 100).toFixed(1)}%)`);
  console.log(`  Overall p95    : ${overallP95}ms`);

  // Per-threshold check
  const groups: Record<string, number[]> = {};
  for (const m of all) {
    const path = m.endpoint.split('?')[0]!;
    if (!groups[path]) groups[path] = [];
    groups[path]!.push(m.durationMs);
  }

  let anyFail = false;
  for (const [path, times] of Object.entries(groups)) {
    const threshold = THRESHOLDS[path];
    if (!threshold) continue;
    const sorted = times.slice().sort((a, b) => a - b);
    const p95 = percentile(sorted, 95);
    if (p95 > threshold) {
      console.error(`  \x1b[31m[FAIL]\x1b[0m ${path} p95=${p95}ms > threshold=${threshold}ms`);
      anyFail = true;
    }
  }

  if (!anyFail) {
    console.log('\n  \x1b[32m[PASS] All p95 thresholds met.\x1b[0m');
  }
  console.log('═'.repeat(60) + '\n');
  return !anyFail;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { email, password, token, vu, scenario } = parseArgs();

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║       ISAFlow Admin Stress Test                          ║');
  console.log(`║       Target: ${BASE_URL.padEnd(43)}║`);
  console.log(`║       VUs: ${String(vu).padEnd(47)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  // ── Step 1: Authenticate N VUs concurrently ──────────────────────────────
  let cookies: string[];
  if (token) {
    console.log(`\nUsing provided JWT token for ${vu} VU(s)...`);
    cookies = Array.from({ length: vu }, () => `ff_auth_token=${token}`);
  } else {
    console.log(`\nAuthenticating ${vu} VU(s)...`);
    try {
      cookies = await Promise.all(
        Array.from({ length: vu }, () => getAdminCookie(email, password)),
      );
    } catch (err) {
      console.error('Authentication failed:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }
  console.log(`\x1b[32m✓ ${cookies.length} VU(s) ready\x1b[0m`);

  const results: ScenarioResult[] = [];
  const passes: boolean[] = [];

  const runScenario = async (num: number) => {
    switch (num) {
      case 1: {
        console.log('\n=== SCENARIO 1: Dashboard Polling ===');
        const r = await scenarioDashboardPolling(BASE_URL, cookies, vu);
        results.push(r);
        passes.push(printReport(r));
        break;
      }
      case 2: {
        console.log('\n=== SCENARIO 2: Heavy Analytics ===');
        const r = await scenarioHeavyAnalytics(BASE_URL, cookies, vu);
        results.push(r);
        passes.push(printReport(r));
        break;
      }
      case 3: {
        console.log('\n=== SCENARIO 3: Paginated List Sweep ===');
        const r = await scenarioPaginatedListSweep(BASE_URL, cookies, vu);
        results.push(r);
        passes.push(printReport(r));
        break;
      }
      case 4: {
        console.log('\n=== SCENARIO 4: Rate Limiter Check ===');
        const r = await scenarioRateLimiterCheck(BASE_URL, cookies[0]!);
        results.push(r);
        passes.push(printReport(r));
        break;
      }
      case 5: {
        console.log('\n=== SCENARIO 5: Concurrent Analytics vs List Reads ===');
        const r = await scenarioMixedLoad(BASE_URL, cookies, vu);
        results.push(r);
        passes.push(printReport(r));
        break;
      }
      default:
        console.error(`Unknown scenario: ${num}`);
    }
  };

  // ── Step 2: Run scenarios ─────────────────────────────────────────────────
  if (scenario !== null) {
    await runScenario(scenario);
  } else {
    for (let s = 1; s <= 5; s++) {
      await runScenario(s);
    }
  }

  // ── Step 3: Final summary ─────────────────────────────────────────────────
  const allPass = printFinalSummary(results);

  process.exit(allPass && passes.every(Boolean) ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
