/**
 * Tax Directive Payment Service
 * Applies an approved SARS directive: disburses gross, withholds PAYE, and
 * posts the GL journal entry.  One payment per directive (idempotent).
 *
 * Journal shape:
 *   DR 5200 Labour Costs       = gross_amount
 *   CR 2140 PAYE Payable       = paye_amount
 *   CR 1110 Bank (or override) = net_amount
 *
 * All queries scoped by company_id (multi-tenant).
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import type { JournalEntryCreateInput, JournalLineInput } from '@/modules/accounting/types/gl.types';

type Row = DbRow;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ApplyDirectiveInput {
  paymentDate: string;     // YYYY-MM-DD
  bankAccountId?: string;  // override GL 1110 Bank
}

export interface ApplyDirectiveResult {
  paymentId: string;
  journalEntryId: string;
  gross: number;
  paye: number;
  net: number;
  status: 'applied';
}

export interface TaxDirectivePayment {
  id: string;
  companyId: string;
  taxDirectiveId: string;
  paymentDate: string;
  grossAmount: number;
  payeAmount: number;
  netAmount: number;
  bankAccountId: string | null;
  journalEntryId: string | null;
  createdBy: string | null;
  createdAt: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const toDate = (v: unknown): string => fmtDate(v);

const num = (v: unknown): number => parseFloat(String(v ?? '0'));

const round2 = (n: number): number => Math.round(n * 100) / 100;

function mapPaymentRow(r: Row): TaxDirectivePayment {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    taxDirectiveId: String(r.tax_directive_id),
    paymentDate: toDate(r.payment_date),
    grossAmount: num(r.gross_amount),
    payeAmount: num(r.paye_amount),
    netAmount: num(r.net_amount),
    bankAccountId: r.bank_account_id != null ? String(r.bank_account_id) : null,
    journalEntryId: r.journal_entry_id != null ? String(r.journal_entry_id) : null,
    createdBy: r.created_by != null ? String(r.created_by) : null,
    createdAt: String(r.created_at),
  };
}

async function glByCode(companyId: string, code: string): Promise<string | null> {
  const rows = (await sql`
    SELECT id FROM gl_accounts
    WHERE company_id = ${companyId} AND code = ${code}
    LIMIT 1
  `) as Row[];
  return rows.length > 0 ? String(rows[0]!.id) : null;
}

// ─── applyTaxDirective ────────────────────────────────────────────────────────

export async function applyTaxDirective(
  companyId: string,
  directiveId: string,
  input: ApplyDirectiveInput,
  userId: string,
): Promise<ApplyDirectiveResult> {
  log.info('applyTaxDirective start', { companyId, directiveId }, 'taxDirective');

  // 1. Idempotency guard — block duplicate payment for same directive
  const existing = (await sql`
    SELECT id FROM tax_directive_payments
    WHERE company_id = ${companyId} AND tax_directive_id = ${directiveId}
    LIMIT 1
  `) as Row[];
  if (existing.length > 0) {
    throw new Error(`Directive ${directiveId} has already been applied (paymentId: ${String(existing[0]!.id)})`);
  }

  // 2. Load directive — scoped by company_id
  const dirRows = (await sql`
    SELECT * FROM tax_directives
    WHERE company_id = ${companyId} AND id = ${directiveId}
    LIMIT 1
  `) as Row[];
  if (dirRows.length === 0) throw new Error(`Tax directive ${directiveId} not found`);
  const dir = dirRows[0]!;

  const currentStatus = String(dir.status);
  if (currentStatus !== 'approved') {
    throw new Error(
      `Cannot apply tax directive with status '${currentStatus}' — directive must be 'approved' first`,
    );
  }

  // 3. Compute amounts
  const gross = round2(num(dir.amount));

  let paye: number;
  if (dir.tax_rate != null) {
    paye = round2(gross * num(dir.tax_rate));
  } else if (dir.tax_amount != null) {
    paye = round2(num(dir.tax_amount));
  } else {
    throw new Error(
      `Directive ${directiveId} has no tax_rate or tax_amount — set the SARS directive rate before applying`,
    );
  }

  const net = round2(gross - paye);

  // Cent-level balance guard: DR gross = CR paye + CR net
  if (Math.round(gross * 100) !== Math.round((paye + net) * 100)) {
    throw new Error(
      `Journal imbalance: DR ${gross.toFixed(2)} ≠ CR ${(paye + net).toFixed(2)} (rounding error)`,
    );
  }

  // 4. Resolve GL accounts
  const labourAccountId = await glByCode(companyId, '5200');
  if (!labourAccountId) {
    throw new Error('GL account 5200 (Labour Costs) not found — ensure chart of accounts is seeded');
  }

  const payeAccountId = await glByCode(companyId, '2140');
  if (!payeAccountId) {
    throw new Error('GL account 2140 (PAYE Payable) not found — ensure chart of accounts is seeded');
  }

  let bankAccountId: string | null = input.bankAccountId ?? null;
  if (!bankAccountId) {
    bankAccountId = await glByCode(companyId, '1110');
    if (bankAccountId) {
      log.warn('No bankAccountId supplied — using GL 1110 (Bank)', { companyId, directiveId }, 'taxDirective');
    }
  }
  if (!bankAccountId) {
    throw new Error('Cannot resolve bank GL account — supply bankAccountId or add GL account 1110');
  }

  // 5. Build journal
  const employeeName = String(dir.employee_name);
  const directiveNum = dir.directive_number != null ? String(dir.directive_number) : directiveId.slice(0, 8);
  const narrative = `SARS directive ${directiveNum} — ${employeeName}`;

  const lines: JournalLineInput[] = [
    {
      glAccountId: labourAccountId,
      debit: gross,
      credit: 0,
      description: `${narrative} — gross lump sum`,
    },
    {
      glAccountId: payeAccountId,
      debit: 0,
      credit: paye,
      description: `${narrative} — PAYE withheld`,
    },
    {
      glAccountId: bankAccountId,
      debit: 0,
      credit: net,
      description: `${narrative} — net disbursement`,
    },
  ];

  const journalInput: JournalEntryCreateInput = {
    entryDate: input.paymentDate,
    description: narrative,
    source: 'auto_payroll',
    lines,
  };

  // 6. Create + post journal entry
  const entry = await createJournalEntry(companyId, journalInput, userId);
  await postJournalEntry(companyId, entry.id, userId);

  // 7. Persist payment record
  const payRows = (await sql`
    INSERT INTO tax_directive_payments (
      company_id, tax_directive_id, payment_date,
      gross_amount, paye_amount, net_amount,
      bank_account_id, journal_entry_id, created_by
    ) VALUES (
      ${companyId}, ${directiveId}, ${input.paymentDate},
      ${gross}, ${paye}, ${net},
      ${bankAccountId}, ${entry.id}, ${userId}
    )
    RETURNING id
  `) as Row[];

  const paymentId = String(payRows[0]!.id);

  log.info('Tax directive applied', {
    companyId, directiveId, paymentId, journalEntryId: entry.id, gross, paye, net,
  }, 'taxDirective');

  return { paymentId, journalEntryId: entry.id, gross, paye, net, status: 'applied' };
}

// ─── listTaxDirectivePayments ─────────────────────────────────────────────────

export async function listTaxDirectivePayments(
  companyId: string,
  filter: { directiveId?: string } = {},
): Promise<TaxDirectivePayment[]> {
  log.debug('listTaxDirectivePayments', { companyId, ...filter }, 'taxDirective');

  const rows = (await sql`
    SELECT *
    FROM tax_directive_payments
    WHERE company_id = ${companyId}
      AND (
        ${filter.directiveId ?? null}::uuid IS NULL
        OR tax_directive_id = ${filter.directiveId ?? null}::uuid
      )
    ORDER BY payment_date DESC, created_at DESC
  `) as Row[];

  return rows.map(mapPaymentRow);
}
