/**
 * The budget check at bill approval (budgets P5-2; spec §3b/§3c, census findings 1-6). The
 * document-agnostic check is `budgets/budgetCheck.ts`; this keys it on a bill.
 *
 * - Keyed on the lines approve POSTS (census finding 3): `placeCostCentres(buildExpenseLines(…))`,
 *   so gross scaling, the default-expense fallback for a line with no account and the legacy
 *   cost-centre pick are all as posted. The workflow passes the lines it is about to post; the
 *   preview builds them the same way.
 * - Month: the bill's `invoice_date` (the journal's entry date; decision 8b).
 * - `excludeInvoiceId` = the bill: its own PO-linked lines count as billed against their commitment
 *   (decision 8a), so the part of a PO line it consumes is not counted twice.
 * - Call sites: `approveInner` and `postToGLInner`, after the lines are built and before
 *   `createJournalEntry` (their first write). NOT the reused-journal approve branch: that bill's
 *   journal is already posted, so its spend is already in actuals; refusing it would leave a posted
 *   journal under a draft bill (census finding 2). Nor Post to GL's `alreadyPosted` return.
 */
import type { SupplierInvoice } from '../../types/ap.types';
import type { JournalLineInput } from '../../types/gl.types';
import { getSystemAccount } from '../gl/systemAccountResolver';
import { placeCostCentres } from '../gl/dimensions/costCentrePick';
import { fmtDate } from '@/lib/fmtDate';
import { buildExpenseLines } from './supplierInvoiceExpenseLines';
import { getSupplierInvoiceById } from './supplierInvoiceService';
import { lockSupplierInvoiceForUpdate } from './supplierInvoiceLock';
import {
  checkDocumentBudget, evaluateDocumentLines, gateFor, readCheckPolicy,
} from '../budgets/budgetCheck';
import type { DocumentLine } from '../budgets/budgetCheckCore';
import { log } from '@/lib/logger';
import type { ProvisionalClaim } from './provisionalSettlementClaim';
import { peekProvisionalReclassLines, provisionalReclassLines } from './supplierInvoiceBudgetProvisional';
import type {
  BudgetCheckContext, BudgetCheckLine, BudgetCheckResult, BudgetGate, BudgetPolicy,
} from '../budgets/budgetCheckTypes';

/** `opts.budget` of approve / Post to GL: the caller's channel and lock mode. */
export type BillBudgetOpts = { budget?: BudgetCheckContext };
/** What approve / Post to GL add to their result: the over-budget lines a warn-mode approval went ahead with. */
export type BudgetWarned = { budgetWarnings?: string[] };
export const budgetWarningsOf = (r: BudgetCheckResult): BudgetWarned => (r.warnings.length > 0 ? { budgetWarnings: r.warnings } : {});

/**
 * A caller that names no context: a system approval that holds no lock, so it takes the company
 * lock itself when the policy is `block`. Every production caller passes its own.
 */
export const DEFAULT_BILL_BUDGET_CONTEXT: BudgetCheckContext = { channel: 'system', lock: 'take' };

/** Opens (or adopts) the budget gate. Call it before `lockSupplierInvoiceForUpdate`. */
export function openBillBudgetGate(companyId: string, ctx: BudgetCheckContext | undefined): Promise<BudgetGate> {
  return gateFor(companyId, ctx ?? DEFAULT_BILL_BUDGET_CONTEXT);
}

/**
 * Approve's and Post to GL's first two locks, in the §3c order: the budget gate (the company lock
 * when the policy is block and the caller locks), THEN the bill row. Null when the bill is not
 * this company's (the row lock found nothing).
 */
export async function lockBillAfterBudgetGate(companyId: string, id: string, ctx: BudgetCheckContext | undefined): Promise<BudgetGate | null> {
  const gate = await openBillBudgetGate(companyId, ctx);
  return (await lockSupplierInvoiceForUpdate(companyId, id)) ? gate : null;
}

export const billMonth = (invoice: Pick<SupplierInvoice, 'invoiceDate'>): string => fmtDate(invoice.invoiceDate).slice(0, 7);

