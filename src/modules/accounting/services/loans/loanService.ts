import { sql } from '@/lib/neon';
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
    startDate: String(row.start_date).slice(0, 10),
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
    date: String(row.event_date).slice(0, 10),
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
): Promise<Loan | null> {
  const rows = (await sql`
    UPDATE loans SET
      status        = COALESCE(${input.status ?? null}, status),
      gl_account_id = COALESCE(${input.glAccountId ?? null}::uuid, gl_account_id),
      reference     = COALESCE(${input.reference ?? null}, reference),
      description   = COALESCE(${input.description ?? null}, description),
      updated_at    = now()
    WHERE id = ${loanId} AND company_id = ${companyId}
    RETURNING *
  `) as Row[];
  return rows.length > 0 ? mapLoanRow(rows[0]!) : null;
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
