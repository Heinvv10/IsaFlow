// RED phase — written before implementation
/**
 * Unit tests for migrationService.ts pure functions.
 *
 * Only tests the pure mapSessionRow function — DB-touching functions
 * (createSession, getSession, etc.) require integration tests.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock neon DB so module-level sql call doesn't throw without DATABASE_URL
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import {
  mapSessionRow,
  type MigrationSession,
  type MigrationStatus,
} from '@/modules/accounting/services/migrationService';

// ── mapSessionRow ─────────────────────────────────────────────────────────────

describe('mapSessionRow', () => {
  const baseRow = {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    company_id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    source_system: 'sage_cloud',
    status: 'in_progress' as MigrationStatus,
    steps_completed: { coa: true, customers: false },
    coa_records_imported: 42,
    customers_imported: 15,
    suppliers_imported: 8,
    opening_balances_set: false,
    ar_invoices_imported: 0,
    ap_invoices_imported: 0,
    errors: [],
    started_by: 'user-uuid-1234',
    started_at: new Date('2026-03-01T09:00:00Z'),
    completed_at: null,
    notes: null,
  };

  it('maps all fields from a DB row correctly', () => {
    const session = mapSessionRow(baseRow);
    expect(session.id).toBe(baseRow.id);
    expect(session.companyId).toBe(baseRow.company_id);
    expect(session.sourceSystem).toBe('sage_cloud');
    expect(session.status).toBe('in_progress');
    expect(session.stepsCompleted).toEqual({ coa: true, customers: false });
    expect(session.coaRecordsImported).toBe(42);
    expect(session.customersImported).toBe(15);
    expect(session.suppliersImported).toBe(8);
    expect(session.openingBalancesSet).toBe(false);
    expect(session.arInvoicesImported).toBe(0);
    expect(session.apInvoicesImported).toBe(0);
    expect(session.errors).toEqual([]);
    expect(session.startedBy).toBe('user-uuid-1234');
    expect(session.completedAt).toBeNull();
    expect(session.notes).toBeNull();
  });

  it('converts started_at Date to ISO string', () => {
    const session = mapSessionRow(baseRow);
    expect(session.startedAt).toBe('2026-03-01T09:00:00.000Z');
  });

  it('converts started_at string as-is when not a Date', () => {
    const row = { ...baseRow, started_at: '2026-03-01T09:00:00Z' };
    const session = mapSessionRow(row);
    expect(session.startedAt).toBe('2026-03-01T09:00:00Z');
  });

  it('converts completed_at Date to ISO string', () => {
    const row = { ...baseRow, completed_at: new Date('2026-03-15T17:30:00Z') };
    const session = mapSessionRow(row);
    expect(session.completedAt).toBe('2026-03-15T17:30:00.000Z');
  });

  it('converts completed_at string as-is when not a Date', () => {
    const row = { ...baseRow, completed_at: '2026-03-15T17:30:00Z' };
    const session = mapSessionRow(row);
    expect(session.completedAt).toBe('2026-03-15T17:30:00Z');
  });

  it('returns null for completed_at when missing', () => {
    const session = mapSessionRow({ ...baseRow, completed_at: null });
    expect(session.completedAt).toBeNull();
  });

  it('returns null for source_system when missing', () => {
    const session = mapSessionRow({ ...baseRow, source_system: null });
    expect(session.sourceSystem).toBeNull();
  });

  it('defaults numeric counters to 0 when null/undefined', () => {
    const row = {
      ...baseRow,
      coa_records_imported: null,
      customers_imported: undefined,
      suppliers_imported: null,
      ar_invoices_imported: undefined,
      ap_invoices_imported: null,
    };
    const session = mapSessionRow(row);
    expect(session.coaRecordsImported).toBe(0);
    expect(session.customersImported).toBe(0);
    expect(session.suppliersImported).toBe(0);
    expect(session.arInvoicesImported).toBe(0);
    expect(session.apInvoicesImported).toBe(0);
  });

  it('defaults steps_completed to {} when null', () => {
    const session = mapSessionRow({ ...baseRow, steps_completed: null });
    expect(session.stepsCompleted).toEqual({});
  });

  it('defaults errors to [] when null', () => {
    const session = mapSessionRow({ ...baseRow, errors: null });
    expect(session.errors).toEqual([]);
  });

  it('casts numeric string counters to numbers', () => {
    const row = { ...baseRow, coa_records_imported: '99', customers_imported: '7' };
    const session = mapSessionRow(row);
    expect(session.coaRecordsImported).toBe(99);
    expect(session.customersImported).toBe(7);
  });

  it('casts opening_balances_set string to boolean', () => {
    const session = mapSessionRow({ ...baseRow, opening_balances_set: 1 });
    expect(session.openingBalancesSet).toBe(true);
  });

  it('preserves error objects in errors array', () => {
    const errors = [
      { step: 'coa', row: 5, field: 'accountCode', message: 'Duplicate code' },
      { step: 'customers', message: 'Name required' },
    ];
    const session = mapSessionRow({ ...baseRow, errors });
    expect(session.errors).toHaveLength(2);
    expect(session.errors[0]!.message).toBe('Duplicate code');
    expect(session.errors[1]!.step).toBe('customers');
  });

  it('maps status: completed', () => {
    const session = mapSessionRow({ ...baseRow, status: 'completed' });
    expect(session.status).toBe('completed');
  });

  it('maps status: abandoned', () => {
    const session = mapSessionRow({ ...baseRow, status: 'abandoned' });
    expect(session.status).toBe('abandoned');
  });

  it('preserves notes when present', () => {
    const session = mapSessionRow({ ...baseRow, notes: 'Imported from Sage Cloud backup' });
    expect(session.notes).toBe('Imported from Sage Cloud backup');
  });
});

// ── MigrationError interface ──────────────────────────────────────────────────

describe('MigrationError structure', () => {
  it('mapSessionRow preserves optional row and field fields', () => {
    const errors = [
      { step: 'coa', row: 3, field: 'account_code', message: 'Invalid code' },
      { step: 'customers', message: 'Missing name' },  // no row/field
    ];
    const session = mapSessionRow({ ...{
      id: '1', company_id: '1', source_system: null, status: 'in_progress',
      steps_completed: {}, coa_records_imported: 0, customers_imported: 0,
      suppliers_imported: 0, opening_balances_set: false,
      ar_invoices_imported: 0, ap_invoices_imported: 0,
      errors, started_by: '1', started_at: '2026-01-01', completed_at: null, notes: null,
    }});
    expect(session.errors[0]!.row).toBe(3);
    expect(session.errors[0]!.field).toBe('account_code');
    expect(session.errors[1]!.row).toBeUndefined();
    expect(session.errors[1]!.field).toBeUndefined();
  });
});

// ── Template service (pure functions, no DB) ──────────────────────────────────

describe('migrationTemplateService — getTemplate', () => {
  // No DB dependency — import directly
  it('exists and is importable', async () => {
    const { getTemplate } = await import('@/modules/accounting/services/migrationTemplateService');
    expect(typeof getTemplate).toBe('function');
  });

  it('returns Sage Cloud 3-digit COA template', async () => {
    const { getTemplate } = await import('@/modules/accounting/services/migrationTemplateService');
    const template = getTemplate('sage_cloud', 'chart-of-accounts');
    expect(template).toContain('account_code');
    expect(template).toContain('3-digit');
  });

  it('returns Sage 50 7-digit COA template', async () => {
    const { getTemplate } = await import('@/modules/accounting/services/migrationTemplateService');
    const template = getTemplate('sage_50', 'chart-of-accounts');
    expect(template).toContain('7-digit');
    expect(template).toContain('1000000');
  });

  it('Pastel returns same template as Sage 50', async () => {
    const { getTemplate } = await import('@/modules/accounting/services/migrationTemplateService');
    const sage50 = getTemplate('sage_50', 'chart-of-accounts');
    const pastel  = getTemplate('pastel', 'chart-of-accounts');
    expect(sage50).toBe(pastel);
  });

  it('returns generic template for unknown source system', async () => {
    const { getTemplate } = await import('@/modules/accounting/services/migrationTemplateService');
    const template = getTemplate('other', 'chart-of-accounts');
    expect(template).toContain('account_code');
  });

  it('throws for unknown migration step', async () => {
    const { getTemplate } = await import('@/modules/accounting/services/migrationTemplateService');
    expect(() => getTemplate('sage_cloud', 'invalid-step')).toThrow('Unknown migration step');
  });

  it('returns customers template (same for all source systems)', async () => {
    const { getTemplate } = await import('@/modules/accounting/services/migrationTemplateService');
    const template = getTemplate('sage_cloud', 'customers');
    expect(template).toContain('name');
    expect(template).toContain('email');
    expect(template).toContain('vat_number');
  });

  it('returns opening balances template with debit/credit columns', async () => {
    const { getTemplate } = await import('@/modules/accounting/services/migrationTemplateService');
    const template = getTemplate('sage_cloud', 'opening-balances');
    expect(template).toContain('debit_balance');
    expect(template).toContain('credit_balance');
  });

  it('returns AR invoices template', async () => {
    const { getTemplate } = await import('@/modules/accounting/services/migrationTemplateService');
    const template = getTemplate('sage_cloud', 'ar-invoices');
    expect(template).toContain('invoice_number');
    expect(template).toContain('customer_name');
    expect(template).toContain('total_amount');
  });

  it('returns AP invoices template with supplier_name', async () => {
    const { getTemplate } = await import('@/modules/accounting/services/migrationTemplateService');
    const template = getTemplate('sage_cloud', 'ap-invoices');
    expect(template).toContain('supplier_name');
  });
});

describe('migrationTemplateService — getTemplateFilename', () => {
  it('returns a filename with the source system and step', async () => {
    const { getTemplateFilename } = await import('@/modules/accounting/services/migrationTemplateService');
    const filename = getTemplateFilename('sage_cloud', 'chart-of-accounts');
    expect(filename).toContain('sage');
    expect(filename).toContain('chart-of-accounts');
    expect(filename.endsWith('.csv')).toBe(true);
  });
});
