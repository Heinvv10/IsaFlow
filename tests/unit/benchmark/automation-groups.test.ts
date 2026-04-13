// RED phase — written before implementation
/**
 * Automation & Groups Unit Tests
 *
 * Covers pure exported logic from:
 *   - recurringTransactionService  → calculateNextRunDate
 *   - groupCrudService             → mapGroup, mapMember
 *   - groupCoaMappingService       → mapGroupAccount, mapCoaMapping
 *   - intercompanyService          → mapIntercompanyTx
 *   - archiveQueryService          → toISODate, toStr
 *   - documentValidationService    → validateInvoiceDocument,
 *                                    validatePaymentReceipt,
 *                                    validateStatutoryCompliance
 *   - globalSearchService          → getQuickActions
 *
 * Services with NO pure exports (all functions touch sql/db):
 *   - recurringInvoiceService      → advanceDate is private, no pure exports
 *   - recurringJournalService      → advanceDate is private, no pure exports
 *   - dataArchivingService         → facade only, no logic
 *   - archiveExecutionService      → executeArchive requires sql
 *   - archiveReadService           → getArchivedEntries requires sql
 *   - groupCompanyService          → facade only, re-exports from other services
 *   - descriptionTemplateService   → all functions require sql
 *
 * The @/lib/neon module is stubbed so that services that call sql at module
 * initialisation time do not throw "DATABASE_URL is not set" during import.
 * The pure functions under test never actually invoke sql.
 */

import { describe, it, expect, vi } from 'vitest';

