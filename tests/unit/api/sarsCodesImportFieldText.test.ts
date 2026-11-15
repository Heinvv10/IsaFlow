/**
 * PR #1405 breaker round 3 (D5): /api/admin/payroll/sars-codes/import reads multipart (bodyParser off), so its
 * fields never reached withAdmin's JSON-body walk: a NUL or lone surrogate in brsVersion, or in a sheet cell, was a
 * 500 from Postgres. Now a 400 naming the field, before anything is imported, and the temp file is still removed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  fields: {} as Record<string, string[]>,
  rows: [] as Array<Record<string, unknown>>,
  importRows: vi.fn(async () => ({ upserted: 1, diff: { added: [], removed: [], changed: [] } })),
  unlinkSync: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/admin/services/sarsCodesParser', () => ({
  parseSarsCodesXlsxBuffer: vi.fn(async () => ({ rows: h.rows, errors: [] })),
}));
vi.mock('@/modules/admin/services/sarsCodesAdminService', () => ({ importRows: h.importRows, diffAgainstYear: vi.fn() }));
vi.mock('@/modules/admin/services/auditService', () => ({ logAdminAction: vi.fn() }));
vi.mock('@/utils/getIp', () => ({ getIp: vi.fn(() => '127.0.0.1') }));
// withAdmin's own refusal mapping (AdminRequestError -> its 4xx), without the auth gate.
vi.mock('@/modules/admin/middleware/withAdmin', async () => {
  const { withAdminRefusals } = await import('@/modules/admin/middleware/adminRequestErrors');
  return { withAdmin: (fn: Parameters<typeof withAdminRefusals>[0]) => withAdminRefusals(fn) };
});
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('formidable', () => ({
  default: () => ({
    parse: () => Promise.resolve([h.fields, {
      file: { mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filepath: '/tmp/fake-sars-upload' },
    }]),
  }),
}));
vi.mock('node:fs', () => ({
  default: { readFileSync: vi.fn(() => Buffer.from('PK\u0003\u0004 an xlsx container')), unlinkSync: h.unlinkSync },
}));

import handler from '../../../pages/api/admin/payroll/sars-codes/import';
import { callRoute } from '../helpers/adminRouteCall';

const ROW = { code: '3601', effective_year: 2026, category: 'income', description: 'Salary', status: 'active' };

beforeEach(() => {
  vi.clearAllMocks();
  h.fields = { taxYear: ['2026'], brsVersion: ['v25.2.0'] };
  h.rows = [ROW];
});

describe('sars-codes import: multipart text Postgres cannot store', () => {
  it.each([
    ['a NUL in brsVersion', { brsVersion: ['v25\u0000'] }, /^fields\.brsVersion\.0 must not contain a NUL/],
    ['a lone surrogate in brsVersion', { brsVersion: ['v25\ud800'] }, /^fields\.brsVersion\.0 .*surrogate/],
  ])('%s: 400 naming it, nothing imported, the temp file removed', async (_name, fields, named) => {
    h.fields = { ...h.fields, ...fields };
    const r = await callRoute(handler, 'POST', {});
    expect(r.statusCode).toBe(400);
    expect((r.body as { error?: { message?: string } }).error?.message).toMatch(named);
    expect(h.importRows).not.toHaveBeenCalled();
    expect(h.unlinkSync).toHaveBeenCalledTimes(1);
  });

  it('a NUL in a sheet cell: 400 naming the row and column, nothing imported', async () => {
    h.rows = [ROW, { ...ROW, code: '3602', description: 'bad\u0000' }];
    const r = await callRoute(handler, 'POST', {});
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/rows\.1\.description must not contain a NUL/);
    expect(h.importRows).not.toHaveBeenCalled();
  });

  it('clean fields and rows still import', async () => {
    const r = await callRoute(handler, 'POST', {});
    expect(r.statusCode).toBe(200);
    expect(h.importRows).toHaveBeenCalledTimes(1);
  });
});
