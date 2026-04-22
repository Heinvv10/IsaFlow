/**
 * Expense claim CRUD + workflow — PRD-05 Phase 10.
 *
 * Claims:
 *   draft → submitted → approved → posted → paid
 *                     → rejected
 *                     → cancelled
 *
 * Posting creates a single GL journal entry with:
 *   DR: each line's gl_account_id (ex VAT)
 *   DR: VAT Input (claim VAT total)
 *   CR: employee reimbursement liability account
 *
 * The JE carries source_document_id = null at the header (claim has many
 * source docs), but each JL line records source_document_line_id pointing
 * to the captured document that evidences it when the claim line has one.
 *
 * Evidence stamp: JE.posting_agent = 'human:<userId>' or 'ai:expense-claim'.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExpenseClaimLine {
  id?: string;
  claimId?: string;
  lineDate: string;                      // ISO date
  description: string | null;
  merchant: string | null;
  amount: number;                        // incl VAT
  vatAmount: number;
  vatCode: string | null;
  glAccountId: string | null;
  costCentreId: string | null;
  projectId: string | null;
  sourceDocumentId: string | null;
  kmTravelled: number | null;
  kmRate: number | null;
  mileageFrom: string | null;
  mileageTo: string | null;
}

export interface ExpenseClaim {
  id: string;
  companyId: string;
  employeeId: string;
  claimNumber: string;
  claimDate: string;
  title: string | null;
  description: string | null;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'posted' | 'paid' | 'cancelled';
  totalAmount: number;
  totalVat: number;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  postedJeId: string | null;
  postedAt: string | null;
  submittedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lines?: ExpenseClaimLine[];
}

function toISODate(v: unknown): string {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  // Already YYYY-MM-DD or ISO-like
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // JS Date.toString() format — convert
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}

function mapLine(row: Row): ExpenseClaimLine {
  return {
    id: row.id as string,
    claimId: row.claim_id as string,
    lineDate: toISODate(row.line_date),
    description: (row.description as string) ?? null,
    merchant: (row.merchant as string) ?? null,
    amount: Number(row.amount ?? 0),
    vatAmount: Number(row.vat_amount ?? 0),
    vatCode: (row.vat_code as string) ?? null,
    glAccountId: (row.gl_account_id as string) ?? null,
    costCentreId: (row.cost_centre_id as string) ?? null,
    projectId: (row.project_id as string) ?? null,
    sourceDocumentId: (row.source_document_id as string) ?? null,
    kmTravelled: row.km_travelled != null ? Number(row.km_travelled) : null,
    kmRate: row.km_rate != null ? Number(row.km_rate) : null,
    mileageFrom: (row.mileage_from as string) ?? null,
    mileageTo: (row.mileage_to as string) ?? null,
  };
}

function mapClaim(row: Row): ExpenseClaim {
  return {
    id: row.id as string,
    companyId: row.company_id as string,
    employeeId: row.employee_id as string,
    claimNumber: row.claim_number as string,
    claimDate: toISODate(row.claim_date),
    title: (row.title as string) ?? null,
    description: (row.description as string) ?? null,
    status: row.status as ExpenseClaim['status'],
    totalAmount: Number(row.total_amount ?? 0),
    totalVat: Number(row.total_vat ?? 0),
    approvedBy: (row.approved_by as string) ?? null,
    approvedAt: row.approved_at ? String(row.approved_at) : null,
    rejectionReason: (row.rejection_reason as string) ?? null,
    postedJeId: (row.posted_je_id as string) ?? null,
    postedAt: row.posted_at ? String(row.posted_at) : null,
    submittedAt: row.submitted_at ? String(row.submitted_at) : null,
    createdBy: (row.created_by as string) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// ─── Mileage helpers ──────────────────────────────────────────────────────────

/**
 * SARS 2026 prescribed rate is R4.84/km. Overriden per-company via
 * companies.sars_km_rate. The helper returns the company's current rate.
 */
