/**
 * vatDeclaredElsewhereService — mark/unmark "VAT declared outside IsaFlow"
 * on a customer invoice or supplier bill. Owner/admin only, with a reason;
 * never touches the GL (no journal-posting import here at all).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const m = vi.hoisted(() => ({ sql: vi.fn(), logAuditOrThrow: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({
  logAuditOrThrow: m.logAuditOrThrow,
}));

import {
  markVatDeclaredElsewhere, unmarkVatDeclaredElsewhere, markVatDeclaredElsewhereBulk,
  VatDeclaredElsewhereForbiddenError, VatDeclaredElsewhereRefusal,
} from '@/modules/accounting/services/reports/vatDeclaredElsewhereService';

const COMPANY = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const OTHER_COMPANY = 'ffffffff-0000-4000-8000-ffffffffffff';
const USER = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const INV = 'cccccccc-0000-4000-8000-cccccccccccc';

beforeEach(() => {
  vi.clearAllMocks();
  m.logAuditOrThrow.mockResolvedValue(undefined);
});

describe('markVatDeclaredElsewhere', () => {
  it('refuses a non-owner/admin actor before any write', async () => {
    await expect(markVatDeclaredElsewhere(COMPANY, 'customer', INV, { userId: USER, role: 'manager' }, 'reason'))
      .rejects.toBeInstanceOf(VatDeclaredElsewhereForbiddenError);
    expect(m.sql).not.toHaveBeenCalled();
  });

  it('refuses a blank reason before any write', async () => {
    await expect(markVatDeclaredElsewhere(COMPANY, 'customer', INV, { userId: USER, role: 'owner' }, '   '))
      .rejects.toBeInstanceOf(VatDeclaredElsewhereRefusal);
    expect(m.sql).not.toHaveBeenCalled();
  });

  it('refuses a document not found in this company (no existence oracle)', async () => {
    m.sql.mockResolvedValue([]);
    await expect(markVatDeclaredElsewhere(OTHER_COMPANY, 'customer', INV, { userId: USER, role: 'owner' }, 'Historical'))
      .rejects.toBeInstanceOf(VatDeclaredElsewhereRefusal);
  });

  it('marks the document, scoped by company_id, and audit-logs it', async () => {
    m.sql.mockResolvedValue([{ id: INV }]);
    const result = await markVatDeclaredElsewhere(COMPANY, 'customer', INV, { userId: USER, role: 'admin' }, 'Historical import');
    expect(result).toEqual({ invoiceId: INV, marked: true });
    const values = m.sql.mock.calls[0]!.slice(1);
    expect(values).toContain(USER);
    expect(values).toContain('Historical import');
    expect(values).toContain(INV);
    expect(values).toContain(COMPANY);
    expect(m.logAuditOrThrow).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY, userId: USER, action: 'update', entityType: 'customer_invoice', entityId: INV,
    }));
  });

  it('marks a supplier bill via the supplier_invoices table', async () => {
    m.sql.mockResolvedValue([{ id: INV }]);
    await markVatDeclaredElsewhere(COMPANY, 'supplier', INV, { userId: USER, role: 'owner' }, 'Historical');
    expect(m.logAuditOrThrow).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'supplier_invoice' }));
  });
});

describe('markVatDeclaredElsewhereBulk', () => {
  it('refuses a non-owner/admin actor before touching any document', async () => {
    await expect(markVatDeclaredElsewhereBulk(COMPANY, 'customer', [INV, 'd-2'], { userId: USER, role: 'manager' }, 'r'))
      .rejects.toBeInstanceOf(VatDeclaredElsewhereForbiddenError);
    expect(m.sql).not.toHaveBeenCalled();
  });

  it('marks every id', async () => {
    m.sql.mockResolvedValue([{ id: INV }]);
    const results = await markVatDeclaredElsewhereBulk(COMPANY, 'customer', [INV, 'd-2'], { userId: USER, role: 'owner' }, 'r');
    expect(results).toHaveLength(2);
    expect(m.sql).toHaveBeenCalledTimes(2);
  });
});

describe('unmarkVatDeclaredElsewhere', () => {
  it('refuses a non-owner/admin actor before any write', async () => {
    await expect(unmarkVatDeclaredElsewhere(COMPANY, 'customer', INV, { userId: USER, role: 'manager' }, 'reason'))
      .rejects.toBeInstanceOf(VatDeclaredElsewhereForbiddenError);
    expect(m.sql).not.toHaveBeenCalled();
  });

  it('refuses a document that is not currently marked', async () => {
    m.sql.mockResolvedValue([]);
    await expect(unmarkVatDeclaredElsewhere(COMPANY, 'customer', INV, { userId: USER, role: 'owner' }, 'reopen'))
      .rejects.toBeInstanceOf(VatDeclaredElsewhereRefusal);
  });

  it('unmarks (restores the block) and audit-logs it', async () => {
    m.sql.mockResolvedValue([{ id: INV }]);
    const result = await unmarkVatDeclaredElsewhere(COMPANY, 'customer', INV, { userId: USER, role: 'admin' }, 'Turned out it was not filed');
    expect(result).toEqual({ invoiceId: INV, marked: false });
    expect(m.logAuditOrThrow).toHaveBeenCalledWith(expect.objectContaining({ entityId: INV }));
  });
});
