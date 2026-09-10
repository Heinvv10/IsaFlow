// Isolated business-rule regressions; actual authority and rollback are covered by arSharedWriters.int.test.ts.
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
const control=vi.hoisted(()=>({accountingDate:'2026-07-04'}));
vi.mock('@/modules/accounting/services/ar/creditTargetEligibility',()=>({assertPostedCreditTarget:vi.fn()}));
vi.mock('@/modules/accounting/services/ar/arControlBoundary',()=>({
 requireArControl:vi.fn(()=>({})),
 runArControlled:async(_company:string,_person:string,_ref:unknown,_opts:unknown,effect:(permit:unknown)=>Promise<unknown>)=>effect({accountingDate:control.accountingDate}),
}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/generatedJournalPermit',()=>({registerGeneratedJournal:vi.fn()}));
vi.mock('@/modules/accounting/services/ar/arRelatedEntityEffect',()=>({mutateArRelatedEntity:async(_ctx:unknown,_type:string,_id:string,_parent:unknown,_action:string,mutation:()=>Promise<unknown>)=>mutation()}));
vi.mock('@/modules/accounting/services/controls/arControlAccounts',()=>({resolveArAccounts:async(_ctx:unknown,keys:string[])=>{
 const {getSystemAccount}=await import('@/modules/accounting/services/gl/systemAccountResolver');
 return {ledgerCurrency:'ZAR',chosen:Object.fromEntries(await Promise.all(keys.map(async key=>[key,await getSystemAccount(key as never,'company')]))) };},
}));
vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { ...actual, sql: sqlMock, withTransaction: vi.fn() };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn(),
  reverseJournalEntry: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/creditNoteLock', () => ({
  lockCreditNoteForUpdate: vi.fn(),
}));
import { sql } from '@/lib/neon';
import type {PoolClient} from 'pg';
import {withControlRequest} from '@/modules/accounting/services/controls/context';
import {requireArControl} from '@/modules/accounting/services/ar/arControlBoundary';
import {
  createJournalEntry,
  postJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { lockCreditNoteForUpdate } from '@/modules/accounting/services/ar/creditNoteLock';
import {
  approveCreditNote,
  createCreditNote,
  cancelCreditNote,
} from '@/modules/accounting/services/ar/creditNoteService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockCreateJournalEntry = createJournalEntry as unknown as MockedFunction<typeof createJournalEntry>;
const mockPostJournalEntry = postJournalEntry as unknown as MockedFunction<typeof postJournalEntry>;
const mockGetSystemAccount = getSystemAccount as unknown as MockedFunction<typeof getSystemAccount>;
const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const CN_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const JE_ID = '44444444-4444-4444-4444-444444444444';
function sqlCallTouches(call: unknown[], textFragment: string, value: unknown): boolean {
  const [strings, ...values] = call as [readonly string[], ...unknown[]];
  const text = Array.isArray(strings) ? strings.join('') : '';
  return text.includes(textFragment) && values.includes(value);
}
function setNote(row: Record<string, unknown>, ...rest: Record<string, unknown>[][]) {
  vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(row as never);
  if (rest.length > 0) {
    let chain = mockSql.mockResolvedValueOnce(rest[0]!);
    for (const r of rest.slice(1)) chain = chain.mockResolvedValueOnce(r);
  } else {
    mockSql.mockResolvedValue([row]);
  }
}
function creditNoteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CN_ID,
    credit_note_number: 'CN-2026-00001',
    type: 'customer',
    client_id: 'client-uuid',
    customer_invoice_id: null,
    supplier_id: null,
    supplier_invoice_id: null,
    credit_date: new Date(2026, 6, 4), // local midnight — mirrors pg's DATE parsing
    reason: 'Damaged goods',
    subtotal: 1000,
    tax_rate: 15,
    tax_amount: 150,
    total_amount: 1150,
    status: 'draft',
    gl_journal_entry_id: null,
    project_id: null,
    created_by: USER_ID,
    approved_by: null,
    approved_at: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}
