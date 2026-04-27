/**
 * VAT Submission Service
 *
 * Closes out a VAT period by:
 *   1. Computing the period's output/input tax via getVATReturn.
 *   2. Posting a clearing journal entry that zeroes accounts 1140 (VAT Input)
 *      and 2120 (VAT Output) and parks the net balance in:
 *        - 2130 Accrued Expenses (liability) when net VAT is PAYABLE to SARS
 *          (totalOutputTax > totalInputTax — the normal SA vendor situation).
 *        - 2130 Accrued Expenses (debit, i.e. reduces liability) when a net
 *          REFUND is due from SARS. If the chart has a dedicated receivable, swap
 *          this to 'receivable'; Accrued Expenses is used because no dedicated
 *          "VAT Payable / VAT Receivable" system account exists in the default
 *          IsaFlow chart of accounts.
 *   3. Writing a vat_returns row for idempotency and audit.
 *
 * Balance formula (payable case):
 *   DR 2120 VAT Output  totalOutputTax
 *   CR 1140 VAT Input   totalInputTax
 *   CR 2130 Accrued Exp netVat              (netVat = totalOutputTax - totalInputTax)
 *   -- DR = CR: totalOutputTax = totalInputTax + netVat  ✓
 *
 * Refund case (totalInputTax > totalOutputTax):
 *   DR 2120 VAT Output  totalOutputTax
 *   DR 2130 Accrued Exp netVat              (netVat = totalInputTax - totalOutputTax, positive)
 *   CR 1140 VAT Input   totalInputTax
 *   -- DR = CR: totalOutputTax + netVat = totalInputTax  ✓
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getVATReturn } from './vatReturnService';
import { createJournalEntry, postJournalEntry, resolveUserUuid } from '../gl/journalEntryService';
import { getSystemAccount } from '../gl/systemAccountResolver';
import type { JournalLineInput } from '../../types/gl.types';

/**
 * Resolve the "net VAT" clearing account.
 * Prefers account_code 2130 (Accrued Expenses) — which has no system subtype in the
 * default IsaFlow chart — and falls back to the 'payable' system account (2110)
 * if 2130 is absent. Keeping the net in Accrued Expenses rather than Accounts Payable
 * separates SARS obligations from trade creditors for reporting clarity.
 */
async function resolveNetVatAccount(companyId: string): Promise<{ id: string }> {
  const rows = (await sql`
    SELECT id FROM gl_accounts
    WHERE company_id = ${companyId}::UUID
      AND account_code = '2130'
      AND is_active = true
    LIMIT 1
  `) as Row[];

  if (rows.length > 0) return { id: String(rows[0]!.id) };

  // Fallback to system payable account (2110 Accounts Payable)
  log.warn('Account 2130 not found; falling back to payable system account', { companyId }, 'accounting');
  return getSystemAccount('payable', companyId);
}

type Row = DbRow;

// ── Public types ─────────────────────────────────────────────────────────────

export interface VATSubmitInput {
  periodStart: string;
  periodEnd: string;
  sarsReference?: string;
}