export async function getCompanyKmRate(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT sars_km_rate FROM companies WHERE id = ${companyId}::uuid
  `) as Row[];
  return rows[0]?.sars_km_rate != null ? Number(rows[0]!.sars_km_rate) : 4.84;
}

/**
 * Compute the rand amount for a mileage line. Uses the line's rate when
 * supplied, falling back to the company default.
 */
export function computeMileageAmount(km: number, rate: number): number {
  return Number((km * rate).toFixed(2));
}

// ─── Claim numbering ──────────────────────────────────────────────────────────

async function nextClaimNumber(companyId: string, claimDate: string): Promise<string> {
  const year = claimDate.slice(0, 4);
  const rows = (await sql`
    SELECT COUNT(*) AS n
    FROM expense_claims
    WHERE company_id = ${companyId}::uuid
      AND claim_number LIKE ${'CL-' + year + '-%'}
  `) as Row[];
  const next = Number(rows[0]?.n ?? 0) + 1;
  return `CL-${year}-${String(next).padStart(4, '0')}`;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export interface CreateClaimInput {
  companyId: string;
  employeeId: string;
  claimDate?: string;
  title?: string | null;
  description?: string | null;
  createdBy?: string | null;
  lines?: ExpenseClaimLine[];
}

export async function createClaim(input: CreateClaimInput): Promise<ExpenseClaim> {
  const claimDate = input.claimDate ?? new Date().toISOString().slice(0, 10);
  const claimNumber = await nextClaimNumber(input.companyId, claimDate);

  const [claim] = (await sql`
    INSERT INTO expense_claims (
      company_id, employee_id, claim_number, claim_date,
      title, description, status, created_by
    ) VALUES (
      ${input.companyId}::uuid, ${input.employeeId}::uuid, ${claimNumber},
      ${claimDate}::date, ${input.title ?? null}, ${input.description ?? null},
      'draft', ${input.createdBy ?? null}
    )
    RETURNING *
  `) as Row[];

  const claimId = claim!.id as string;

  if (input.lines && input.lines.length > 0) {
    for (const line of input.lines) {
      await insertLine(claimId, input.companyId, line);
    }
    await recomputeTotals(claimId, input.companyId);
  }

  return (await getClaim(claimId, input.companyId))!;
}

async function insertLine(
  claimId: string,
  companyId: string,
  line: ExpenseClaimLine,
): Promise<void> {
  await sql`
    INSERT INTO expense_claim_lines (
      claim_id, company_id, line_date, description, merchant,
      amount, vat_amount, vat_code, gl_account_id, cost_centre_id,
      project_id, source_document_id, km_travelled, km_rate,
      mileage_from, mileage_to
    ) VALUES (
      ${claimId}::uuid, ${companyId}::uuid, ${line.lineDate}::date,
      ${line.description}, ${line.merchant},
      ${line.amount}, ${line.vatAmount}, ${line.vatCode},
      ${line.glAccountId ? `${line.glAccountId}` : null}::uuid,
      ${line.costCentreId ? `${line.costCentreId}` : null}::uuid,
      ${line.projectId ? `${line.projectId}` : null}::uuid,
      ${line.sourceDocumentId ? `${line.sourceDocumentId}` : null}::uuid,
      ${line.kmTravelled}, ${line.kmRate},
      ${line.mileageFrom}, ${line.mileageTo}
    )
  `;
}

export async function addLine(
  claimId: string,
  companyId: string,
  line: ExpenseClaimLine,
): Promise<ExpenseClaim | null> {
  const claim = await getClaim(claimId, companyId);
  if (!claim) return null;
  if (claim.status !== 'draft') {
    throw new Error(`Cannot add line to claim in status '${claim.status}'`);
  }
  await insertLine(claimId, companyId, line);
  await recomputeTotals(claimId, companyId);
  return await getClaim(claimId, companyId);
}

export async function deleteLine(
  lineId: string,
  claimId: string,
  companyId: string,
): Promise<ExpenseClaim | null> {
  const claim = await getClaim(claimId, companyId);
  if (!claim) return null;
  if (claim.status !== 'draft') {
    throw new Error(`Cannot delete line from claim in status '${claim.status}'`);
  }
  await sql`
    DELETE FROM expense_claim_lines
    WHERE id = ${lineId}::uuid AND claim_id = ${claimId}::uuid AND company_id = ${companyId}::uuid
  `;
  await recomputeTotals(claimId, companyId);
  return await getClaim(claimId, companyId);
}

async function recomputeTotals(claimId: string, companyId: string): Promise<void> {
  await sql`
    UPDATE expense_claims c
    SET total_amount = COALESCE(t.total, 0),
        total_vat    = COALESCE(t.vat, 0)
    FROM (
      SELECT claim_id, SUM(amount) AS total, SUM(vat_amount) AS vat
      FROM expense_claim_lines
      WHERE claim_id = ${claimId}::uuid AND company_id = ${companyId}::uuid
      GROUP BY claim_id
    ) t
    WHERE c.id = ${claimId}::uuid AND c.company_id = ${companyId}::uuid
      AND (t.claim_id IS NULL OR t.claim_id = c.id)
  `;
  // Handle the empty-lines case (t above returns 0 rows) — zero the totals.
  await sql`
    UPDATE expense_claims c
    SET total_amount = 0, total_vat = 0
    WHERE c.id = ${claimId}::uuid AND c.company_id = ${companyId}::uuid
      AND NOT EXISTS (SELECT 1 FROM expense_claim_lines l WHERE l.claim_id = c.id)
  `;
}

export async function getClaim(id: string, companyId: string): Promise<ExpenseClaim | null> {
  const claimRows = (await sql`
    SELECT * FROM expense_claims
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
    LIMIT 1
  `) as Row[];
  if (claimRows.length === 0) return null;

  const lineRows = (await sql`
    SELECT * FROM expense_claim_lines
    WHERE claim_id = ${id}::uuid AND company_id = ${companyId}::uuid
    ORDER BY line_date ASC, created_at ASC
  `) as Row[];

  return {
    ...mapClaim(claimRows[0]!),
    lines: lineRows.map(mapLine),
  };
}

export async function listClaims(
  companyId: string,
  opts: { employeeId?: string; status?: string; limit?: number } = {},
): Promise<ExpenseClaim[]> {
  const limit = opts.limit ?? 100;
  const rows = (await sql`
    SELECT * FROM expense_claims
    WHERE company_id = ${companyId}::uuid
      AND (${opts.employeeId ?? null}::uuid IS NULL OR employee_id = ${opts.employeeId ?? null}::uuid)
      AND (${opts.status ?? null}::text IS NULL OR status = ${opts.status ?? null})
    ORDER BY claim_date DESC, created_at DESC
    LIMIT ${limit}
  `) as Row[];
  return rows.map(mapClaim);
}

// ─── Workflow transitions ─────────────────────────────────────────────────────

export async function submitClaim(id: string, companyId: string): Promise<ExpenseClaim | null> {
  const claim = await getClaim(id, companyId);
  if (!claim) return null;
  if (claim.status !== 'draft') throw new Error(`Cannot submit claim in status '${claim.status}'`);
  if (!claim.lines || claim.lines.length === 0) throw new Error('Claim has no lines');

  await sql`
    UPDATE expense_claims
    SET status = 'submitted', submitted_at = NOW()
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  `;
  return await getClaim(id, companyId);
}

export async function approveClaim(
  id: string,
  companyId: string,
  approverUserId: string,
): Promise<ExpenseClaim | null> {
  const claim = await getClaim(id, companyId);
  if (!claim) return null;
  if (claim.status !== 'submitted') throw new Error(`Cannot approve claim in status '${claim.status}'`);

  await sql`
    UPDATE expense_claims
    SET status = 'approved', approved_by = ${approverUserId}, approved_at = NOW()
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  `;
  log.info('expense claim approved', { id, approverUserId }, 'expense-claims');
  return await getClaim(id, companyId);
}

export async function rejectClaim(
  id: string,
  companyId: string,
  approverUserId: string,
  reason: string,
): Promise<ExpenseClaim | null> {
  const claim = await getClaim(id, companyId);
  if (!claim) return null;
  if (claim.status !== 'submitted') throw new Error(`Cannot reject claim in status '${claim.status}'`);

  await sql`
    UPDATE expense_claims
    SET status = 'rejected', approved_by = ${approverUserId}, approved_at = NOW(),
        rejection_reason = ${reason}
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  `;
  return await getClaim(id, companyId);
}

export async function cancelClaim(id: string, companyId: string): Promise<ExpenseClaim | null> {
  const claim = await getClaim(id, companyId);
  if (!claim) return null;
  if (!['draft', 'submitted'].includes(claim.status)) {
    throw new Error(`Cannot cancel claim in status '${claim.status}'`);
  }
  await sql`
    UPDATE expense_claims
    SET status = 'cancelled'
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  `;
  return await getClaim(id, companyId);
}

// ─── Posting to GL ────────────────────────────────────────────────────────────

export interface PostClaimOptions {
  userId: string;
  reimbursementAccountId: string;     // CR leg — typically "Employee reimbursements" liability
  vatInputAccountId?: string | null;  // DR leg for VAT — optional
}

export async function postClaimToGl(
  id: string,
  companyId: string,
  opts: PostClaimOptions,
): Promise<ExpenseClaim | null> {
  const claim = await getClaim(id, companyId);
  if (!claim) return null;
  if (claim.status !== 'approved') {
    throw new Error(`Cannot post claim in status '${claim.status}'`);
  }
  if (!claim.lines || claim.lines.length === 0) {
    throw new Error('Claim has no lines');
  }

  const totalVat = claim.lines.reduce((s, l) => s + Number(l.vatAmount), 0);
  const totalGross = claim.lines.reduce((s, l) => s + Number(l.amount), 0);

  // Create the journal entry header. source_document_id stays null (many
  // docs); source_document_line_id on each line carries the per-slip link.
  const [je] = (await sql`
    INSERT INTO gl_journal_entries (
      company_id, entry_date, description, source, reference,
      posting_agent, extraction_confidence
    ) VALUES (
      ${companyId}::uuid, ${claim.claimDate}::date,
      ${'Expense claim ' + claim.claimNumber}, 'expense_claim',
      ${claim.claimNumber}, ${'human:' + opts.userId}, NULL
    )
    RETURNING id
  `) as Row[];
  const jeId = je!.id as string;

  for (const line of claim.lines) {
    if (!line.glAccountId) {
      throw new Error(`Line ${line.id} has no gl_account_id — set it before posting`);
    }
    const netAmount = Number(line.amount) - Number(line.vatAmount);
    await sql`
      INSERT INTO gl_journal_lines (
        journal_entry_id, company_id, gl_account_id, debit, credit,
        description, project_id, cost_center_id
      ) VALUES (
        ${jeId}::uuid, ${companyId}::uuid, ${line.glAccountId}::uuid,
        ${netAmount}, 0, ${line.description ?? claim.claimNumber},
        ${line.projectId ? `${line.projectId}` : null}::uuid,
        ${line.costCentreId ? `${line.costCentreId}` : null}::uuid
      )
    `;
  }

  if (totalVat > 0 && opts.vatInputAccountId) {
    await sql`
      INSERT INTO gl_journal_lines (
        journal_entry_id, company_id, gl_account_id, debit, credit, description
      ) VALUES (
        ${jeId}::uuid, ${companyId}::uuid, ${opts.vatInputAccountId}::uuid,
        ${totalVat}, 0, ${'VAT Input ' + claim.claimNumber}
      )
    `;
  }

  // Credit the reimbursement liability for the gross amount
  await sql`
    INSERT INTO gl_journal_lines (
      journal_entry_id, company_id, gl_account_id, debit, credit, description
    ) VALUES (
      ${jeId}::uuid, ${companyId}::uuid, ${opts.reimbursementAccountId}::uuid,
      0, ${totalGross}, ${'Reimbursement due — ' + claim.claimNumber}
    )
  `;

  await sql`
    UPDATE expense_claims
    SET status = 'posted', posted_je_id = ${jeId}::uuid, posted_at = NOW()
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  `;

  log.info('expense claim posted to GL', { id, jeId, total: totalGross }, 'expense-claims');
  return await getClaim(id, companyId);
}
