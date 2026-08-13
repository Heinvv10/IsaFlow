/**
 * Expense claims must post a balanced journal through the validated posting
 * service, and must refuse to post one they cannot balance.
 *
 * The old postClaimToGl hand-rolled the journal:
 *
 *   1. INSERT the header already at status='posted' — trg_gl_je_balanced only
 *      fires on UPDATE, so the entry was never balance-checked at all.
 *   2. INSERT each expense line's net amount as a debit.
 *   3. INSERT the VAT debit **only if opts.vatInputAccountId was supplied**.
 *   4. INSERT the reimbursement credit for the GROSS total.
 *
 * Step 3 is the hole: a claim with VAT posted by a caller that passed no
 * vatInputAccountId produced debits of (gross − VAT) against a credit of gross.
 * The entry was short by exactly the VAT and nothing rejected it. There was no
 * transaction either, so a failure at step 4 left a posted, credit-less header.
 *
 * Dates matter here too: claimDate becomes the journal's entryDate, and the
 * mapper's toISODate ran Date.toISOString() on a pg DATE, shifting it a day
 * earlier on this UTC+2 server — enough to file a journal in the wrong period.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(),
    unsafe: vi.fn((s: string) => s),
  });
  return {
    sql: sqlMock,
    withTransaction: vi.fn(),
    withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()),
    // The real implementation — this test pins the date behaviour, so stubbing
    // it would defeat the point.
    fmtDate: (val: unknown): string => {
      if (!val) return '';
      if (val instanceof Date) {
        const y = val.getFullYear();
        const m = String(val.getMonth() + 1).padStart(2, '0');
        const d = String(val.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
      }
      const s = String(val);
      return s.includes('T') ? s.split('T')[0]! : s;
    },
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn().mockResolvedValue({ id: 'je-claim-1' }),
  postJournalEntry: vi.fn().mockResolvedValue({ id: 'je-claim-1', status: 'posted' }),
}));

import { sql } from '@/lib/neon';
import {
  createJournalEntry,
  postJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';
import { postClaimToGl } from '@/modules/accounting/services/expense/expenseClaimService';

const COMPANY = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const CLAIM = '33333333-3333-3333-3333-333333333333';
const REIMBURSEMENT = 'acct-reimbursement';
const VAT_INPUT = 'acct-vat-input';

const sqlMock = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown[]>>;
const createMock = createJournalEntry as unknown as MockedFunction<
  (...a: unknown[]) => Promise<{ id: string }>
>;
const postMock = postJournalEntry as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown>>;

type Line = { glAccountId: string; debit: number; credit: number };
const sum = (ls: Line[], k: 'debit' | 'credit') => ls.reduce((t, l) => t + l[k], 0);

function createInput(): { lines: Line[]; source: string; reference?: string; entryDate: string } {
  return createMock.mock.calls[0]![1] as never;
}

interface ClaimLineRow {
  id: string;
  amount: number;
  vat_amount: number;
  gl_account_id: string | null;
}

/**
 * Stub the claim reads. getClaim issues a header SELECT then a lines SELECT;
 * both are matched on their table name so ordering changes don't break this.
 */
function withClaim(opts: { claimDate: unknown; status?: string; lines: ClaimLineRow[] }) {
  sqlMock.mockImplementation(((strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings);
    if (text.includes('FROM expense_claim_lines')) {
      return Promise.resolve(
        opts.lines.map(l => ({
          id: l.id,
          claim_id: CLAIM,
          line_date: opts.claimDate,
          description: `line ${l.id}`,
          merchant: null,
          amount: l.amount,
          vat_amount: l.vat_amount,
          vat_code: null,
          gl_account_id: l.gl_account_id,
          cost_centre_id: null,
          project_id: null,
          source_document_id: null,
          km_travelled: null,
          km_rate: null,
          mileage_from: null,
          mileage_to: null,
        })),
      );
    }
    if (text.includes('FROM expense_claims')) {
      return Promise.resolve([
        {
          id: CLAIM,
          company_id: COMPANY,
          employee_id: 'emp-1',
          claim_number: 'EXP-0001',
          claim_date: opts.claimDate,
          title: 'August travel',
          description: null,
          status: opts.status ?? 'approved',
          total_amount: opts.lines.reduce((t, l) => t + l.amount, 0),
          total_vat: opts.lines.reduce((t, l) => t + l.vat_amount, 0),
          approved_by: USER,
          approved_at: null,
          rejection_reason: null,
          posted_je_id: null,
          posted_at: null,
          submitted_at: null,
          created_by: USER,
          created_at: '2026-08-01',
          updated_at: '2026-08-01',
        },
      ]);
    }
    return Promise.resolve([]);
  }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  createMock.mockResolvedValue({ id: 'je-claim-1' });
  postMock.mockResolvedValue({ id: 'je-claim-1', status: 'posted' });
});

