import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export type LoanVatType = 'standard' | 'zero' | 'exempt';

export interface Loan {
  id: string;
  companyId: string;
  curveId: string | null;
  counterpartyId: string | null;
  glAccountId: string | null;
  reference: string | null;
  product: string | null;
  description: string | null;
  principal: number;
  startDate: string;
  termMonths: number;
  rateMode: 'FIXED' | 'PRIME_PLUS' | 'PRIME_MINUS';
  margin: number;
  fixedRate: number | null;
  residual: number;
  dayCount: 'ACTUAL_365' | 'ACTUAL_360' | '30_360';
  repriceMode: 'RESOLVE_ON_RATE_CHANGE' | 'RESOLVE_EVERY_PERIOD' | 'FIXED_INSTALLMENT';
  skipMode: 'EXTEND_TERM' | 'MAINTAIN_TERM';
  lumpMode: 'REDUCE_INSTALLMENT' | 'MAINTAIN_INSTALLMENT';
  recurringSkipMonths: number[];
  status: 'active' | 'closed' | 'written_off';
  ncaCompliant: boolean;
  currency: string;
  /** Upfront origination fee (ZAR, excl VAT). Default 0. */
  originationFee: number;
  /** VAT treatment of the origination fee. Interest itself is always exempt. */
  originationFeeVatType: LoanVatType;
  createdAt: string;
  updatedAt: string;
}

export interface LoanCreateInput {
  curveId?: string;
  counterpartyId?: string;
  glAccountId?: string;
  reference?: string;
  product?: string;
  description?: string;
  principal: number;
  startDate: string;
  termMonths: number;
  rateMode: 'FIXED' | 'PRIME_PLUS' | 'PRIME_MINUS';
  margin?: number;
  fixedRate?: number;
  residual?: number;
  dayCount?: 'ACTUAL_365' | 'ACTUAL_360' | '30_360';
  repriceMode?: 'RESOLVE_ON_RATE_CHANGE' | 'RESOLVE_EVERY_PERIOD' | 'FIXED_INSTALLMENT';
  skipMode?: 'EXTEND_TERM' | 'MAINTAIN_TERM';
  lumpMode?: 'REDUCE_INSTALLMENT' | 'MAINTAIN_INSTALLMENT';
  recurringSkipMonths?: number[];
  currency?: string;
  originationFee?: number;
  originationFeeVatType?: LoanVatType;
}

export interface LoanUpdateInput {
  status?: 'active' | 'closed' | 'written_off';
  glAccountId?: string;
  reference?: string;
  description?: string;
  // Financial terms — editable when no GL postings exist on the loan.
  principal?: number;
  startDate?: string;
  termMonths?: number;
  rateMode?: 'FIXED' | 'PRIME_PLUS' | 'PRIME_MINUS';
  margin?: number;
  fixedRate?: number;
  residual?: number;
  dayCount?: 'ACTUAL_365' | 'ACTUAL_360' | '30_360';
  repriceMode?: 'RESOLVE_ON_RATE_CHANGE' | 'RESOLVE_EVERY_PERIOD' | 'FIXED_INSTALLMENT';
  skipMode?: 'EXTEND_TERM' | 'MAINTAIN_TERM';
  lumpMode?: 'REDUCE_INSTALLMENT' | 'MAINTAIN_INSTALLMENT';
  currency?: string;
  originationFee?: number;
  product?: string;
  counterpartyId?: string;
}

export interface LoanEvent {
  id: string;
  loanId: string;
  companyId: string;
  date: string;
  kind: 'LUMP' | 'SKIP' | 'RESTRUCTURE' | 'WRITEOFF';
  amount: number | null;
  note: string | null;
  postedBy: string | null;
  postedAt: string;
}

export interface LoanEventInput {
  kind: 'LUMP' | 'SKIP' | 'RESTRUCTURE' | 'WRITEOFF';
  date: string;
  amount?: number;
  note?: string;
}

