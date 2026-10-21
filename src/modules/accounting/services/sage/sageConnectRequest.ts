/**
 * Shared plumbing for the /api/accounting/sage-connect routes: building a Sage
 * client from the request's login (never stored), turning Sage errors into
 * plain-language responses, and shaping a take-on for the review screen.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { createSageApiClient, SageApiError, type SageApiClient } from './sageApiClient';
import type { SageCompanySummary } from './sageApiTypes';
import type { PullState, PullStatus } from './sageTakeOnStore';
import { formatRand, type SageTakeOn } from './sageTakeOnTypes';

/** IsaFlow's Sage vendor key, from the server environment. */
export function sageApiKey(): string {
  return (process.env.SAGE_API_KEY ?? '').trim();
}

export function sageConnectAvailable(): boolean {
  return sageApiKey().length > 0;
}

/**
 * What /status answers: whether the connection is on, the company's review in
 * progress or waiting (the page resumes it), and why the company cannot take
 * another Sage take-on, if it cannot.
 */
export const statusPayload = (
  open: { pullId: string; status: PullStatus } | null, priorTakeOn: string | null,
) => ({ available: sageConnectAvailable(), open, priorTakeOn });

/** What the review request answers: the read runs in the background; poll /pulls/{pullId}. */
export const startedPayload = (pullId: string) => ({ pullId, status: 'pulling' as PullStatus });

/** What /discard answers. */
export const discardPayload = () => ({ discarded: true as const });

/** Today in South Africa, as YYYY-MM-DD — the cut-over date of a Sage take-on. */
export function todayInSouthAfrica(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(now);
}

export type LoginResult = { ok: true; client: SageApiClient } | { ok: false; field: 'email' | 'password'; message: string };

export function clientFromLogin(body: unknown): LoginResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  if (!email) return { ok: false, field: 'email', message: 'Enter the email address you sign in to Sage with' };
  if (!password) return { ok: false, field: 'password', message: 'Enter your Sage password' };
  return { ok: true, client: createSageApiClient({ apiKey: sageApiKey(), username: email, password }) };
}

/** Answers a Sage failure in words a client can act on; returns false if `err` is not one. */
export function answerSageError(res: NextApiResponse, err: unknown): boolean {
  if (!(err instanceof SageApiError)) return false;
  apiResponse.badRequest(res, err.message, { sageError: err.kind });
  return true;
}

/** M3 / round 4: where this year's income and expenses to date land. */
function profitAndLossNote(t: SageTakeOn): string {
  // Hein, 2026-10-21: dividends in the take-on journal are a balance carried in, in both SOCE readers.
  const dividends = ` Dividends paid before ${t.asAtDate} come across as a balance taken on, not as this year's dividends, so this year's annual financial statements need them from Sage.`;
  const fold = t.profitAndLossFold;
  if (fold) {
    const what = fold.profit >= 0 ? 'profit' : 'loss';
    return `Sage's financial year started on ${t.financialYearStart}, but IsaFlow's fiscal year holding ${t.asAtDate} runs from ${fold.isaflowYearStart} to ${fold.isaflowYearEnd}. So this year's ${what} to date of ${formatRand(Math.abs(fold.profit))} (Sage, ${t.financialYearStart} to ${t.asAtDate}) goes into equity, on Retained Earnings, with the opening balances; income and expense accounts start at nil. IsaFlow will not show this year's income and expenses before ${t.asAtDate}, so IsaFlow alone cannot produce this year's annual financial statements or the ITR14 income statement: the part of the year before ${t.asAtDate} is in Sage. Keep Sage's reports for this year.${dividends}`;
  }
  const month = new Intl.DateTimeFormat('en-ZA', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${t.asAtDate}T00:00:00Z`));
  return `Sage's trial balance runs from the start of its financial year (${t.financialYearStart}) to ${t.asAtDate}, so this year's income and expenses to date come across inside the opening-balance journal dated ${t.asAtDate}. IsaFlow's reports will show all of them in ${month}, the cut-over month, not month by month; the year's totals are right.${dividends}`;
}

/** What the review screen shows. Contact details stay server-side; names and amounts are enough to check. */
export function toReview(t: SageTakeOn) {
  const nameOf = new Map(t.accounts.map((a) => [a.accountCode, a.accountName]));
  const outstanding = (total: number, paid: number) => Math.round((total - paid) * 100) / 100;
  return {
    sageCompany: t.sageCompany,
    asAtDate: t.asAtDate,
    financialYearStart: t.financialYearStart,
    profitAndLossNote: profitAndLossNote(t),
    issues: t.issues,
    totals: t.totals,
    accounts: t.accounts.map((a) => ({ code: a.accountCode, name: a.accountName, type: a.accountType })),
    roles: t.systemAccountMap,
    openingBalances: t.openingBalances.map((b) => ({ ...b, name: nameOf.get(b.accountCode) ?? b.accountCode })),
    openingBalanceClearing: t.openingBalanceClearing,
    customers: t.customers.map((c) => c.name),
    suppliers: t.suppliers.map((s) => s.name),
    arInvoices: t.arInvoices.map((i) => ({ contact: i.customerName, number: i.invoiceNumber, date: i.invoiceDate, outstanding: outstanding(i.totalAmount, i.amountPaid ?? 0) })),
    apInvoices: t.apInvoices.map((i) => ({ contact: i.supplierName, number: i.invoiceNumber, date: i.invoiceDate, outstanding: outstanding(i.totalAmount, i.amountPaid ?? 0) })),
  };
}

export type SageReview = ReturnType<typeof toReview>;

/** The companies a Sage login can open, active ones only, by name. */
export function toCompanyOptions(companies: SageCompanySummary[]) {
  return {
    companies: companies
      .filter((c) => c.Active !== false)
      .map((c) => ({ id: c.ID, name: c.Name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** What /pulls/{pullId} answers: the row's state, and the review once it is ready. */
export function pullPayload(state: PullState, review: SageReview | null) {
  return { pullId: state.id, status: state.status, progress: state.progress, error: state.error, review };
}