describe('postClaimToGl', () => {
  const vatLines: ClaimLineRow[] = [
    { id: 'l1', amount: 1150, vat_amount: 150, gl_account_id: 'acct-travel' },
    { id: 'l2', amount: 575, vat_amount: 75, gl_account_id: 'acct-meals' },
  ];

  it('posts DR expense + DR VAT + CR reimbursement, balanced, via the posting service', async () => {
    withClaim({ claimDate: '2026-08-13', lines: vatLines });

    await postClaimToGl(CLAIM, COMPANY, {
      userId: USER,
      reimbursementAccountId: REIMBURSEMENT,
      vatInputAccountId: VAT_INPUT,
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith(COMPANY, 'je-claim-1', USER);

    const { lines } = createInput();
    expect(sum(lines, 'debit')).toBe(1725);   // 1000 + 500 net + 225 VAT
    expect(sum(lines, 'credit')).toBe(1725);  // gross reimbursement

    expect(lines.find(l => l.glAccountId === 'acct-travel')).toMatchObject({ debit: 1000, credit: 0 });
    expect(lines.find(l => l.glAccountId === 'acct-meals')).toMatchObject({ debit: 500, credit: 0 });
    expect(lines.find(l => l.glAccountId === VAT_INPUT)).toMatchObject({ debit: 225, credit: 0 });
    expect(lines.find(l => l.glAccountId === REIMBURSEMENT)).toMatchObject({ debit: 0, credit: 1725 });
  });

  it('REFUSES to post a VAT-bearing claim with no VAT input account', async () => {
    withClaim({ claimDate: '2026-08-13', lines: vatLines });

    // Previously: silently dropped the R225 VAT debit and posted a journal
    // short by exactly that amount.
    await expect(
      postClaimToGl(CLAIM, COMPANY, { userId: USER, reimbursementAccountId: REIMBURSEMENT }),
    ).rejects.toThrow(/VAT input account/i);

    expect(createMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
  });

  // A claim can total to NEGATIVE VAT when it carries credit-note lines. The
  // guard was `totalVat > 0`, which let that case past the check and into the
  // `totalVat !== 0` leg, where the non-null assertion on vatInputAccountId
  // handed createJournalEntry an undefined glAccountId — still failing closed,
  // but on a generic validation error rather than this actionable one.
  const creditNoteLines: ClaimLineRow[] = [
    { id: 'l1', amount: -1150, vat_amount: -150, gl_account_id: 'acct-travel' },
  ];

  it('REFUSES a negative-VAT claim with no VAT input account', async () => {
    withClaim({ claimDate: '2026-08-13', lines: creditNoteLines });

    await expect(
      postClaimToGl(CLAIM, COMPANY, { userId: USER, reimbursementAccountId: REIMBURSEMENT }),
    ).rejects.toThrow(/VAT input account/i);

    expect(createMock).not.toHaveBeenCalled();
  });

  it('posts a negative-VAT claim with the legs flipped to the correct sides', async () => {
    withClaim({ claimDate: '2026-08-13', lines: creditNoteLines });

    await postClaimToGl(CLAIM, COMPANY, {
      userId: USER,
      reimbursementAccountId: REIMBURSEMENT,
      vatInputAccountId: VAT_INPUT,
    });

    const { lines } = createInput();
    // Mirror image of the normal claim: expense and VAT credited, the
    // reimbursement liability debited.
    expect(lines.find(l => l.glAccountId === 'acct-travel')).toMatchObject({ debit: 0, credit: 1000 });
    expect(lines.find(l => l.glAccountId === VAT_INPUT)).toMatchObject({ debit: 0, credit: 150 });
    expect(lines.find(l => l.glAccountId === REIMBURSEMENT)).toMatchObject({ debit: 1150, credit: 0 });
    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
    // No negative amounts — validateJournalLine rejects them outright.
    expect(lines.every(l => l.debit >= 0 && l.credit >= 0)).toBe(true);
  });

  it('posts a zero-VAT claim without needing a VAT account', async () => {
    withClaim({
      claimDate: '2026-08-13',
      lines: [{ id: 'l1', amount: 800, vat_amount: 0, gl_account_id: 'acct-travel' }],
    });

    await postClaimToGl(CLAIM, COMPANY, { userId: USER, reimbursementAccountId: REIMBURSEMENT });

    const { lines } = createInput();
    expect(sum(lines, 'debit')).toBe(800);
    expect(sum(lines, 'credit')).toBe(800);
    // No zero-value VAT leg: validateJournalLine rejects debit === credit === 0.
    expect(lines.every(l => l.debit > 0 || l.credit > 0)).toBe(true);
  });

  it('uses the claim date as the entry date without rolling it back a day', async () => {
    // pg hands back a Date at local midnight for a DATE column. toISOString()
    // on this UTC+2 host yields the PREVIOUS day, which can file the journal in
    // the wrong fiscal period.
    withClaim({ claimDate: new Date(2026, 7, 1, 0, 0, 0), lines: vatLines });

    await postClaimToGl(CLAIM, COMPANY, {
      userId: USER,
      reimbursementAccountId: REIMBURSEMENT,
      vatInputAccountId: VAT_INPUT,
    });

    // 1 August, not 31 July — the month boundary is where this actually bites.
    expect(createInput().entryDate).toBe('2026-08-01');
  });

  it('uses the auto_expense_claim source and carries the claim number as reference', async () => {
    withClaim({ claimDate: '2026-08-13', lines: vatLines });

    await postClaimToGl(CLAIM, COMPANY, {
      userId: USER,
      reimbursementAccountId: REIMBURSEMENT,
      vatInputAccountId: VAT_INPUT,
    });

    expect(createInput().source).toBe('auto_expense_claim');
    expect(createInput().reference).toBe('EXP-0001');
  });

  it('refuses a line with no GL account before writing anything', async () => {
    withClaim({
      claimDate: '2026-08-13',
      lines: [{ id: 'l1', amount: 1150, vat_amount: 150, gl_account_id: null }],
    });

    await expect(
      postClaimToGl(CLAIM, COMPANY, {
        userId: USER,
        reimbursementAccountId: REIMBURSEMENT,
        vatInputAccountId: VAT_INPUT,
      }),
    ).rejects.toThrow(/gl_account_id/);

    // The old code inserted the posted header first, then threw on the bad line,
    // leaving a posted entry with no lines behind.
    expect(createMock).not.toHaveBeenCalled();
  });

  it('does not mark the claim posted when the journal fails to post', async () => {
    withClaim({ claimDate: '2026-08-13', lines: vatLines });
    postMock.mockRejectedValue(new Error('Cannot post to closed fiscal period'));

    await expect(
      postClaimToGl(CLAIM, COMPANY, {
        userId: USER,
        reimbursementAccountId: REIMBURSEMENT,
        vatInputAccountId: VAT_INPUT,
      }),
    ).rejects.toThrow(/closed fiscal period/);

    const updatedClaim = sqlMock.mock.calls.some(c => {
      const text = Array.isArray(c[0]) ? (c[0] as string[]).join('') : String(c[0]);
      return text.includes('UPDATE expense_claims') && text.includes('posted');
    });
    expect(updatedClaim).toBe(false);
  });

  it('rejects a claim that is not approved', async () => {
    withClaim({ claimDate: '2026-08-13', status: 'draft', lines: vatLines });

    await expect(
      postClaimToGl(CLAIM, COMPANY, {
        userId: USER,
        reimbursementAccountId: REIMBURSEMENT,
        vatInputAccountId: VAT_INPUT,
      }),
    ).rejects.toThrow(/status 'draft'/);
    expect(createMock).not.toHaveBeenCalled();
  });
});
