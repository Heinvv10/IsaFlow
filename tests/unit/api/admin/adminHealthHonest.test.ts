/**
 * GET /api/admin/health (admin audit 2.8): a metric query that fails is an
 * error, never zeros that read as "All systems operational"; an email rate
 * with nothing attempted is null (a dash), not 100%; bounces count against
 * it; sign-ins come from users.last_login, not the dead user_sessions table.
 * The database is mocked: the SQL itself is pinned in
 * tests/integration/admin-metrics-sign-ins.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const fx = vi.hoisted(() => ({
  scalars: null as Record<string, unknown> | null,
  failScalars: false,
  failErrors: false,
  failDb: false,
  texts: [] as string[],
}));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/modules/admin/middleware/withAdmin', () => ({ withAdmin: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: vi.fn() }));
vi.mock('@/modules/admin/services/healthAlertService', () => ({ checkAndAlert: vi.fn(async () => undefined) }));
vi.mock('@/lib/neon', () => ({
  sql: async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    fx.texts.push(text);
    if (text.includes('pg_database_size')) {
      if (fx.failDb) throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
      return [{ size_mb: '12.5' }];
    }
    if (text.includes('background_jobs')) {
      if (fx.failScalars) throw new Error('relation "background_jobs" does not exist');
      return [fx.scalars];
    }
    if (fx.failErrors) throw new Error('statement timeout');
    return [];
  },
}));

import healthRoute from '../../../../pages/api/admin/health';

const ROW = { pending: 0, running: 0, failed: 0, oldest_pending_age_minutes: null, sent_24h: 0, failed_24h: 0,
  bounced_24h: 0, users_signed_in_24h: 4, expiring_in_7d: 0 };

async function call() {
  const req = { method: 'GET', query: {}, headers: {} } as unknown as NextApiRequest;
  const state = { statusCode: 200, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return res; },
    json(b: unknown) { state.body = b; return res; },
    setHeader() { return res; },
  } as unknown as NextApiResponse;
  await (healthRoute as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<void>)(req, res);
  return state as { statusCode: number; body: { data?: Record<string, unknown> } };
}

beforeEach(() => {
  fx.scalars = { ...ROW };
  fx.failScalars = false;
  fx.failErrors = false;
  fx.failDb = false;
  fx.texts = [];
  log.error.mockClear();
});

describe('a metric that cannot be read is an error', () => {
  it('the job/email/sign-in query failing answers 500, not a healthy page of zeros', async () => {
    fx.failScalars = true;
    const r = await call();
    expect(r.statusCode).toBe(500);
    const body = JSON.stringify(r.body);
    expect(body).not.toContain('healthy');
    // No SQL text, relation name or stack reaches the browser (review L4).
    expect(body).not.toMatch(/background_jobs|relation|SELECT|stack|at \w+ \(/i);
    expect(log.error).toHaveBeenCalledWith('Health metrics could not be read', expect.anything(), 'admin-health-api');
    // The 500 is the database error itself, not a later crash on a half-built payload.
    const failure = log.error.mock.calls.find((c) => c[0] === 'System health check failed');
    expect((failure?.[1] as { error?: Error } | undefined)?.error?.message).toBe('relation "background_jobs" does not exist');
  });

  it('the recent-errors query failing answers 500, not "no error events"', async () => {
    fx.failErrors = true;
    const r = await call();
    expect(r.statusCode).toBe(500);
    expect(log.error).toHaveBeenCalledWith('Recent error events could not be read', expect.anything(), 'admin-health-api');
  });
});

describe('the database probe (review L1)', () => {
  it('an unreachable database is status error with a fixed reason; the driver text is only logged', async () => {
    fx.failDb = true;
    const r = await call();
    expect(r.statusCode).toBe(200);
    expect(r.body.data?.db).toMatchObject({ status: 'error', error: 'database check failed' });
    expect(r.body.data?.overall_status).toBe('critical');
    expect(JSON.stringify(r.body)).not.toContain('ECONNREFUSED');
    expect(log.error).toHaveBeenCalledWith('Database health check failed',
      { message: 'connect ECONNREFUSED 10.0.0.5:5432' }, 'admin-health-api');
  });
});

describe('what the widgets measure', () => {
  it('no email attempted: no rate (null), and still healthy', async () => {
    const r = await call();
    expect(r.statusCode).toBe(200);
    expect(r.body.data?.email).toEqual({ sent_24h: 0, failed_24h: 0, bounced_24h: 0, success_rate_percent: null });
    expect(r.body.data?.overall_status).toBe('healthy');
  });

  it('bounces count against the accepted rate', async () => {
    fx.scalars = { ...ROW, sent_24h: 9, bounced_24h: 1 };
    const r = await call();
    // 9 / (9 + 0 + 1) = 90.0%, below the 95% line.
    expect((r.body.data?.email as { success_rate_percent: number }).success_rate_percent).toBe(90);
    expect(r.body.data?.overall_status).toBe('degraded');
  });

  it('sign-ins are users.last_login in the last 24 hours, not user_sessions', async () => {
    const r = await call();
    expect(r.body.data?.users_signed_in_24h).toBe(4);
    const scalarSql = fx.texts.find((t) => t.includes('background_jobs'))!;
    expect(scalarSql).toMatch(/FROM users\s+WHERE last_login >= NOW\(\) - INTERVAL '24 hours'/);
    expect(scalarSql).not.toContain('user_sessions');
  });
});
