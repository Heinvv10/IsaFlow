/**
 * Unit tests for companySettingsService — document numbering helpers.
 * Mocks @/lib/neon's `sql` template tag and asserts on the formatted output
 * + sequence-of-calls semantics for ensure / reserve / peek / format.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => {
  const sqlMock = Object.assign(vi.fn(), { unsafe: vi.fn().mockReturnValue('') });
  return { sqlMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  formatDocumentNumber,
  reserveNextDocumentNumber,
  peekNextDocumentNumber,
} from '@/modules/accounting/services/core/companySettingsService';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

describe('formatDocumentNumber', () => {
  it('zero-pads to the requested width without a separator', () => {
    expect(formatDocumentNumber('INV', 130, 7)).toBe('INV0000130');
    expect(formatDocumentNumber('SIV', 18, 7)).toBe('SIV0000018');
    expect(formatDocumentNumber('CRN', 1, 7)).toBe('CRN0000001');
  });

  it('does not truncate numbers wider than the padding', () => {
    expect(formatDocumentNumber('INV', 12345678, 7)).toBe('INV12345678');
  });
});

describe('reserveNextDocumentNumber', () => {
  beforeEach(() => {
    sqlMock.mockReset();
  });

  it('returns formatted number and increments via single UPDATE...RETURNING', async () => {
    sqlMock.mockImplementation((strings: TemplateStringsArray) => {
      const s = strings.join(' ');
      if (s.includes('UPDATE company_document_numbers') && s.includes('RETURNING')) {
        return Promise.resolve([{ used: 130, prefix: 'INV', padding: 7 }]);
      }
      return Promise.resolve([]);
    });

    const result = await reserveNextDocumentNumber(COMPANY_ID, 'customer_invoice');
    expect(result).toBe('INV0000130');
    // Hot path: when the row exists, only one UPDATE call is made (no ensure seed loop).
    const updateCalls = sqlMock.mock.calls.filter(args => {
      const tpl = args[0] as TemplateStringsArray;
      return tpl.join(' ').includes('UPDATE company_document_numbers');
    });
    expect(updateCalls).toHaveLength(1);
  });

  it('seeds defaults and retries when the row is initially missing', async () => {
    let updateCallCount = 0;
    sqlMock.mockImplementation((strings: TemplateStringsArray) => {
      const s = strings.join(' ');
      if (s.includes('UPDATE company_document_numbers') && s.includes('RETURNING')) {
        updateCallCount += 1;
        if (updateCallCount === 1) return Promise.resolve([]); // initial miss
        return Promise.resolve([{ used: 1, prefix: 'INV', padding: 7 }]); // post-seed
      }
      return Promise.resolve([]);
    });

    const result = await reserveNextDocumentNumber(COMPANY_ID, 'customer_invoice');
    expect(result).toBe('INV0000001');
    expect(updateCallCount).toBe(2);
  });

  it('throws when no row exists even after seeding', async () => {
    sqlMock.mockImplementation((strings: TemplateStringsArray) => {
      const s = strings.join(' ');
      if (s.includes('UPDATE company_document_numbers') && s.includes('RETURNING')) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    await expect(
      reserveNextDocumentNumber(COMPANY_ID, 'nonexistent_type'),
    ).rejects.toThrow(/No document number config/);
  });

  it('produces SIV-formatted result for supplier invoices', async () => {
    sqlMock.mockImplementation((strings: TemplateStringsArray) => {
      const s = strings.join(' ');
      if (s.includes('UPDATE company_document_numbers') && s.includes('RETURNING')) {
        return Promise.resolve([{ used: 18, prefix: 'SIV', padding: 7 }]);
      }
      return Promise.resolve([]);
    });

    const result = await reserveNextDocumentNumber(COMPANY_ID, 'supplier_invoice');
    expect(result).toBe('SIV0000018');
  });
});

describe('peekNextDocumentNumber', () => {
  beforeEach(() => {
    sqlMock.mockReset();
  });

  it('reads next_number without incrementing', async () => {
    sqlMock.mockImplementation((strings: TemplateStringsArray) => {
      const s = strings.join(' ');
      if (s.includes('SELECT prefix, next_number, padding')) {
        return Promise.resolve([{ prefix: 'INV', next_number: 130, padding: 7 }]);
      }
      return Promise.resolve([]);
    });

    const result = await peekNextDocumentNumber(COMPANY_ID, 'customer_invoice');
    expect(result).toBe('INV0000130');
  });

  it('throws when row is missing', async () => {
    sqlMock.mockImplementation((strings: TemplateStringsArray) => {
      const s = strings.join(' ');
      if (s.includes('SELECT prefix, next_number, padding')) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    await expect(
      peekNextDocumentNumber(COMPANY_ID, 'nonexistent_type'),
    ).rejects.toThrow(/No document number config/);
  });
});