function documentLines(expense: readonly JournalLineInput[]): DocumentLine[] {
  return expense.map((l) => ({
    glAccountId: l.glAccountId, cc1Id: l.cc1Id ?? null, cc2Id: l.cc2Id ?? null, buId: l.buId ?? null,
    amount: Math.round(((l.debit || 0) - (l.credit || 0)) * 100) / 100,
  }));
}

/**
 * The check, on the expense lines the caller is about to post (before the VAT and AP legs) and, when the bill
 * settles a bank-first provisional it claimed, that provisional's reclass (negative, its own month; review B1).
 */
export function checkBillBudget(
  companyId: string, invoice: SupplierInvoice, expense: readonly JournalLineInput[],
  gate: BudgetGate, ctx: BudgetCheckContext | undefined, actorId: string, provisional?: ProvisionalClaim | null,
): Promise<BudgetCheckResult> {
  return checkDocumentBudget(companyId, {
    type: 'supplier_invoice', id: invoice.id, ref: invoice.invoiceNumber, month: billMonth(invoice),
    lines: [...documentLines(expense), ...provisionalReclassLines(provisional)], excludeInvoiceId: invoice.id,
  }, ctx ?? DEFAULT_BILL_BUDGET_CONTEXT, gate, actorId);
}

/** Post to GL's expense lines (the legacy pick placed, as approve) and the check on them, before its first write. */
export async function placeCheckedBillLines(
  companyId: string, invoice: SupplierInvoice, defaultExpenseId: string, gate: BudgetGate, ctx: BudgetCheckContext | undefined, actorId: string,
  provisional: ProvisionalClaim | null,
) {
  const placed = await placeCostCentres(companyId, buildExpenseLines(invoice, defaultExpenseId), { storedPosting: true });
  return { ...placed, budget: await checkBillBudget(companyId, invoice, placed.lines, gate, ctx, actorId, provisional) };
}

export interface BillBudgetPreview {
  policy: BudgetPolicy;
  /** False when approving would post nothing new (a bill already carrying a journal), so nothing is checked. */
  checks: boolean;
  lines: BudgetCheckLine[];
  overCount: number;
}

/**
 * What the approve dialog shows: the same lines and remaining approve would check (the bill's lines and the
 * reclass of a bank-first provisional behind its slip), read without any lock (a preview; the approval decides
 * again under its locks). Null when the bill is not this company's. `policy`: read once by a caller previewing
 * many bills. `alsoBilledInvoiceIds`: earlier bills of a batch, counted as billed against their PO lines.
 */
export async function previewBillBudget(
  companyId: string, invoiceId: string, opts: { policy?: BudgetPolicy; alsoBilledInvoiceIds?: readonly string[] } = {},
): Promise<BillBudgetPreview | null> {
  const invoice = await getSupplierInvoiceById(companyId, invoiceId);
  if (!invoice) return null;
  const policy = opts.policy ?? await readCheckPolicy(companyId);
  if (policy === 'off' || invoice.glJournalEntryId || invoice.status === 'cancelled') {
    return { policy, checks: false, lines: [], overCount: 0 };
  }
  const defaultExpense = await getSystemAccount('default_expense', companyId);
  const { lines } = await placeCostCentres(companyId, buildExpenseLines(invoice, defaultExpense.id), { storedPosting: true });
  const month = billMonth(invoice);
  const docLines = [...documentLines(lines), ...await peekProvisionalReclassLines(companyId, invoice.id, month)];
  const checked = await evaluateDocumentLines(companyId, docLines, month, {
    excludeInvoiceId: invoice.id, alsoBilledInvoiceIds: opts.alsoBilledInvoiceIds, labelAlways: true,
  });
  return { policy, checks: true, lines: checked, overCount: checked.filter((l) => l.over).length };
}

const BUDGET_REFUSALS = new Set(['BUDGET_EXCEEDED', 'BUDGET_REASON_REQUIRED', 'BUDGET_CHECK_LOCK_TIMEOUT']);

/**
 * approve's catch: a budget refusal is an answer, not a fault — logged at info with its code only (its lines carry
 * the company's budget figures; security review S3). Everything else stays an error. The caller always re-throws.
 */
export function logApproveFailure(id: string, err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && BUDGET_REFUSALS.has(code)) log.info('Supplier invoice approval refused by the budget check', { id, code }, 'accounting');
  else log.error('Failed to approve supplier invoice', { id, error: err }, 'accounting');
}
