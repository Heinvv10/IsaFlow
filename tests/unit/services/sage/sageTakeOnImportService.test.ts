/**
 * importSagePull's decisions, with the wizard steps stubbed (their own suites
 * cover what they write; tests/integration/sage-connect-takeon covers the
 * whole thing on PostgreSQL):
 *   H1  the migration lock is taken before anything is read, and a company
 *       with a prior take-on is refused before anything is written;
 *   M5  documents go to the contact of EXACTLY their name, contacts are
 *       imported with exact matching;
 *   M6  a review past its TTL is refused;
 *   M7  a refused chart-of-accounts row refuses the import, a COA warning does not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { order, track } = vi.hoisted(() => {
  const order: string[] = [];
  const track = <T extends (...a: never[]) => unknown>(name: string, fn: T) => ((...a: Parameters<T>) => { order.push(name); return fn(...a); }) as T;
  return { order, track };
});
const m = vi.hoisted(() => ({
  lockMigrationImport: vi.fn(), loadPullForImport: vi.fn(), markImported: vi.fn(),
  findPriorTakeOn: vi.fn(), readTakeOnContext: vi.fn(), exactContactIds: vi.fn(),
  importChartOfAccounts: vi.fn(), importCustomers: vi.fn(), importSuppliers: vi.fn(),
  importARInvoices: vi.fn(), importOpeningBalances: vi.fn(), importAPInvoices: vi.fn(),
  createSession: vi.fn(), completeSession: vi.fn(), validateMigration: vi.fn(), ensureOpeningBalanceEquityAccount: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/migrationPostingSupport', () => ({ lockMigrationImport: track('lock', m.lockMigrationImport) }));
vi.mock('@/modules/accounting/services/sage/sageTakeOnStore', () => ({
  loadPullForImport: track('load', m.loadPullForImport), markImported: m.markImported, READY_TTL_HOURS: 24,
}));
vi.mock('@/modules/accounting/services/sage/sageTakeOnContext', () => ({
  findPriorTakeOn: track('prior', m.findPriorTakeOn), readTakeOnContext: track('context', m.readTakeOnContext),
}));
vi.mock('@/modules/accounting/services/sage/sageTakeOnContactIds', () => ({ exactContactIds: m.exactContactIds }));
vi.mock('@/modules/accounting/services/core/migrationCoaService', () => ({ importChartOfAccounts: track('coa', m.importChartOfAccounts) }));
vi.mock('@/modules/accounting/services/core/migrationContactService', () => ({ importCustomers: m.importCustomers, importSuppliers: m.importSuppliers }));
vi.mock('@/modules/accounting/services/core/migrationImportService', () => ({ importARInvoices: m.importARInvoices, importOpeningBalances: m.importOpeningBalances }));
vi.mock('@/modules/accounting/services/ap/migrationApService', () => ({ importAPInvoices: m.importAPInvoices }));
vi.mock('@/modules/accounting/services/core/migrationService', () => ({ createSession: track('session', m.createSession), completeSession: m.completeSession }));
vi.mock('@/modules/accounting/services/core/migrationValidationService', () => ({ validateMigration: m.validateMigration }));
vi.mock('@/modules/accounting/services/gl/openingBalanceEquityService', () => ({ ensureOpeningBalanceEquityAccount: m.ensureOpeningBalanceEquityAccount }));

import { importSagePull, SageImportRefused } from '@/modules/accounting/services/sage/sageTakeOnImportService';
import { emptyCompany, sageFixture } from './sageFixture';

const done = { imported: 1, skipped: 0, errors: [] };
const CO = 'co-1';

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  m.loadPullForImport.mockResolvedValue({ id: 'p', status: 'ready', pull: sageFixture(), expired: false });
  m.findPriorTakeOn.mockResolvedValue(null);
  m.readTakeOnContext.mockResolvedValue(emptyCompany);
  m.createSession.mockResolvedValue({ id: 'sess-1' });
  m.importChartOfAccounts.mockResolvedValue({ imported: 20, skipped: 0, errors: [] });
  m.importCustomers.mockResolvedValue(done);
  m.importSuppliers.mockResolvedValue(done);
  m.importARInvoices.mockResolvedValue(done);
  m.importAPInvoices.mockResolvedValue(done);
  m.importOpeningBalances.mockResolvedValue({ journalEntryId: 'je-1', errors: [] });
  m.ensureOpeningBalanceEquityAccount.mockResolvedValue({ accountCode: '3300' });
  m.validateMigration.mockResolvedValue([]);
  m.exactContactIds.mockResolvedValue({
    customers: new Map([['Bright Billboards', 'cust-bright'], ['Coastal Radio', 'cust-coastal']]),
    suppliers: new Map([['Print House', 'sup-print']]),
    issues: [],
  });
});

const refusal = async () => importSagePull(CO, 'u', 'p').then(() => null, (e: unknown) => e);

describe('H1: one take-on per company', () => {
  it('takes the migration lock before reading the pull, the prior take-ons or the chart', async () => {
    await importSagePull(CO, 'u', 'p');
    expect(order.slice(0, 4)).toEqual(['lock', 'load', 'prior', 'context']);
    expect(m.lockMigrationImport).toHaveBeenCalledWith(CO);
  });

  it('refuses a company that already has a take-on, before any session or write', async () => {
    m.findPriorTakeOn.mockResolvedValue('This company already has its books from Sage.');
    const err = await refusal();
    expect(err).toBeInstanceOf(SageImportRefused);
    expect((err as Error).message).toContain('already has its books');
    expect(m.createSession).not.toHaveBeenCalled();
    expect(m.importChartOfAccounts).not.toHaveBeenCalled();
  });
});

describe('M6: a review past its TTL', () => {
  it('is refused, and says to read Sage again', async () => {
    m.loadPullForImport.mockResolvedValue({ id: 'p', status: 'ready', pull: sageFixture(), expired: true });
    expect(((await refusal()) as Error).message).toMatch(/more than 24 hours old/);
    expect(m.createSession).not.toHaveBeenCalled();
  });

  it.each([['pulling', /still reading/], ['failed', /did not finish/], ['expired', /24 hours/], ['imported', /already been imported/], ['discarded', /discarded/]])(
    'a %s row is refused with its reason', async (status, msg) => {
      m.loadPullForImport.mockResolvedValue({ id: 'p', status, pull: null, expired: false });
      expect(((await refusal()) as Error).message).toMatch(msg);
    });
});

describe('round 4: the size caps are checked again at import', () => {
  it('a ready review stored under older, larger caps is refused before any write', async () => {
    const p = sageFixture();
    p.customers = Array.from({ length: 2001 }, (_, i) => ({ ID: 100 + i, Name: `C${i}`, Active: true, Balance: 0 }));
    m.loadPullForImport.mockResolvedValue({ id: 'p', status: 'ready', pull: p, expired: false });
    const err = await refusal();
    expect(err).toBeInstanceOf(SageImportRefused);
    expect((err as Error).message).toMatch(/Migration Wizard/);
    expect(m.createSession).not.toHaveBeenCalled();
  });
});

describe('M5: exact contacts on the Sage path', () => {
  it('imports contacts with exact matching and hands each document its contact\'s id', async () => {
    await importSagePull(CO, 'u', 'p');
    expect(m.importCustomers).toHaveBeenCalledWith(CO, 'sess-1', expect.any(Array), 'skip', 'exact');
    expect(m.importSuppliers).toHaveBeenCalledWith(CO, 'sess-1', expect.any(Array), 'skip', 'u', 'exact');
    const ar = m.importARInvoices.mock.calls[0]![2] as { customerName: string; customerId: string }[];
    expect(ar.map((r) => [r.customerName, r.customerId])).toEqual([
      ['Bright Billboards', 'cust-bright'], ['Bright Billboards', 'cust-bright'], ['Coastal Radio', 'cust-coastal'],
    ]);
    expect((m.importAPInvoices.mock.calls[0]![2] as { supplierId: string }[])[0]!.supplierId).toBe('sup-print');
  });

  it('a document with no contact of exactly its name refuses the import', async () => {
    m.exactContactIds.mockResolvedValue({ customers: new Map(), suppliers: new Map(), issues: [{ severity: 'error', area: 'receivables', message: 'No customer called exactly "Coastal Radio"' }] });
    const err = await refusal();
    expect(err).toBeInstanceOf(SageImportRefused);
    expect((err as SageImportRefused).issues.map((i) => i.message)).toContain('No customer called exactly "Coastal Radio"');
    expect(m.markImported).not.toHaveBeenCalled();
  });
});

describe('M7 / H3: all or nothing', () => {
  it('a refused chart-of-accounts row refuses the import', async () => {
    m.importChartOfAccounts.mockResolvedValue({ imported: 19, skipped: 1, errors: [{ step: 'coa', row: 4, message: 'Subtype "x" is not valid' }] });
    const err = await refusal();
    expect(err).toBeInstanceOf(SageImportRefused);
    expect((err as SageImportRefused).issues).toContainEqual({ severity: 'error', area: 'accounts', message: 'Subtype "x" is not valid' });
    expect(m.markImported).not.toHaveBeenCalled();
  });

  it('a COA warning (a row that did import) does not', async () => {
    m.importChartOfAccounts.mockResolvedValue({ imported: 20, skipped: 0, errors: [{ step: 'coa', row: 1, severity: 'warning', message: 'kept its type' }] });
    await expect(importSagePull(CO, 'u', 'p')).resolves.toMatchObject({ sessionId: 'sess-1' });
  });

  it('a refused document row refuses the import and marks nothing imported', async () => {
    m.importAPInvoices.mockResolvedValue({ imported: 0, skipped: 1, errors: [{ step: 'ap_invoices', row: 0, message: 'bad bill' }] });
    expect(((await refusal()) as SageImportRefused).issues).toContainEqual(expect.objectContaining({ area: 'payables', message: 'bad bill' }));
    expect(m.markImported).not.toHaveBeenCalled();
  });

  it('a blocking review issue refuses before any write', async () => {
    m.readTakeOnContext.mockResolvedValue({ ...emptyCompany, fiscalYear: null });
    expect(await refusal()).toBeInstanceOf(SageImportRefused);
    expect(m.createSession).not.toHaveBeenCalled();
  });
});
