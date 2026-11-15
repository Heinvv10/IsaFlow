/**
 * PR #1405 breaker round 4 (E3): a SARS codes upload whose bytes start with the zip signature (so it passes the
 * magic-byte gate) but are not a readable zip was a 500. The workbook reader's corrupt-zip refusal is now a 400;
 * any other failure inside the reader stays a 500. The real parser (ExcelJS + JSZip) reads the bytes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ bytes: Buffer.alloc(0), importRows: vi.fn(), loadFails: null as Error | null }));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/admin/services/sarsCodesAdminService', () => ({ importRows: h.importRows, diffAgainstYear: vi.fn() }));
vi.mock('@/modules/admin/services/auditService', () => ({ logAdminAction: vi.fn() }));
vi.mock('@/utils/getIp', () => ({ getIp: vi.fn(() => '127.0.0.1') }));
vi.mock('@/modules/admin/middleware/withAdmin', async () => {
  const { withAdminRefusals } = await import('@/modules/admin/middleware/adminRequestErrors');
  return { withAdmin: (fn: Parameters<typeof withAdminRefusals>[0]) => withAdminRefusals(fn) };
});
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('formidable', () => ({
  default: () => ({
    parse: () => Promise.resolve([{ taxYear: ['2026'], brsVersion: ['v25.2.0'] }, {
      file: { mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filepath: '/tmp/fake-sars-upload' },
    }]),
  }),
}));
vi.mock('node:fs', () => ({ default: { readFileSync: vi.fn(() => h.bytes), unlinkSync: vi.fn() } }));
// The real ExcelJS, except that a test may make its load fail with a non-zip error.
vi.mock('exceljs', async (orig) => {
  const real = await orig<{ default: { Workbook: new () => { xlsx: { load: (b: unknown) => Promise<unknown> } } } }>();
  class Workbook extends real.default.Workbook {
    constructor() {
      super();
      const load = this.xlsx.load.bind(this.xlsx);
      this.xlsx.load = async (b: unknown) => { if (h.loadFails) throw h.loadFails; return load(b); };
    }
  }
  return { ...real, default: { ...real.default, Workbook } };
});

import handler from '../../../pages/api/admin/payroll/sars-codes/import';
import { callRoute } from '../helpers/adminRouteCall';

beforeEach(() => { vi.clearAllMocks(); h.loadFails = null; });

describe('sars-codes import: a PK-signed file that is not a readable zip', () => {
  it.each([
    ['the signature then garbage', Buffer.from('PK\u0003\u0004garbage garbage garbage')],
    ['the signature then 2 KB of filler', Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(2048, 7)])],
  ])('%s: 400, nothing imported', async (_name, bytes) => {
    h.bytes = bytes;
    const r = await callRoute(handler, 'POST', {});
    expect(r.statusCode).toBe(400);
    expect((r.body as { error?: { message?: string } }).error?.message).toMatch(/not a readable \.xlsx workbook/);
    expect(h.importRows).not.toHaveBeenCalled();
  });

  it('any other failure while reading the workbook is still a 500 (rethrown)', async () => {
    h.bytes = Buffer.from('PK\u0003\u0004garbage');
    h.loadFails = new Error('ENOMEM: out of memory');
    await expect(callRoute(handler, 'POST', {})).rejects.toThrow('ENOMEM');
  });
});
