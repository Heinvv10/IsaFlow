import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => {
  const sqlMock = vi.fn();
  return { sqlMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  parseClientsCsv,
  buildClientsCsv,
  bulkExportClients,
  bulkImportClients,
  type ClientImportRow,
} from '@/modules/accounting/services/practice/practiceClientBulkService';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';

beforeEach(() => vi.clearAllMocks());

// ────────────────────────────────────────────────────────────────────────────
// parseClientsCsv
// ────────────────────────────────────────────────────────────────────────────

describe('parseClientsCsv', () => {
  it('parses a happy-path file with all columns', () => {
    const csv = [
      'legal_name,trading_name,registration_no,tax_no,billing_model,status',
      'Marneweck Holdings,Marneweck,2020/123456/07,1234567890,hourly,active',
      'Acme (Pty) Ltd,Acme,2018/0001/07,9876543210,fixed,onboarding',
    ].join('\n');

    const { rows, errors } = parseClientsCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      legalName: 'Marneweck Holdings',
      tradingName: 'Marneweck',
      billingModel: 'hourly',
      status: 'active',
    });
    expect(rows[1]?.billingModel).toBe('fixed');
  });

  it('reports missing required headers and stops', () => {
    const csv = 'legal_name,status\nAcme,active';
    const { rows, errors } = parseClientsCsv(csv);
    expect(rows).toHaveLength(0);
    expect(errors.some((e: { message: string }) => e.message.includes('billing_model'))).toBe(true);
  });

  it('returns an error when CSV is empty', () => {
    const { rows, errors } = parseClientsCsv('');
    expect(rows).toHaveLength(0);
    expect(errors[0]?.message).toBe('CSV is empty');
  });

  it('flags rows missing legal_name', () => {
    const csv = [
      'legal_name,billing_model,status',
      ',hourly,active',
    ].join('\n');
    const { rows, errors } = parseClientsCsv(csv);
    expect(rows).toHaveLength(0);
    expect(errors[0]).toMatchObject({ rowNumber: 1, message: 'legal_name is required' });
  });

  it('rejects invalid billing_model and status values', () => {
    const csv = [
      'legal_name,billing_model,status',
      'A,bogus,active',
      'B,hourly,nonsense',
    ].join('\n');
    const { rows, errors } = parseClientsCsv(csv);
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(2);
    expect(errors[0]?.message).toContain('billing_model');
    expect(errors[1]?.message).toContain('status');
  });

  it('detects duplicate legal_name within the file', () => {
    const csv = [
      'legal_name,billing_model,status',
      'Acme,hourly,active',
      'Acme,fixed,onboarding',
    ].join('\n');
    const { rows, errors } = parseClientsCsv(csv);
    expect(rows).toHaveLength(1);
    expect(errors[0]?.message).toContain('Duplicate legal_name within file');
  });

  it('handles quoted fields with commas, embedded newlines, and escaped quotes', () => {
    const csv =
      'legal_name,trading_name,billing_model,status\n' +
      '"Smith, Jones & Co","Smith\nJones","hourly","active"\n' +
      '"O""Brien Ltd",,fixed,prospect';
    const { rows, errors } = parseClientsCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.legalName).toBe('Smith, Jones & Co');
    expect(rows[0]?.tradingName).toBe('Smith\nJones');
    expect(rows[1]?.legalName).toBe('O"Brien Ltd');
    expect(rows[1]?.tradingName).toBeNull();
  });

  it('skips wholly blank lines and tolerates CRLF', () => {
    const csv =
      'legal_name,billing_model,status\r\n' +
      'Acme,hourly,active\r\n' +
      '\r\n' +
      'Beta,fixed,prospect\r\n';
    const { rows, errors } = parseClientsCsv(csv);
    expect(errors).toEqual([]);
    expect(rows.map((r: ClientImportRow) => r.legalName)).toEqual(['Acme', 'Beta']);
  });

  it('treats header lookup case-insensitively', () => {
    const csv = 'Legal_Name,Billing_Model,Status\nAcme,Hourly,Active';
    const { rows, errors } = parseClientsCsv(csv);
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ legalName: 'Acme', billingModel: 'hourly', status: 'active' });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildClientsCsv
// ────────────────────────────────────────────────────────────────────────────

describe('buildClientsCsv', () => {
  it('emits header even with no rows', () => {
    const csv = buildClientsCsv([]);
    expect(csv).toBe('legal_name,trading_name,registration_no,tax_no,billing_model,status');
  });

  it('escapes commas, quotes, and newlines', () => {
    const csv = buildClientsCsv([{
      legal_name: 'Smith, Jones',
      trading_name: 'O"Brien',
      registration_no: null,
      tax_no: null,
      billing_model: 'hourly',
      status: 'active',
    }]);
    const lines = csv.split('\n');
    expect(lines[1]).toBe('"Smith, Jones","O""Brien",,,hourly,active');
  });

  it('round-trips: built CSV parses back to the same rows', () => {
    const rows = [{
      legal_name: 'Acme, Inc',
      trading_name: 'Acme',
      registration_no: '2020/1/07',
      tax_no: '999',
      billing_model: 'fixed',
      status: 'onboarding',
    }];
    const parsed = parseClientsCsv(buildClientsCsv(rows));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({
      legalName: 'Acme, Inc',
      tradingName: 'Acme',
      registrationNo: '2020/1/07',
      taxNo: '999',
      billingModel: 'fixed',
      status: 'onboarding',
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// bulkExportClients
// ────────────────────────────────────────────────────────────────────────────

describe('bulkExportClients', () => {
  it('returns all clients when no ids are given', async () => {
    sqlMock.mockResolvedValueOnce([
      { legal_name: 'Acme', trading_name: null, registration_no: null, tax_no: null, billing_model: 'hourly', status: 'active' },
    ]);
    const out = await bulkExportClients(COMPANY);
    expect(out).toHaveLength(1);
    expect(out[0]?.legal_name).toBe('Acme');
  });

  it('filters by ids when provided', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const out = await bulkExportClients(COMPANY, ['cccccccc-0000-0000-0000-000000000003']);
    expect(out).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// bulkImportClients
// ────────────────────────────────────────────────────────────────────────────

describe('bulkImportClients', () => {
  const validRows: ClientImportRow[] = [
    { legalName: 'New One', tradingName: null, registrationNo: null, taxNo: null, billingModel: 'hourly', status: 'active' },
    { legalName: 'Already Here', tradingName: null, registrationNo: null, taxNo: null, billingModel: 'fixed', status: 'onboarding' },
  ];

  it('creates new rows and skips existing ones (by legal_name)', async () => {
    // 1. existing-name lookup
    sqlMock.mockResolvedValueOnce([{ legal_name: 'Already Here' }]);
    // 2. insert for "New One"
    sqlMock.mockResolvedValueOnce([]);

    const result = await bulkImportClients(COMPANY, validRows);
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('captures per-row insert failures without aborting the whole import', async () => {
    sqlMock.mockResolvedValueOnce([]); // no existing
    sqlMock.mockResolvedValueOnce([]); // first insert OK
    sqlMock.mockRejectedValueOnce(new Error('boom')); // second insert fails

    const result = await bulkImportClients(COMPANY, validRows);
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe('boom');
  });

  it('returns zeros when given no rows (no DB calls)', async () => {
    const result = await bulkImportClients(COMPANY, []);
    expect(result).toEqual({ created: 0, skipped: 0, errors: [] });
    expect(sqlMock).not.toHaveBeenCalled();
  });
});