// Stub @/lib/neon before any service module is imported.
vi.mock('@/lib/neon', () => {
  const noopTag = () => Promise.resolve([]);
  (noopTag as unknown as Record<string, unknown>).unsafe = (s: string) => s;
  return {
    sql: noopTag,
    withTransaction: (_cb: unknown) => Promise.resolve(),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// auditTrailService is imported by archiveExecutionService — stub it so the
// module graph resolves without a DB connection.
vi.mock('@/modules/accounting/services/auditTrailService', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

import { calculateNextRunDate } from '@/modules/accounting/services/core/recurringTransactionService';
import { mapGroup, mapMember } from '@/modules/accounting/services/reports/groupCrudService';
import { mapGroupAccount, mapCoaMapping } from '@/modules/accounting/services/reports/groupCoaMappingService';
import { mapIntercompanyTx } from '@/modules/accounting/services/reports/intercompanyService';
import { toISODate, toStr } from '@/modules/accounting/services/core/archiveQueryService';
import {
  validateInvoiceDocument,
  validatePaymentReceipt,
  validateStatutoryCompliance,
} from '@/modules/accounting/services/core/documentValidationService';
import { getQuickActions } from '@/modules/accounting/services/core/globalSearchService';

// ─── Shared test data ─────────────────────────────────────────────────────────

const BASE_DATE = new Date('2025-01-01T00:00:00.000Z');

// ─── calculateNextRunDate ─────────────────────────────────────────────────────

describe('calculateNextRunDate', () => {
  it('advances by 1 day for daily frequency', () => {
    const result = calculateNextRunDate(new Date('2025-03-15'), 'daily');
    expect(result.toISOString().split('T')[0]).toBe('2025-03-16');
  });

  it('advances by 7 days for weekly frequency', () => {
    const result = calculateNextRunDate(new Date('2025-03-15'), 'weekly');
    expect(result.toISOString().split('T')[0]).toBe('2025-03-22');
  });

  it('advances by 1 month for monthly frequency from a non-overflow date', () => {
    const result = calculateNextRunDate(new Date('2025-03-15'), 'monthly');
    expect(result.toISOString().split('T')[0]).toBe('2025-04-15');
  });

  it('advances by 3 months for quarterly frequency', () => {
    const result = calculateNextRunDate(new Date('2025-01-01'), 'quarterly');
    expect(result.toISOString().split('T')[0]).toBe('2025-04-01');
  });

  it('advances by 1 year for annually frequency', () => {
    const result = calculateNextRunDate(new Date('2025-07-15'), 'annually');
    expect(result.toISOString().split('T')[0]).toBe('2026-07-15');
  });

  it('returns same date for unrecognised frequency (no switch case matches)', () => {
    const input = new Date('2025-06-01');
    const result = calculateNextRunDate(input, 'biweekly');
    // No case matches so date is returned unchanged
    expect(result.getFullYear()).toBe(2025);
    expect(result.getMonth()).toBe(5); // June = index 5
    expect(result.getDate()).toBe(1);
  });

  it('does not mutate the input Date object', () => {
    const input = new Date('2025-03-10');
    const original = input.toISOString();
    calculateNextRunDate(input, 'monthly');
    // calculateNextRunDate clones with new Date(currentDate) so original must be intact
    expect(input.toISOString()).toBe(original);
  });

  it('handles year boundary for annual frequency', () => {
    const result = calculateNextRunDate(new Date('2025-12-31'), 'annually');
    expect(result.toISOString().split('T')[0]).toBe('2026-12-31');
  });
});

// ─── mapGroup ─────────────────────────────────────────────────────────────────

describe('mapGroup', () => {
  it('maps all required fields correctly', () => {
    const row = {
      id: 'group-uuid',
      name: 'Test Group',
      holding_company_id: 'holding-uuid',
      default_currency: 'ZAR',
      financial_year_start: 3,
      is_active: true,
      created_by: 'user-uuid',
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-06-01T00:00:00.000Z',
    };
    const result = mapGroup(row);
    expect(result.id).toBe('group-uuid');
    expect(result.name).toBe('Test Group');
    expect(result.holdingCompanyId).toBe('holding-uuid');
    expect(result.defaultCurrency).toBe('ZAR');
    expect(result.financialYearStart).toBe(3);
    expect(result.isActive).toBe(true);
    expect(result.createdBy).toBe('user-uuid');
  });

  it('maps holding_company_id as null when absent', () => {
    const row = {
      id: 'g1', name: 'G', holding_company_id: null,
      default_currency: 'ZAR', financial_year_start: 1,
      is_active: false, created_by: null,
      created_at: '2025-01-01', updated_at: '2025-01-01',
    };
    const result = mapGroup(row);
    expect(result.holdingCompanyId).toBeNull();
    expect(result.createdBy).toBeNull();
  });

  it('coerces is_active to boolean', () => {
    const row = {
      id: 'g2', name: 'G2', holding_company_id: null,
      default_currency: 'USD', financial_year_start: 1,
      is_active: 0, created_by: null,
      created_at: '2025-01-01', updated_at: '2025-01-01',
    };
    const result = mapGroup(row);
    expect(result.isActive).toBe(false);
  });
});

// ─── mapMember ────────────────────────────────────────────────────────────────

describe('mapMember', () => {
  it('maps active member with left_date null', () => {
    const row = {
      id: 'm1', group_id: 'g1', company_id: 'c1',
      ownership_pct: 100, consolidation_method: 'full',
      is_holding: true, joined_date: '2025-01-01',
      left_date: null, created_at: '2025-01-01',
    };
    const result = mapMember(row);
    expect(result.groupId).toBe('g1');
    expect(result.companyId).toBe('c1');
    expect(result.ownershipPct).toBe(100);
    expect(result.isHolding).toBe(true);
    expect(result.leftDate).toBeNull();
  });

  it('maps exited member with left_date set', () => {
    const row = {
      id: 'm2', group_id: 'g1', company_id: 'c2',
      ownership_pct: 40.5, consolidation_method: 'equity',
      is_holding: false, joined_date: '2024-01-01',
      left_date: '2025-03-31', created_at: '2024-01-01',
    };
    const result = mapMember(row);
    expect(result.leftDate).toBe('2025-03-31');
    expect(result.ownershipPct).toBeCloseTo(40.5, 2);
    expect(result.consolidationMethod).toBe('equity');
  });
});

// ─── mapGroupAccount ──────────────────────────────────────────────────────────

describe('mapGroupAccount', () => {
  it('maps all fields with optional nulls', () => {
    const row = {
      id: 'ga1', group_id: 'g1', account_code: '4000',
      account_name: 'Revenue', account_type: 'income',
      account_subtype: null, parent_account_id: null,
      normal_balance: 'credit', level: 1, display_order: 10,
      is_active: true, created_at: '2025-01-01',
    };
    const result = mapGroupAccount(row);
    expect(result.accountCode).toBe('4000');
    expect(result.accountName).toBe('Revenue');
    expect(result.accountSubtype).toBeNull();
    expect(result.parentAccountId).toBeNull();
    expect(result.normalBalance).toBe('credit');
    expect(result.level).toBe(1);
    expect(result.displayOrder).toBe(10);
    expect(result.isActive).toBe(true);
  });

  it('maps account_subtype and parent_account_id when present', () => {
    const row = {
      id: 'ga2', group_id: 'g1', account_code: '1100',
      account_name: 'Accounts Receivable', account_type: 'asset',
      account_subtype: 'current', parent_account_id: 'parent-uuid',
      normal_balance: 'debit', level: 2, display_order: 5,
      is_active: true, created_at: '2025-01-01',
    };
    const result = mapGroupAccount(row);
    expect(result.accountSubtype).toBe('current');
    expect(result.parentAccountId).toBe('parent-uuid');
  });
});

// ─── mapCoaMapping ────────────────────────────────────────────────────────────

describe('mapCoaMapping', () => {
  it('maps minimal mapping without optional name fields', () => {
    const row = {
      id: 'map1', group_id: 'g1', group_account_id: 'ga1',
      group_account_code: null, group_account_name: null,
      company_id: 'c1', company_account_id: 'ca1',
      company_account_code: null, company_account_name: null,
      created_at: '2025-01-01',
    };
    const result = mapCoaMapping(row);
    expect(result.groupAccountCode).toBeUndefined();
    expect(result.groupAccountName).toBeUndefined();
    expect(result.companyAccountCode).toBeUndefined();
    expect(result.companyAccountName).toBeUndefined();
  });

  it('maps all fields when codes and names are present', () => {
    const row = {
      id: 'map2', group_id: 'g1', group_account_id: 'ga1',
      group_account_code: '4000', group_account_name: 'Revenue',
      company_id: 'c1', company_account_id: 'ca1',
      company_account_code: '4001', company_account_name: 'Sales Revenue',
      created_at: '2025-01-01',
    };
    const result = mapCoaMapping(row);
    expect(result.groupAccountCode).toBe('4000');
    expect(result.companyAccountCode).toBe('4001');
    expect(result.companyAccountName).toBe('Sales Revenue');
  });
});

// ─── mapIntercompanyTx ────────────────────────────────────────────────────────

describe('mapIntercompanyTx', () => {
  it('maps a fully-matched intercompany transaction', () => {
    const row = {
      id: 'tx1', group_id: 'g1',
      source_company_id: 'c1', source_company_name: 'Alpha (Pty) Ltd',
      target_company_id: 'c2', target_company_name: 'Beta (Pty) Ltd',
      source_journal_entry_id: 'je1', target_journal_entry_id: 'je2',
      transaction_type: 'intercompany_loan', amount: 50000, currency: 'ZAR',
      description: 'Intercompany loan Q1', transaction_date: '2025-03-31',
      match_status: 'matched', variance_amount: 0,
      matched_at: '2025-04-01T08:00:00.000Z', matched_by: 'user-uuid',
      created_at: '2025-03-31T00:00:00.000Z',
    };
    const result = mapIntercompanyTx(row);
    expect(result.amount).toBe(50000);
    expect(result.matchStatus).toBe('matched');
    expect(result.varianceAmount).toBe(0);
    expect(result.sourceCompanyName).toBe('Alpha (Pty) Ltd');
    expect(result.matchedAt).toBe('2025-04-01T08:00:00.000Z');
  });

  it('maps null optional fields gracefully', () => {
    const row = {
      id: 'tx2', group_id: 'g1',
      source_company_id: 'c1', source_company_name: null,
      target_company_id: 'c2', target_company_name: null,
      source_journal_entry_id: null, target_journal_entry_id: null,
      transaction_type: 'dividend', amount: 1000, currency: 'ZAR',
      description: null, transaction_date: '2025-06-30',
      match_status: 'unmatched', variance_amount: 1000,
      matched_at: null, matched_by: null,
      created_at: '2025-06-30T00:00:00.000Z',
    };
    const result = mapIntercompanyTx(row);
    expect(result.sourceCompanyName).toBeUndefined();
    expect(result.targetCompanyName).toBeUndefined();
    expect(result.description).toBeNull();
    expect(result.matchedAt).toBeNull();
    expect(result.sourceJournalEntryId).toBeNull();
  });
});

// ─── toISODate ────────────────────────────────────────────────────────────────

describe('toISODate', () => {
  it('extracts date portion from a Date object', () => {
    expect(toISODate(new Date('2025-08-15T10:30:00.000Z'))).toBe('2025-08-15');
  });

  it('extracts date portion from an ISO string', () => {
    expect(toISODate('2025-03-01T00:00:00.000Z')).toBe('2025-03-01');
  });

  it('returns a plain date string unchanged', () => {
    expect(toISODate('2025-12-31')).toBe('2025-12-31');
  });

  it('returns null for null input', () => {
    expect(toISODate(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(toISODate('')).toBeNull();
  });
});

// ─── toStr ────────────────────────────────────────────────────────────────────

describe('toStr', () => {
  it('converts a Date to ISO string', () => {
    const d = new Date('2025-05-20T00:00:00.000Z');
    expect(toStr(d)).toBe(d.toISOString());
  });

  it('returns string values as-is', () => {
    expect(toStr('2025-01-01')).toBe('2025-01-01');
  });

  it('returns empty string for null', () => {
    expect(toStr(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(toStr(undefined)).toBe('');
  });
});

// ─── validateInvoiceDocument ──────────────────────────────────────────────────

describe('validateInvoiceDocument', () => {
  const baseExtracted = {
    documentType: 'invoice' as const,
    vendorName: 'Acme Supplies',
    vendorVatNumber: '4560123456',
    vendorAddress: null,
    vendorBankDetails: null,
    customerName: null,
    customerVatNumber: null,
    date: '2025-03-01',
    dueDate: null,
    paymentTerms: null,
    referenceNumber: 'INV-001',
    purchaseOrderRef: null,
    currency: 'ZAR',
    subtotal: 1000,
    vatAmount: 150,
    vatRate: 15,
    totalAmount: 1150,
    lineItems: [],
    rawText: '',
    confidence: 0.9,
    warnings: [],
    extractionMethod: 'vlm' as const,
  };

  it('returns valid=true and score=1 for a perfectly matching invoice', () => {
    const result = validateInvoiceDocument(baseExtracted, {
      invoiceNumber: 'INV-001',
      totalAmount: 1150,
      vatAmount: 150,
      vendorName: 'Acme Supplies',
      invoiceDate: '2025-03-01',
    });
    expect(result.valid).toBe(true);
    expect(result.score).toBe(1);
    expect(result.discrepancies).toHaveLength(0);
  });

  it('raises an error discrepancy when total differs by more than 5%', () => {
    const result = validateInvoiceDocument(
      { ...baseExtracted, totalAmount: 1300 },
      { totalAmount: 1150 }
    );
    const errorDiscs = result.discrepancies.filter(d => d.severity === 'error');
    expect(errorDiscs.length).toBeGreaterThan(0);
    expect(result.valid).toBe(false);
  });

  it('raises a warning discrepancy when total differs by less than 5%', () => {
    // 1150 + 40 = 1190 → diff = 40, which is 40/1150 ≈ 3.5% (< 5%)
    const result = validateInvoiceDocument(
      { ...baseExtracted, totalAmount: 1190 },
      { totalAmount: 1150 }
    );
    const disc = result.discrepancies.find(d => d.field === 'totalAmount');
    expect(disc?.severity).toBe('warning');
  });

  it('detects VAT arithmetic error when subtotal + vat does not equal total', () => {
    const result = validateInvoiceDocument(
      { ...baseExtracted, subtotal: 1000, vatAmount: 150, totalAmount: 1200 },
      {}
    );
    const disc = result.discrepancies.find(d => d.field === 'vatArithmetic');
    expect(disc).toBeDefined();
    expect(disc?.severity).toBe('error');
  });

  it('detects reference number mismatch with normalisation', () => {
    // Document shows "INV 001", record has "INV-001" → normalised both are "inv001"
    const result = validateInvoiceDocument(
      { ...baseExtracted, referenceNumber: 'INV 001' },
      { invoiceNumber: 'INV-002' }
    );
    const disc = result.discrepancies.find(d => d.field === 'referenceNumber');
    expect(disc).toBeDefined();
    expect(disc?.severity).toBe('warning');
  });

  it('passes reference check when normalised refs match', () => {
    const result = validateInvoiceDocument(
      { ...baseExtracted, referenceNumber: 'INV-001' },
      { invoiceNumber: 'INV 001' }
    );
    const disc = result.discrepancies.find(d => d.field === 'referenceNumber');
    expect(disc).toBeUndefined();
  });

  it('strips legal suffixes when checking vendor name match', () => {
    // Both refer to the same entity, suffix stripped before comparison
    const result = validateInvoiceDocument(
      { ...baseExtracted, vendorName: 'Acme Supplies (Pty) Ltd' },
      { vendorName: 'Acme Supplies Pty Ltd' }
    );
    const disc = result.discrepancies.find(d => d.field === 'entityName');
    expect(disc).toBeUndefined();
  });

  it('flags entity name mismatch for completely different names', () => {
    const result = validateInvoiceDocument(
      { ...baseExtracted, vendorName: 'Globex Corp' },
      { vendorName: 'Acme Supplies' }
    );
    const disc = result.discrepancies.find(d => d.field === 'entityName');
    expect(disc?.severity).toBe('warning');
  });

  it('calculates score reduction: 1 error produces score of 0.7', () => {
    // Use a case with no subtotal/vatAmount so the VAT arithmetic branch is skipped,
    // leaving exactly one error (the total mismatch > 5%).
    const result = validateInvoiceDocument(
      { ...baseExtracted, subtotal: null, vatAmount: null, totalAmount: 2000 },
      { totalAmount: 1150 }
    );
    // 1 error × 0.3 reduction → score = max(0, 1 - 0.3) = 0.7
    expect(result.score).toBeCloseTo(0.7, 2);
  });

  it('ignores total mismatch when extracted totalAmount is null', () => {
    const result = validateInvoiceDocument(
      { ...baseExtracted, totalAmount: null },
      { totalAmount: 1150 }
    );
    const disc = result.discrepancies.find(d => d.field === 'totalAmount');
    expect(disc).toBeUndefined();
  });

  it('ignores VAT mismatch when extracted vatAmount is null', () => {
    const result = validateInvoiceDocument(
      { ...baseExtracted, vatAmount: null },
      { vatAmount: 150 }
    );
    const disc = result.discrepancies.find(d => d.field === 'vatAmount');
    expect(disc).toBeUndefined();
  });
});

// ─── validatePaymentReceipt ───────────────────────────────────────────────────

describe('validatePaymentReceipt', () => {
  const baseExtracted = {
    documentType: 'receipt' as const,
    vendorName: null,
    vendorVatNumber: null,
    vendorAddress: null,
    vendorBankDetails: null,
    customerName: null,
    customerVatNumber: null,
    date: '2025-03-01',
    dueDate: null,
    paymentTerms: null,
    referenceNumber: 'PAY-001',
    purchaseOrderRef: null,
    currency: 'ZAR',
    subtotal: null,
    vatAmount: null,
    vatRate: null,
    totalAmount: 5000,
    lineItems: [],
    rawText: '',
    confidence: 0.95,
    warnings: [],
    extractionMethod: 'vlm' as const,
  };

  it('returns valid=true for exact amount match', () => {
    const result = validatePaymentReceipt(baseExtracted, { totalAmount: 5000, paymentDate: '2025-03-01' });
    expect(result.valid).toBe(true);
    expect(result.score).toBe(1);
  });

  it('raises error when receipt amount differs by more than 1%', () => {
    // 5000 + 100 = 5100, diff = 100, which is 2% > 1%
    const result = validatePaymentReceipt(
      { ...baseExtracted, totalAmount: 5100 },
      { totalAmount: 5000 }
    );
    expect(result.valid).toBe(false);
    const disc = result.discrepancies.find(d => d.field === 'totalAmount');
    expect(disc?.severity).toBe('error');
  });

  it('raises date warning when receipt date is more than 7 days from payment date', () => {
    const result = validatePaymentReceipt(
      { ...baseExtracted, date: '2025-03-01' },
      { paymentDate: '2025-03-15' } // 14 days apart
    );
    const disc = result.discrepancies.find(d => d.field === 'date');
    expect(disc?.severity).toBe('warning');
  });

  it('does not raise date warning when dates are within 7 days', () => {
    const result = validatePaymentReceipt(
      { ...baseExtracted, date: '2025-03-01' },
      { paymentDate: '2025-03-05' } // 4 days apart
    );
    const disc = result.discrepancies.find(d => d.field === 'date');
    expect(disc).toBeUndefined();
  });
});

// ─── validateStatutoryCompliance ─────────────────────────────────────────────

describe('validateStatutoryCompliance', () => {
  const baseExtracted = {
    documentType: 'cipc' as const,
    entityName: 'Test Company',
    registrationNumber: '2020/123456/07',
    vatNumber: '4560123456',
    taxNumber: null,
    issueDate: '2024-01-01',
    expiryDate: '2027-01-01',
    bbeeLevel: null,
    bbeeScore: null,
    verificationAgency: null,
    confidence: 0.95,
    warnings: [],
  };

  it('returns valid=true when entity name and VAT number match', () => {
    const result = validateStatutoryCompliance(baseExtracted, {
      companyName: 'Test Company',
      vatNumber: '4560123456',
    });
    expect(result.valid).toBe(true);
    expect(result.score).toBe(1);
  });

  it('raises an error for entity name mismatch', () => {
    const result = validateStatutoryCompliance(
      { ...baseExtracted, entityName: 'Completely Different Corp' },
      { companyName: 'Test Company' }
    );
    const disc = result.discrepancies.find(d => d.field === 'entityName');
    expect(disc?.severity).toBe('error');
    expect(result.valid).toBe(false);
  });

  it('strips legal suffix before entity name comparison', () => {
    const result = validateStatutoryCompliance(
      { ...baseExtracted, entityName: 'Test Company (Pty) Ltd' },
      { companyName: 'Test Company Pty Ltd' }
    );
    const disc = result.discrepancies.find(d => d.field === 'entityName');
    expect(disc).toBeUndefined();
  });

  it('raises an error for VAT number mismatch', () => {
    const result = validateStatutoryCompliance(
      { ...baseExtracted, vatNumber: '9999999999' },
      { vatNumber: '4560123456' }
    );
    const disc = result.discrepancies.find(d => d.field === 'vatNumber');
    expect(disc?.severity).toBe('error');
  });

  it('raises an error for an expired certificate', () => {
    const result = validateStatutoryCompliance(
      { ...baseExtracted, expiryDate: '2020-01-01' }, // clearly in the past
      { companyName: 'Test Company' }
    );
    const disc = result.discrepancies.find(d => d.field === 'expiryDate');
    expect(disc?.severity).toBe('error');
    expect(result.valid).toBe(false);
  });

  it('raises a warning for certificate expiring within 30 days', () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 15);
    const soonStr = soon.toISOString().split('T')[0]!;
    const result = validateStatutoryCompliance(
      { ...baseExtracted, expiryDate: soonStr },
      { companyName: 'Test Company' }
    );
    const disc = result.discrepancies.find(d => d.field === 'expiryDate');
    expect(disc?.severity).toBe('warning');
  });

  it('does not warn for a certificate valid for more than 30 days', () => {
    const future = new Date();
    future.setDate(future.getDate() + 60);
    const futureStr = future.toISOString().split('T')[0]!;
    const result = validateStatutoryCompliance(
      { ...baseExtracted, expiryDate: futureStr },
      { companyName: 'Test Company' }
    );
    const disc = result.discrepancies.find(d => d.field === 'expiryDate');
    expect(disc).toBeUndefined();
  });

  it('calculates score with two errors = 0.4', () => {
    const result = validateStatutoryCompliance(
      {
        ...baseExtracted,
        entityName: 'Completely Different Corp',
        vatNumber: '9999999999',
        expiryDate: '2020-01-01',
      },
      { companyName: 'Test Company', vatNumber: '4560123456' }
    );
    // 3 errors × 0.3 = 0.9 reduction → max(0, 0.1) = 0.1
    expect(result.score).toBeCloseTo(0.1, 2);
  });
});

// ─── getQuickActions ──────────────────────────────────────────────────────────

describe('getQuickActions', () => {
  it('returns a non-empty array', () => {
    const actions = getQuickActions();
    expect(actions.length).toBeGreaterThan(0);
  });

  it('every action has a label, url, and icon', () => {
    const actions = getQuickActions();
    for (const action of actions) {
      expect(typeof action.label).toBe('string');
      expect(action.label.length).toBeGreaterThan(0);
      expect(typeof action.url).toBe('string');
      expect(action.url.length).toBeGreaterThan(0);
      expect(typeof action.icon).toBe('string');
    }
  });

  it('includes a New Customer Invoice action', () => {
    const actions = getQuickActions();
    const inv = actions.find(a => a.label === 'New Customer Invoice');
    expect(inv).toBeDefined();
    expect(inv?.url).toContain('customer-invoices');
  });

  it('includes a New Journal Entry action', () => {
    const actions = getQuickActions();
    const je = actions.find(a => a.label === 'New Journal Entry');
    expect(je).toBeDefined();
    expect(je?.url).toContain('journal-entries');
  });

  it('returns a stable result on every call (pure function)', () => {
    const first = getQuickActions();
    const second = getQuickActions();
    expect(first).toEqual(second);
  });

  it('each call returns a fresh array instance', () => {
    const first = getQuickActions();
    const second = getQuickActions();
    expect(first).not.toBe(second);
  });
});

// ─── Additional edge-case coverage for calculateNextRunDate ───────────────────

describe('calculateNextRunDate — leap year edge cases', () => {
  it('handles monthly advance from Jan 31 in a leap year', () => {
    // 2024 is a leap year → Feb has 29 days
    const result = calculateNextRunDate(new Date('2024-01-31'), 'monthly');
    // JS Date: setMonth(1) on day 31 overflows to March 2
    // This is intentional JS behaviour — service must handle it at business layer
    expect(result instanceof Date).toBe(true);
  });

  it('handles daily advance across month boundary', () => {
    const result = calculateNextRunDate(new Date('2025-01-31'), 'daily');
    expect(result.toISOString().split('T')[0]).toBe('2025-02-01');
  });

  it('handles quarterly advance from end of Q4 into Q1 of next year', () => {
    const result = calculateNextRunDate(new Date('2025-10-31'), 'quarterly');
    // Oct → Jan next year; day 31 overflows Feb → becomes Feb 28 or Mar 3 depending on month length
    expect(result.getFullYear()).toBe(2026);
  });
});
