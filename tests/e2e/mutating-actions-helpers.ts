/**
 * Shared helpers for the Phase 2 mutating-actions audit spec.
 * Uses a shared chromium browser context (launched once) so cookies persist
 * across all tests in the suite — the same approach used by admin-qa.spec.ts.
 *
 * Target: local dev server http://localhost:3200 against isaflow_dev DB.
 * Company under test: ISAFlow Demo (Pty) Ltd — 00000000-0000-0000-0000-000000000001.
 */

import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { Client } from 'pg';
import path from 'path';
import fs from 'fs';

// ─── Constants ──────────────────────────────────────────────────────────────

export const BASE = 'http://localhost:3200';
export const DEMO_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@isaflow.co.za';
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'admin123';
export const DB_URL =
  'postgresql://postgres:447a69a1675988ce00129f813c9ded99@100.96.203.105:7772/isaflow_dev?sslmode=disable';

// UUID of the hein@isaflow.co.za user (owner in the demo company — has UUID format)
export const AUDIT_USER_ID = 'aeb3949e-6c93-4c17-bbdf-b6d2d99fa9a2'; // hein@isaflow.co.za

export const SCREENSHOT_DIR = path.join(process.cwd(), 'tmp/mutating-actions-audit/screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ─── Shared browser context (owned by the test suite) ──────────────────────

let sharedBrowser: Browser | null = null;
let sharedContext: BrowserContext | null = null;
let sharedPage: Page | null = null;
let csrfToken = '';

export async function initBrowser(): Promise<{ context: BrowserContext; page: Page }> {
  // Idempotent: if already initialized, return existing instances
  if (sharedPage && sharedBrowser && sharedContext) {
    return { context: sharedContext, page: sharedPage };
  }

  sharedBrowser = await chromium.launch({ headless: true });
  sharedContext = await sharedBrowser.newContext({ viewport: { width: 1280, height: 900 } });
  sharedPage = await sharedContext.newPage();

  // Log in via API (avoids page-form interaction and is more reliable)
  const loginRes = await sharedPage.request.post(`${BASE}/api/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    headers: { 'content-type': 'application/json' },
  });
  if (!loginRes.ok()) {
    const body = await loginRes.text();
    throw new Error(`Login failed (${loginRes.status()}): ${body}`);
  }

  // Navigate to /accounting — middleware will issue the CSRF cookie on this request
  const pageRes = await sharedPage.request.get(`${BASE}/accounting`, {
    headers: { 'x-company-id': DEMO_COMPANY_ID },
    maxRedirects: 5,
  });
  // Extract CSRF from Set-Cookie header
  const rawSetCookie = pageRes.headers()['set-cookie'] ?? '';
  const csrfMatch = rawSetCookie.match(/isaflow_csrf=([^;,\s]+)/);
  csrfToken = csrfMatch?.[1] ?? '';

  // If CSRF still missing, read from the cookie jar
  if (!csrfToken) {
    const cookies = await sharedContext.cookies();
    const csrfCookie = cookies.find((c) => c.name === 'isaflow_csrf');
    csrfToken = csrfCookie?.value ?? '';
  }

  return { context: sharedContext, page: sharedPage };
}

export async function closeBrowser(): Promise<void> {
  // Only close if this is the last spec referencing the shared context
  // (both spec files call this; the second call is a no-op)
  await sharedContext?.close().catch(() => undefined);
  await sharedBrowser?.close().catch(() => undefined);
  sharedContext = null;
  sharedBrowser = null;
  sharedPage = null;
  csrfToken = '';
}

export function getSharedPage(): Page {
  if (!sharedPage) throw new Error('Browser not initialized — call initBrowser() first');
  return sharedPage;
}

export function getCsrfToken(): string {
  return csrfToken;
}

/** Make an authenticated API request using the shared browser context's cookies. */
export async function apiPost(
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const page = getSharedPage();
  const res = await page.request.post(`${BASE}${path}`, {
    data: body as Record<string, unknown>,
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
      'x-admin-request': 'true',
      ...extraHeaders,
    },
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json };
}

export async function apiPatch(
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const page = getSharedPage();
  const res = await page.request.patch(`${BASE}${path}`, {
    data: body as Record<string, unknown>,
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
      'x-admin-request': 'true',
      ...extraHeaders,
    },
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json };
}

export async function apiDelete(
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const page = getSharedPage();
  const res = await page.request.delete(`${BASE}${path}`, {
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
      'x-admin-request': 'true',
      ...extraHeaders,
    },
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json };
}

// ─── DB helpers ─────────────────────────────────────────────────────────────

export async function dbQuery<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const { rows } = await client.query<T>(sql, params);
    return rows;
  } finally {
    await client.end();
  }
}

export async function dbRun(sql: string, params: unknown[] = []): Promise<void> {
  await dbQuery(sql, params);
}

// ─── Screenshot helper ───────────────────────────────────────────────────────

export async function screenshot(page: Page, name: string): Promise<string> {
  const file = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
  return file;
}

// ─── Result accumulator ──────────────────────────────────────────────────────

export interface ActionResult {
  action: string;
  pass: boolean;
  statusCode: number;
  latencyMs: number;
  dbDiff: { before: unknown; after: unknown; restored: unknown };
  screenshotPath: string;
  notes: string;
}

export const results: ActionResult[] = [];

export function recordResult(r: ActionResult): void {
  results.push(r);
}

export function saveResults(): void {
  const outDir = path.join(process.cwd(), 'tmp/mutating-actions-audit');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
}