export interface ListLoansFilter {
  status?: 'active' | 'closed' | 'written_off';
  product?: string;
}

function mapLoanRow(row: Row): Loan {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    curveId: row.curve_id != null ? String(row.curve_id) : null,
    counterpartyId: row.counterparty_id != null ? String(row.counterparty_id) : null,
    glAccountId: row.gl_account_id != null ? String(row.gl_account_id) : null,
    reference: row.reference != null ? String(row.reference) : null,
    product: row.product != null ? String(row.product) : null,
    description: row.description != null ? String(row.description) : null,
    principal: parseFloat(String(row.principal)),
    startDate: fmtDate(row.start_date),
    termMonths: Number(row.term_months),
    rateMode: String(row.rate_mode) as Loan['rateMode'],
    margin: parseFloat(String(row.margin ?? '0')),
    fixedRate: row.fixed_rate != null ? parseFloat(String(row.fixed_rate)) : null,
    residual: parseFloat(String(row.residual ?? '0')),
    dayCount: String(row.day_count) as Loan['dayCount'],
    repriceMode: String(row.reprice_mode) as Loan['repriceMode'],
    skipMode: String(row.skip_mode) as Loan['skipMode'],
    lumpMode: String(row.lump_mode) as Loan['lumpMode'],
    recurringSkipMonths: Array.isArray(row.recurring_skip_months)
      ? (row.recurring_skip_months as number[])
      : [],
    status: String(row.status) as Loan['status'],
    ncaCompliant: Boolean(row.nca_compliant),
    currency: String(row.currency ?? 'ZAR'),
    originationFee: row.origination_fee != null ? parseFloat(String(row.origination_fee)) : 0,
    originationFeeVatType: (row.origination_fee_vat_type != null
      ? String(row.origination_fee_vat_type)
      : 'standard') as LoanVatType,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapEventRow(row: Row): LoanEvent {
  return {
    id: String(row.id),
    loanId: String(row.loan_id),
    companyId: String(row.company_id),
    date: fmtDate(row.event_date),
    kind: String(row.kind) as LoanEvent['kind'],
    amount: row.amount != null ? parseFloat(String(row.amount)) : null,
    note: row.note != null ? String(row.note) : null,
    postedBy: row.posted_by != null ? String(row.posted_by) : null,
    postedAt: String(row.posted_at),
  };
}

function validateCreate(input: LoanCreateInput): void {
  if (!input.principal || input.principal <= 0) throw new Error('principal must be positive');
  if (!input.termMonths || input.termMonths <= 0) throw new Error('termMonths must be positive');
  if (input.rateMode === 'FIXED' && (input.fixedRate == null || input.fixedRate <= 0)) {
    throw new Error('fixedRate is required for FIXED rate mode');
  }
  if (input.originationFee != null && input.originationFee < 0) {
    throw new Error('originationFee must not be negative');
  }
  assertSkipScheduleRepayable(input.skipMode, input.recurringSkipMonths);
}

/**
 * Every calendar month skipped with EXTEND_TERM is a loan that never repays:
 * each skipped period pushes the term out by one, so the schedule runs to the
 * year 10000 before the engine's cap stops it.
 */
function assertSkipScheduleRepayable(
  skipMode: string | null | undefined,
  recurringSkipMonths: number[] | null | undefined,
): void {
  const months = new Set((recurringSkipMonths ?? []).filter((m) => m >= 1 && m <= 12));
  if (skipMode === 'EXTEND_TERM' && months.size >= 12) {
    throw new Error(
      'recurringSkipMonths cannot cover all twelve months when skipMode is EXTEND_TERM — the loan would never repay',
    );
  }
}

function validateEventInput(input: LoanEventInput): void {
  if (input.kind === 'LUMP') {
    if (input.amount == null || input.amount <= 0) {
      throw new Error('amount must be positive for LUMP events');
    }
  }
}

export async function listLoans(companyId: string, filter?: ListLoansFilter): Promise<Loan[]> {
  let rows: Row[];
  if (filter?.status) {
    rows = (await sql`
      SELECT * FROM loans
      WHERE company_id = ${companyId} AND status = ${filter.status}
      ORDER BY created_at DESC
    `) as Row[];
  } else {
    rows = (await sql`
      SELECT * FROM loans
      WHERE company_id = ${companyId}
      ORDER BY created_at DESC
    `) as Row[];
  }
  return rows.map(mapLoanRow);
}

export async function getLoanById(companyId: string, loanId: string): Promise<Loan | null> {
  const rows = (await sql`
    SELECT * FROM loans WHERE id = ${loanId} AND company_id = ${companyId}
  `) as Row[];
  return rows.length > 0 ? mapLoanRow(rows[0]!) : null;
}

export async function createLoan(companyId: string, input: LoanCreateInput): Promise<Loan> {
  validateCreate(input);
  const rows = (await sql`
    INSERT INTO loans (
      company_id, curve_id, counterparty_id, gl_account_id,
      reference, product, description,
      principal, start_date, term_months,
      rate_mode, margin, fixed_rate, residual,
      day_count, reprice_mode, skip_mode, lump_mode,
      recurring_skip_months, currency,
      origination_fee, origination_fee_vat_type
    ) VALUES (
      ${companyId},
      ${input.curveId ?? null},
      ${input.counterpartyId ?? null},
      ${input.glAccountId ?? null},
      ${input.reference ?? null},
      ${input.product ?? null},
      ${input.description ?? null},
      ${input.principal},
      ${input.startDate},
      ${input.termMonths},
      ${input.rateMode},
      ${input.margin ?? 0},
      ${input.fixedRate ?? null},
      ${input.residual ?? 0},
      ${input.dayCount ?? 'ACTUAL_365'},
      ${input.repriceMode ?? 'RESOLVE_ON_RATE_CHANGE'},
      ${input.skipMode ?? 'MAINTAIN_TERM'},
      ${input.lumpMode ?? 'REDUCE_INSTALLMENT'},
      ${input.recurringSkipMonths ?? []},
      ${input.currency ?? 'ZAR'},
      ${input.originationFee ?? 0},
      ${input.originationFeeVatType ?? 'standard'}
    )
    RETURNING *
  `) as Row[];

  log.info('Created loan', { companyId, id: String(rows[0]!.id) }, 'loans');
  return mapLoanRow(rows[0]!);
}

export async function updateLoan(
  companyId: string,
  loanId: string,
  input: LoanUpdateInput,
  opts?: { force?: boolean },
): Promise<Loan | null> {
  // recurring_skip_months is not editable here, so only a skipMode switch can
  // turn a stored schedule into the never-repaying one K-084 describes.
  if (input.skipMode !== undefined) {
    const existing = await getLoanById(companyId, loanId);
    if (existing) assertSkipScheduleRepayable(input.skipMode, existing.recurringSkipMonths);
  }

  const financialTermFields = [
    'principal', 'startDate', 'termMonths', 'rateMode', 'margin', 'fixedRate',
    'residual', 'dayCount', 'repriceMode', 'skipMode', 'lumpMode', 'currency',
    'originationFee',
  ] as const;
  const editingFinancialTerms = financialTermFields.some(k => input[k] !== undefined);

  if (editingFinancialTerms && !opts?.force) {
    const postings = (await sql`
      SELECT 1 FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.company_id = ${companyId}::UUID
        AND jl.gl_account_id = (SELECT gl_account_id FROM loans WHERE id = ${loanId} AND company_id = ${companyId}::UUID)
        AND je.status = 'posted'
      LIMIT 1
    `) as Row[];
    if (postings.length > 0) {
      throw new Error(
        'Cannot edit financial terms — loan has posted GL entries. ' +
        'Use status=written_off + create new loan, or pass force=true.'
      );
    }
  }

  const rows = (await sql`
    UPDATE loans SET
      status         = COALESCE(${input.status ?? null}, status),
      gl_account_id  = COALESCE(${input.glAccountId ?? null}::uuid, gl_account_id),
      reference      = COALESCE(${input.reference ?? null}, reference),
      description    = COALESCE(${input.description ?? null}, description),
      principal      = COALESCE(${input.principal ?? null}::numeric, principal),
      start_date     = COALESCE(${input.startDate ?? null}::date, start_date),
      term_months    = COALESCE(${input.termMonths ?? null}::int, term_months),
      rate_mode      = COALESCE(${input.rateMode ?? null}, rate_mode),
      margin         = COALESCE(${input.margin ?? null}::numeric, margin),
      fixed_rate     = COALESCE(${input.fixedRate ?? null}::numeric, fixed_rate),
      residual       = COALESCE(${input.residual ?? null}::numeric, residual),
      day_count      = COALESCE(${input.dayCount ?? null}, day_count),
      reprice_mode   = COALESCE(${input.repriceMode ?? null}, reprice_mode),
      skip_mode      = COALESCE(${input.skipMode ?? null}, skip_mode),
      lump_mode      = COALESCE(${input.lumpMode ?? null}, lump_mode),
      currency       = COALESCE(${input.currency ?? null}, currency),
      origination_fee = COALESCE(${input.originationFee ?? null}::numeric, origination_fee),
      product        = COALESCE(${input.product ?? null}, product),
      counterparty_id = COALESCE(${input.counterpartyId ?? null}::uuid, counterparty_id),
      updated_at    = now()
    WHERE id = ${loanId} AND company_id = ${companyId}
    RETURNING *
  `) as Row[];
  return rows.length > 0 ? mapLoanRow(rows[0]!) : null;
}

export async function deleteLoan(
  companyId: string,
  loanId: string,
  opts?: { force?: boolean },
): Promise<boolean> {
  const postings = (await sql`
    SELECT 1 FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    WHERE je.company_id = ${companyId}::UUID
      AND jl.gl_account_id = (SELECT gl_account_id FROM loans WHERE id = ${loanId} AND company_id = ${companyId}::UUID)
      AND je.status = 'posted'
    LIMIT 1
  `) as Row[];
  if (postings.length > 0 && !opts?.force) {
    throw new Error('Cannot delete — loan has posted GL entries. Pass force=true to override.');
  }
  const rows = (await sql`
    UPDATE loans SET status = 'closed', updated_at = now()
    WHERE id = ${loanId} AND company_id = ${companyId}
    RETURNING id
  `) as Row[];
  return rows.length > 0;
}

export async function addLoanEvent(
  companyId: string,
  loanId: string,
  userId: string,
  input: LoanEventInput,
): Promise<LoanEvent> {
  validateEventInput(input);

  const loans = (await sql`
    SELECT id FROM loans WHERE id = ${loanId} AND company_id = ${companyId}
  `) as Row[];
  if (loans.length === 0) throw new Error(`Loan ${loanId} not found`);

  const rows = (await sql`
    INSERT INTO loan_events (loan_id, company_id, event_date, kind, amount, note, posted_by)
    VALUES (${loanId}, ${companyId}, ${input.date}, ${input.kind}, ${input.amount ?? null}, ${input.note ?? null}, ${userId})
    RETURNING *
  `) as Row[];

  log.info('Added loan event', { loanId, kind: input.kind }, 'loans');
  return mapEventRow(rows[0]!);
}

export async function getLoanEvents(companyId: string, loanId: string): Promise<LoanEvent[]> {
  const rows = (await sql`
    SELECT * FROM loan_events
    WHERE loan_id = ${loanId} AND company_id = ${companyId}
    ORDER BY event_date ASC, posted_at ASC
  `) as Row[];
  return rows.map(mapEventRow).sort((a, b) => a.date.localeCompare(b.date));
}