export interface VATReturnRecord {
  id: string;
  companyId: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  totalOutputTax: number;
  totalInputTax: number;
  netVat: number;
  sarsReference?: string;
  submittedAt: string;
  submittedBy?: string;
  journalEntryId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListVATReturnsOptions {
  year?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function mapRow(row: Row): VATReturnRecord {
  return {
    id:             String(row.id),
    companyId:      String(row.company_id),
    periodStart:    String(row.period_start),
    periodEnd:      String(row.period_end),
    status:         String(row.status),
    totalOutputTax: Number(row.total_output_tax),
    totalInputTax:  Number(row.total_input_tax),
    netVat:         Number(row.net_vat),
    sarsReference:  row.sars_reference ? String(row.sars_reference) : undefined,
    submittedAt:    String(row.submitted_at),
    submittedBy:    row.submitted_by ? String(row.submitted_by) : undefined,
    journalEntryId: row.journal_entry_id ? String(row.journal_entry_id) : undefined,
    createdAt:      String(row.created_at),
    updatedAt:      String(row.updated_at),
  };
}

// ── submitVATReturn ───────────────────────────────────────────────────────────

/**
 * Submit a VAT return for the given period.
 * Idempotent: throws if a 'submitted' record already exists for the period.
 */
export async function submitVATReturn(
  companyId: string,
  input: VATSubmitInput,
  userId: string,
): Promise<VATReturnRecord> {
  const { periodStart, periodEnd, sarsReference } = input;

  // 1. Idempotency guard
  const existing = (await sql`
    SELECT id FROM vat_returns
    WHERE company_id = ${companyId}::UUID
      AND period_start = ${periodStart}::DATE
      AND period_end   = ${periodEnd}::DATE
      AND status = 'submitted'
    LIMIT 1
  `) as Row[];

  if (existing.length > 0) {
    throw new Error(
      `VAT return for ${periodStart}–${periodEnd} has already been submitted (id: ${existing[0]!.id}).`,
    );
  }

  // 2. Compute the period's VAT figures
  const vatReturn = await getVATReturn(companyId, periodStart, periodEnd);
  const { totalOutputTax, totalInputTax } = vatReturn;
  const netVat = totalOutputTax - totalInputTax; // positive = payable, negative = refund

  log.info('VAT return figures', { companyId, periodStart, periodEnd, totalOutputTax, totalInputTax, netVat }, 'accounting');

  // 3. Resolve system accounts
  const [vatOutputAcc, vatInputAcc, accruedAcc, safeUserId] = await Promise.all([
    getSystemAccount('vat_output', companyId),
    getSystemAccount('vat_input',  companyId),
    resolveNetVatAccount(companyId),   // 2130 Accrued Expenses (falls back to 2110 payable)
    resolveUserUuid(userId),
  ]);

  // 4. Build journal lines — skip any zero-amount line. A nil VAT201 (no
  // output, no input) produces no lines and we record the submission without
  // posting a journal. Use abs > 0.005 so credit notes inside the period
  // (which can flip an output/input total negative) still create a line on
  // the appropriate side.
  //    Payable:  DR vatOutput / CR vatInput / CR accruedExp (net)
  //    Refund:   DR vatOutput / DR accruedExp (net abs) / CR vatInput
  const lines: JournalLineInput[] = [];

  if (Math.abs(totalOutputTax) > 0.005) {
    // Net DR 2120 VAT Output — closes the liability accumulated during the
    // period. Negative output (credit notes > new sales) flips to a CR.
    lines.push({
      glAccountId: vatOutputAcc.id,
      debit:       totalOutputTax > 0 ? totalOutputTax : 0,
      credit:      totalOutputTax < 0 ? Math.abs(totalOutputTax) : 0,
      description: `VAT return submission ${periodStart} to ${periodEnd} — output tax`,
    });
  }

  if (Math.abs(totalInputTax) > 0.005) {
    // Net CR 1140 VAT Input — closes the asset accumulated during the
    // period. Negative input (return-to-supplier > new claims) flips to a DR.
    lines.push({
      glAccountId: vatInputAcc.id,
      debit:       totalInputTax < 0 ? Math.abs(totalInputTax) : 0,
      credit:      totalInputTax > 0 ? totalInputTax : 0,
      description: `VAT return submission ${periodStart} to ${periodEnd} — input tax`,
    });
  }

  if (Math.abs(netVat) > 0.001) {
    if (netVat > 0) {
      // Net payable to SARS: CR Accrued Expenses
      lines.push({
        glAccountId: accruedAcc.id,
        debit:       0,
        credit:      netVat,
        description: `VAT payable to SARS — ${sarsReference ?? periodEnd}`,
      });
    } else {
      // Net refund from SARS: DR Accrued Expenses (reduces liability / parks receivable)
      lines.push({
        glAccountId: accruedAcc.id,
        debit:       Math.abs(netVat),
        credit:      0,
        description: `VAT refund due from SARS — ${sarsReference ?? periodEnd}`,
      });
    }
  }

  // 5. Create and post the journal entry — skip entirely for a nil return
  let journalEntryId: string | null = null;
  if (lines.length > 0) {
    const je = await createJournalEntry(companyId, {
      entryDate:   periodEnd,
      description: `VAT201 submission ${periodStart} to ${periodEnd}`,
      source:      'auto_vat_submission',
      lines,
    }, safeUserId);

    await postJournalEntry(companyId, je.id, safeUserId);
    journalEntryId = je.id;

    log.info('VAT submission journal posted', { journalEntryId }, 'accounting');
  } else {
    log.info('Nil VAT201 submission — no journal posted', { companyId, periodStart, periodEnd }, 'accounting');
  }

  // 6. Insert vat_returns record
  const absNetVat = netVat; // signed: positive = payable, negative = refund
  const rows = (await sql`
    INSERT INTO vat_returns (
      company_id, period_start, period_end, status,
      total_output_tax, total_input_tax, net_vat,
      sars_reference, submitted_by, journal_entry_id
    ) VALUES (
      ${companyId}::UUID,
      ${periodStart}::DATE,
      ${periodEnd}::DATE,
      'submitted',
      ${totalOutputTax},
      ${totalInputTax},
      ${absNetVat},
      ${sarsReference ?? null},
      ${safeUserId}::UUID,
      ${journalEntryId}::UUID
    )
    RETURNING *
  `) as Row[];

  const record = mapRow(rows[0]!);
  log.info('VAT return record created', { id: record.id, netVat }, 'accounting');
  return record;
}

// ── listVATReturns ────────────────────────────────────────────────────────────

export async function listVATReturns(
  companyId: string,
  options?: ListVATReturnsOptions,
): Promise<VATReturnRecord[]> {
  const rows = options?.year
    ? (await sql`
        SELECT * FROM vat_returns
        WHERE company_id = ${companyId}::UUID
          AND EXTRACT(YEAR FROM period_start) = ${options.year}
        ORDER BY period_start DESC
      `) as Row[]
    : (await sql`
        SELECT * FROM vat_returns
        WHERE company_id = ${companyId}::UUID
        ORDER BY period_start DESC
        LIMIT 50
      `) as Row[];

  return rows.map(mapRow);
}