beforeEach(() => {
  vi.mocked(requireArControl).mockImplementation(()=>({}) as ReturnType<typeof requireArControl>);
  control.accountingDate='2026-07-04';
  vi.clearAllMocks();
  vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(creditNoteRow() as never);
  mockGetSystemAccount.mockImplementation(async (key: string) => ({
    id: `${key}-account-id`,
    accountCode: '1000',
    accountName: key,
    accountType: 'asset',
    accountSubtype: 'current',
    createdAt: Date.parse('2026-07-04T00:00:00Z'),
  }));
  const journal = {
    id: JE_ID,
    entryNumber: 'JE-2026-00001',
    entryDate: '2026-07-04',
    source: 'auto_credit_note',
    status: 'draft',
    createdBy: USER_ID,
    createdAt: '2026-07-04T00:00:00Z',
    updatedAt: '2026-07-04T00:00:00Z',
  } as Awaited<ReturnType<typeof createJournalEntry>>;
  mockCreateJournalEntry.mockResolvedValue(journal);
  mockPostJournalEntry.mockResolvedValue(journal);
});
describe('approveCreditNote — approved accounting date',()=>{
 it.each(['2026-07-04','2026-07-05','2026-07-06'])('posts the bound accounting date %s instead of re-reading the source date',async date=>{
  control.accountingDate=date;
  setNote(creditNoteRow(),[creditNoteRow({status:'approved'})]);
  await approveCreditNote(COMPANY_ID,CN_ID,USER_ID);
  expect(mockCreateJournalEntry.mock.calls[0]?.[1].entryDate).toBe(date);
 });
});
describe('approveCreditNote — no sourceDocumentId, linked via gl_journal_entry_id', () => {
  it('does not pass sourceDocumentId to createJournalEntry (would violate fk_gl_je_source_document)', async () => {
    setNote(creditNoteRow(), [creditNoteRow({ status: 'approved', gl_journal_entry_id: JE_ID })]);
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    const [, journalInput] = mockCreateJournalEntry.mock.calls[0]!;
    expect(journalInput.sourceDocumentId).toBeUndefined();
  });
  it('persists gl_journal_entry_id on the credit note when approving', async () => {
    setNote(creditNoteRow(), [creditNoteRow({ status: 'approved', gl_journal_entry_id: JE_ID })]);
    const result = await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(result.glJournalEntryId).toBe(JE_ID);
    const updateCall = mockSql.mock.calls.find((c) =>
      sqlCallTouches(c as unknown[], 'gl_journal_entry_id', JE_ID),
    );
    expect(updateCall, 'no UPDATE wrote gl_journal_entry_id').toBeDefined();
  });
});
describe('createCreditNote — supplier_id is a UUID, never coerced to a number', () => {
  beforeEach(async()=>{
    const real=await vi.importActual<typeof import('@/modules/accounting/services/ar/arControlBoundary')>('@/modules/accounting/services/ar/arControlBoundary');
    vi.mocked(requireArControl).mockImplementation(real.requireArControl);
  });
  function human<T>(effect:()=>Promise<T>){
    return withControlRequest({client:{} as PoolClient,userId:USER_ID,companyId:COMPANY_ID,claims:{sub:USER_ID}},
      {personId:USER_ID,companyId:COMPANY_ID,authMethod:'cookie'},effect);
  }
  const SUPPLIER_ID = '55555555-5555-4555-8555-555555555555';
  it('interpolates the supplier UUID unchanged into the INSERT', async () => {
    mockSql.mockResolvedValue([
      creditNoteRow({ type: 'supplier', client_id: null, supplier_id: SUPPLIER_ID }),
    ]);
    const note = await human(()=>createCreditNote(
      COMPANY_ID,
      { type: 'supplier', supplierId: SUPPLIER_ID, creditDate: '2026-07-04', subtotal: 1000 },
      USER_ID,
    ));
    const insert = mockSql.mock.calls.find((c) =>
      sqlCallTouches(c as unknown[], 'INSERT INTO credit_notes', SUPPLIER_ID),
    );
    expect(insert).toBeDefined();
    const values = (insert as unknown[]).slice(1);
    expect(values.some((v) => typeof v === 'number' && Number.isNaN(v))).toBe(false);
    expect(note.supplierId).toBe(SUPPLIER_ID);
  });
  it('still writes NULL when no supplier is supplied', async () => {
    mockSql.mockResolvedValue([creditNoteRow()]);
    await human(()=>createCreditNote(
      COMPANY_ID,
      { type: 'customer', clientId: 'client-uuid', creditDate: '2026-07-04', subtotal: 1000 },
      USER_ID,
    ));
    const insert = mockSql.mock.calls.find((c) => {
      const [strings] = c as [readonly string[], ...unknown[]];
      return Array.isArray(strings) && strings.join('').includes('INSERT INTO credit_notes');
    });
    expect((insert as unknown[]).slice(1)).toContain(null);
  });
});
describe('postingAgent attribution reaches the GL services', () => {
  it('approveCreditNote forwards the stamp to createJournalEntry', async () => {
    setNote(creditNoteRow());
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID, { postingAgent: 'mcp:approve_credit_note:v1' });
    expect(mockCreateJournalEntry).toHaveBeenCalledWith(
      COMPANY_ID, expect.anything(), USER_ID,
      { postingAgent: 'mcp:approve_credit_note:v1' },
    );
  });
  it('approveCreditNote leaves meta undefined when no stamp is given, keeping human attribution', async () => {
    setNote(creditNoteRow());
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(mockCreateJournalEntry).toHaveBeenCalledWith(
      COMPANY_ID, expect.anything(), USER_ID, undefined,
    );
  });
  it('cancelCreditNote forwards the stamp to reverseJournalEntry', async () => {
    setNote(creditNoteRow({ status: 'approved', gl_journal_entry_id: JE_ID }));
    await cancelCreditNote(COMPANY_ID, CN_ID, USER_ID, 'duplicate', {
      postingAgent: 'mcp:cancel_credit_note:v1',
    });
    expect(vi.mocked(reverseJournalEntry)).toHaveBeenCalledWith(
      COMPANY_ID, JE_ID, USER_ID,
      expect.objectContaining({ postingAgent: 'mcp:cancel_credit_note:v1',reversalDate:'2026-07-04',parentControl:expect.any(Object) }),
    );
  });
});
describe('approve and cancel go through the row lock', () => {
  it('approveCreditNote reads the note via lockCreditNoteForUpdate, not a plain SELECT', async () => {
    setNote(creditNoteRow());
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(lockCreditNoteForUpdate).toHaveBeenCalledWith(COMPANY_ID, CN_ID);
  });
  it('cancelCreditNote reads the note via lockCreditNoteForUpdate', async () => {
    setNote(creditNoteRow({ status: 'approved', gl_journal_entry_id: JE_ID }));
    await cancelCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(lockCreditNoteForUpdate).toHaveBeenCalledWith(COMPANY_ID, CN_ID);
  });
});
describe('approveCreditNote — auto-apply is capped and verified', () => {
  const INV = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
  function linkedNote() {
    return creditNoteRow({ customer_invoice_id: INV, total_amount: 1150 });
  }
  function wire(invoice: { total_amount: string; amount_paid: string } | null) {
    const applied: number[] = [];
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(linkedNote() as never);
    mockSql.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = (strings as unknown as string[]).join('?');
      if (/SELECT total_amount, amount_paid FROM customer_invoices/i.test(text)) {
        return Promise.resolve(invoice ? [invoice] : []);
      }
      if (/UPDATE customer_invoices SET amount_paid = amount_paid \+/i.test(text)) {
        applied.push(Number(values[0]));
        return Promise.resolve([{ id: INV }]);
      }
      if (/UPDATE credit_notes SET status/i.test(text)) {
        return Promise.resolve([linkedNote()]);
      }
      return Promise.resolve([]);
    }) as never);
    return applied;
  }
  it('caps the applied amount at the invoice outstanding balance', async () => {
    const applied = wire({ total_amount: '1150.00', amount_paid: '1000.00' });
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(applied).toEqual([150]);
  });
  it('applies the full total when the invoice owes more than the note', async () => {
    const applied = wire({ total_amount: '5000.00', amount_paid: '0.00' });
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(applied).toEqual([1150]);
  });
  it('applies nothing to an already-settled invoice, leaving the credit unallocated', async () => {
    const applied = wire({ total_amount: '1150.00', amount_paid: '1150.00' });
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(applied).toEqual([]);
  });
  it('refuses when the linked invoice no longer exists rather than reporting a phantom apply', async () => {
    wire(null);
    await expect(approveCreditNote(COMPANY_ID, CN_ID, USER_ID))
      .rejects.toThrow(/no longer exists in this company/);
  });
});
