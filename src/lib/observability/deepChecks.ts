/**
 * Dependency checks for /api/health/deep.
 *
 * Each check returns a CheckResult with a status and duration, never throws.
 * Each check wraps its work in a Promise.race with HEALTH_CHECK_TIMEOUT_MS.
 *
 * SMTP: Attempts to verify a nodemailer transport exported from
 * `@/lib/email/transport`. If that module does not exist, status is 'skipped'.
 *
 * Stitch: Performs a HEAD request against STITCH_HEALTH_URL or STITCH_API_URL.
 * If neither env var is set, status is 'skipped'.
 */

import { sql } from '@/lib/neon';

export type CheckStatus = 'ok' | 'down' | 'skipped';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  durationMs: number;
  error?: string;
}

const HEALTH_CHECK_TIMEOUT_MS = Number(process.env.HEALTH_CHECK_TIMEOUT_MS ?? 2000);

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function time<T>(
  fn: () => Promise<T>,
): Promise<{ result?: T; error?: Error; durationMs: number }> {
  const start = Date.now();
  try {
    const result = await withTimeout(fn(), HEALTH_CHECK_TIMEOUT_MS);
    return { result, durationMs: Date.now() - start };
  } catch (err) {
    return { error: err as Error, durationMs: Date.now() - start };
  }
}

export async function checkDb(): Promise<CheckResult> {
  const { error, durationMs } = await time(() => sql`SELECT 1` as unknown as Promise<unknown>);
  if (error) return { name: 'db', status: 'down', durationMs, error: error.message };
  return { name: 'db', status: 'ok', durationMs };
}

export async function checkSmtp(): Promise<CheckResult> {
  // Best-effort — only runs if a nodemailer transport is exported from
  // `@/lib/email/transport` with a `verify()` method. Otherwise `skipped`.
  // The module path is built at runtime to avoid a TS2307 error for an
  // optional module that may not exist in all deployments.
  const start = Date.now();
  try {
    const transportPath = ['@', 'lib', 'email', 'transport'].join('/');
    const mod: unknown = await import(/* @vite-ignore */ transportPath).catch(() => null);
    const transport = (mod as Record<string, unknown> | null)?.transport
      ?? (mod as Record<string, unknown> | null)?.default;
    if (!transport || typeof (transport as Record<string, unknown>).verify !== 'function') {
      return { name: 'smtp', status: 'skipped', durationMs: Date.now() - start };
    }
    await withTimeout(
      (transport as { verify: () => Promise<unknown> }).verify(),
      HEALTH_CHECK_TIMEOUT_MS,
    );
    return { name: 'smtp', status: 'ok', durationMs: Date.now() - start };
  } catch (err) {
    return {
      name: 'smtp',
      status: 'down',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function checkStitch(): Promise<CheckResult> {
  const start = Date.now();
  const url = process.env.STITCH_HEALTH_URL ?? process.env.STITCH_API_URL;
  if (!url) return { name: 'stitch', status: 'skipped', durationMs: Date.now() - start };
  try {
    const res = await withTimeout(fetch(url, { method: 'HEAD' }), HEALTH_CHECK_TIMEOUT_MS);
    if (!res.ok) {
      return {
        name: 'stitch',
        status: 'down',
        durationMs: Date.now() - start,
        error: `HTTP ${res.status}`,
      };
    }
    return { name: 'stitch', status: 'ok', durationMs: Date.now() - start };
  } catch (err) {
    return {
      name: 'stitch',
      status: 'down',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
