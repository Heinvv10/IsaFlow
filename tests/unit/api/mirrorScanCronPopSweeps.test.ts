/**
 * POST /api/cron/mirror-scan runs the POP sweeps after the mail scan, under one deadline for the whole request
 * (start + 270 s, inside curl's --max-time 300), and reports their totals with the scan's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ order: [] as string[], scan: vi.fn(), pop: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/capture/imapMirrorService', () => ({ scanAllDueConnections: m.scan }));
vi.mock('@/modules/accounting/services/capture/pop/popSweeps', () => ({ runPopSweeps: m.pop }));

import cronRoute from '../../../pages/api/cron/mirror-scan';

const KEY = crypto.randomUUID();
const TOTALS = { match: { attached: 1 }, archive: { archived: 2 } };
beforeEach(() => {
  vi.clearAllMocks();
  m.order.length = 0;
  process.env.CRON_SECRET = KEY;
  m.scan.mockImplementation(async () => { m.order.push('scan'); return []; });
  m.pop.mockImplementation(async () => { m.order.push('pop'); return TOTALS; });
});

describe('/api/cron/mirror-scan: POP sweeps', () => {
  it('runs them after the scan with the request\'s deadline, and answers their totals', async () => {
    const r = { statusCode: 200, body: undefined as unknown,
      status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; }, setHeader() { return r; } };
    const before = Date.now();
    await (cronRoute as (q: unknown, s: unknown) => Promise<unknown>)({ method: 'POST', headers: { 'x-cron-secret': KEY }, socket: {} }, r);
    const after = Date.now();
    expect(r.statusCode).toBe(200);
    expect(m.order).toEqual(['scan', 'pop']);
    const { deadline } = m.pop.mock.calls[0]![0] as { deadline: number };
    expect(deadline).toBeGreaterThanOrEqual(before + 270_000);
    expect(deadline).toBeLessThanOrEqual(after + 270_000);
    expect(JSON.stringify(r.body)).toContain('"pop":{"match":{"attached":1},"archive":{"archived":2}}');
  });
});
