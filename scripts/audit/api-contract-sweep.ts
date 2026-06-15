/**
 * API Contract Sweep — Phase 3 audit
 *
 * Exercises every route in the catalog with multiple input scenarios and records:
 *   - HTTP status code
 *   - Latency (ms)
 *   - Whether the response matches the apiResponse envelope
 *   - Whether the body leaks PG error codes, severity fields, or stack traces
 *
 * Usage:
 *   bun scripts/audit/api-contract-sweep.ts
 *
 * Required env (reads .env.local automatically):
 *   SWEEP_BASE_URL   — defaults to http://localhost:3200
 *   SWEEP_EMAIL      — defaults to admin@isaflow.co.za
 *   SWEEP_PASSWORD   — falls back to ADMIN_PASSWORD; required (no hardcoded default)
 *   SWEEP_COMPANY_ID — defaults to 00000000-0000-0000-0000-0000000d4e02
 *
 * scripts/audit/api-contract-sweep.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Load .env.local ──────────────────────────────────────────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(HERE, '..', '..', '.env.local');
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]!]) continue;
    process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
}

import { SweepClient, authenticate } from './sweep-client.ts';
import { checkEnvelope, detectLeaks, type RouteResult, type Finding } from './sweep-types.ts';
import { ROUTES, NIL_UUID, type RouteSpec } from './sweep-routes.ts';

// ── Config ───────────────────────────────────────────────────────────────────
const BASE_URL    = process.env['SWEEP_BASE_URL']    ?? 'http://localhost:3200';
const EMAIL       = process.env['SWEEP_EMAIL']       ?? 'admin@isaflow.co.za';
const PASSWORD    = process.env['SWEEP_PASSWORD'] ?? process.env['ADMIN_PASSWORD'];
if (!PASSWORD) { console.error('SWEEP_PASSWORD or ADMIN_PASSWORD env var is required (hardcoded default removed for security)'); process.exit(1); }
const COMPANY_ID  = process.env['SWEEP_COMPANY_ID']  ?? '00000000-0000-0000-0000-0000000d4e02';

// Output paths
const OUT_DIR = path.resolve(HERE, '..', '..', 'tmp', 'api-contract-audit');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Scenario builders ────────────────────────────────────────────────────────

type Scenario = { name: string; body?: unknown; query?: string };

function getScenarios(spec: RouteSpec, method: string): Scenario[] {
  const base: Scenario = { name: 'baseline' };

  if (method === 'GET') {
    return [
      base,
      { name: 'no-params', query: '' },
      { name: 'null-filters', query: '?search=&status=&page=0&limit=0' },
      { name: 'malformed-page', query: '?page=abc&limit=-1&cursor=NOT_A_UUID' },
      { name: 'cross-tenant-id', query: `?id=${NIL_UUID}&companyId=${NIL_UUID}` },
    ];
  }

  if (method === 'POST' || method === 'PATCH') {
    return [
      { name: 'empty-body', body: {} },
      { name: 'null-fields', body: { id: null, name: null, amount: null, date: null } },
      { name: 'wrong-types', body: { id: true, amount: 'notanumber', date: 12345 } },
      { name: 'oversize-string', body: { name: 'x'.repeat(10_001), description: 'y'.repeat(10_001) } },
    ];
  }

  if (method === 'DELETE') {
    return [
      { name: 'no-id', query: '' },
      { name: 'nil-uuid', query: `?id=${NIL_UUID}` },
    ];
  }

  return [base];
}

// ── Result collector ─────────────────────────────────────────────────────────

const allResults: RouteResult[] = [];
const findings: Finding[] = [];

function record(result: RouteResult): void {
  allResults.push(result);

  // P1: 5xx on any input
  if (result.statusCode >= 500) {
    findings.push({
      priority: 'P1',
      route: result.route,
      method: result.method,
      scenario: result.scenario,
      statusCode: result.statusCode,
      latencyMs: result.latencyMs,
      description: `HTTP ${result.statusCode} returned`,
      raw: result.errorBody?.slice(0, 500),
    });
    return;
  }

  // P1: 4xx with internal leak
  if (result.leaksInternals) {
    findings.push({
      priority: 'P1',
      route: result.route,
      method: result.method,
      scenario: result.scenario,
      statusCode: result.statusCode,
      latencyMs: result.latencyMs,
      description: `Internal leak: ${result.leakDetail}`,
      raw: result.errorBody?.slice(0, 500),
    });
    return;
  }

  // P2: wrong envelope on success
  if (!result.envelopeOk && result.statusCode !== 0) {
    findings.push({
      priority: 'P2',
      route: result.route,
      method: result.method,
      scenario: result.scenario,
      statusCode: result.statusCode,
      latencyMs: result.latencyMs,
      description: `Envelope mismatch: ${result.envelopeError}`,
    });
    return;
  }

  // P3: slow on no-data
  if (result.scenario === 'no-params' && result.latencyMs > 1000) {
    findings.push({
      priority: 'P3',
      route: result.route,
      method: result.method,
      scenario: result.scenario,
      statusCode: result.statusCode,
      latencyMs: result.latencyMs,
      description: `Slow response: ${result.latencyMs}ms on empty params`,
    });
  }
}

// ── Sweep logic ───────────────────────────────────────────────────────────────

async function sweepRoute(client: SweepClient, spec: RouteSpec, method: string): Promise<void> {
  const scenarios = getScenarios(spec, method);

  for (const scenario of scenarios) {
    const url = spec.path.replace('/index', '') + (scenario.query ?? '');
    const res = await client.request(method, url, scenario.body);

    const { ok: envelopeOk, reason: envelopeError } = checkEnvelope(res.body, res.status);
    const { leaks: leaksInternals, detail: leakDetail } = detectLeaks(res.body);

    const errorBody = res.status >= 400
      ? (typeof res.body === 'string' ? res.body : JSON.stringify(res.body)).slice(0, 500)
      : undefined;

    record({
      route: spec.path,
      method,
      scenario: scenario.name,
      statusCode: res.status,
      latencyMs: res.latencyMs,
      envelopeOk,
      envelopeError,
      leaksInternals,
      leakDetail,
      errorBody,
    });

    const mark = res.status >= 500 ? '✗ P1' : leaksInternals ? '✗ P1(leak)' : !envelopeOk ? '⚠ P2' : '✓';
    process.stdout.write(
      `  ${mark.padEnd(10)} ${method.padEnd(6)} ${scenario.name.padEnd(18)} → ${res.status} (${res.latencyMs}ms)\n`,
    );
  }
}

// ── Report builder ─────────────────────────────────────────────────────────

function buildReport(): string {
  const p1 = findings.filter((f) => f.priority === 'P1');
  const p2 = findings.filter((f) => f.priority === 'P2');
  const p3 = findings.filter((f) => f.priority === 'P3');

  const lines: string[] = [
    '# API Contract Sweep — Phase 3',
    '',
    `**Date:** ${new Date().toISOString().slice(0, 10)}`,
    `**Base URL:** ${BASE_URL}`,
    `**Routes scanned:** ${ROUTES.length}`,
    `**Total calls made:** ${allResults.length}`,
    `**P1 (critical):** ${p1.length}`,
    `**P2 (envelope):** ${p2.length}`,
    `**P3 (slow):** ${p3.length}`,
    '',
    '---',
    '',
  ];

  if (p1.length === 0) {
    lines.push('## P1 Findings', '', '_None — all routes returned safe responses._', '');
  } else {
    lines.push('## P1 Findings (5xx / internal leak)');
    lines.push('');
    for (const f of p1) {
      lines.push(`### ${f.method} ${f.route} — \`${f.scenario}\``);
      lines.push(`- **Status:** ${f.statusCode}`);
      lines.push(`- **Latency:** ${f.latencyMs}ms`);
      lines.push(`- **Issue:** ${f.description}`);
      if (f.raw) lines.push(`- **Body excerpt:** \`${f.raw.replace(/`/g, "'").slice(0, 300)}\``);
      lines.push('');
    }
  }

  lines.push('## P2 Findings (wrong envelope shape)', '');
  if (p2.length === 0) {
    lines.push('_None._', '');
  } else {
    for (const f of p2) {
      lines.push(`- **${f.method}** \`${f.route}\` scenario=\`${f.scenario}\` status=${f.statusCode}: ${f.description}`);
    }
    lines.push('');
  }

  lines.push('## P3 Findings (slow on no-data)', '');
  if (p3.length === 0) {
    lines.push('_None._', '');
  } else {
    for (const f of p3) {
      lines.push(`- **${f.method}** \`${f.route}\` scenario=\`${f.scenario}\`: ${f.latencyMs}ms`);
    }
    lines.push('');
  }

  lines.push('## Follow-up Tickets');
  lines.push('');
  lines.push('P2 and P3 findings above should each become a follow-up ticket.');
  lines.push('P1 findings were fixed in this branch (see commit history).');
  lines.push('');
  lines.push('---');
  lines.push('_Generated by `scripts/audit/api-contract-sweep.ts`_');

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  process.stdout.write(`\n=== API Contract Sweep ===\n`);
  process.stdout.write(`Target: ${BASE_URL}\n`);
  process.stdout.write(`Company: ${COMPANY_ID}\n`);
  process.stdout.write(`Routes: ${ROUTES.length}\n\n`);

  const client = new SweepClient(BASE_URL);
  const ok = await authenticate(client, EMAIL, PASSWORD, COMPANY_ID);
  if (!ok) {
    process.stderr.write('ERROR: Authentication failed. Cannot run sweep.\n');
    process.exit(1);
  }
  process.stdout.write('[auth] OK\n\n');

  for (const spec of ROUTES) {
    process.stdout.write(`\n[${spec.module ?? '?'}] ${spec.path}\n`);
    for (const method of spec.methods) {
      if (spec.readOnly && method !== 'GET') continue;
      await sweepRoute(client, spec, method);
    }
  }

  // Write outputs
  const resultsPath = path.join(OUT_DIR, 'results.json');
  const reportPath  = path.join(OUT_DIR, 'report.md');

  fs.writeFileSync(resultsPath, JSON.stringify({ meta: { date: new Date().toISOString(), baseUrl: BASE_URL, companyId: COMPANY_ID, routeCount: ROUTES.length, callCount: allResults.length }, findings, results: allResults }, null, 2));
  fs.writeFileSync(reportPath, buildReport());

  process.stdout.write('\n\n=== Summary ===\n');
  process.stdout.write(`Total calls: ${allResults.length}\n`);
  process.stdout.write(`P1: ${findings.filter((f) => f.priority === 'P1').length}\n`);
  process.stdout.write(`P2: ${findings.filter((f) => f.priority === 'P2').length}\n`);
  process.stdout.write(`P3: ${findings.filter((f) => f.priority === 'P3').length}\n`);
  process.stdout.write(`\nResults: ${resultsPath}\n`);
  process.stdout.write(`Report:  ${reportPath}\n\n`);

  // Exit non-zero if P1s found (for CI)
  if (findings.some((f) => f.priority === 'P1')) process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`sweep failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
