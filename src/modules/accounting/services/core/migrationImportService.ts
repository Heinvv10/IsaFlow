/**
 * Migration Import Service — Opening Balances + AR Invoices
 * PRD: Customer Migration Wizard — Phase 1
 *
 * AP invoice import is in migrationApService.ts.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import { updateSession, type ImportResult, type MigrationError } from './migrationService';
import { resolveSettlementAccountId } from './migrationPostingSupport';
import type { DbRow } from '@/types/db';


export interface OpeningBalanceRow {
  accountCode: string;
  debit: number;
  credit: number;
}

export interface ARInvoiceRow {
  invoiceNumber: string;
  customerName: string;
  invoiceDate: string;
  dueDate: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  /** Optional: absent and 0 mean the same thing — nothing has been paid. */
  amountPaid?: number;
  reference?: string;
}

// ── Opening Balances ─────────────────────────────────────────────────────────

export async function importOpeningBalances(
  companyId: string,
  sessionId: string,
  effectiveDate: string,
  balances: OpeningBalanceRow[],
  userId: string,
): Promise<{ journalEntryId: string; errors: MigrationError[] }> {
  const errors: MigrationError[] = [];

  const totalDebit  = balances.reduce((s, b) => s + (b.debit ?? 0), 0);
  const totalCredit = balances.reduce((s, b) => s + (b.credit ?? 0), 0);

  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(
      `Trial balance is not balanced: debits ${totalDebit.toFixed(2)} ≠ credits ${totalCredit.toFixed(2)}`
    );
  }

  const lines = [];
  for (let i = 0; i < balances.length; i++) {
    const bal = balances[i]!;
    if (bal.debit === 0 && bal.credit === 0) continue;

    const acctRows = (await sql`
      SELECT id FROM gl_accounts
      WHERE account_code = ${bal.accountCode} AND company_id = ${companyId}::UUID
    `) as DbRow[];

    if (acctRows.length === 0) {
      errors.push({ step: 'opening_balances', row: i, field: 'accountCode', message: `Account ${bal.accountCode} not found` });
      continue;
    }

    lines.push({
      glAccountId: String(acctRows[0]!.id),
      debit: bal.debit ?? 0,
      credit: bal.credit ?? 0,
      description: `Opening balance — ${bal.accountCode}`,
    });
  }

  if (lines.length === 0) {
    throw new Error('No valid balance rows to import');
  }

  const entry = await createJournalEntry(companyId, {
    entryDate: effectiveDate,
    description: 'Opening balances — migration import',
    source: 'auto_migration',
    lines,
  }, userId);

  await postJournalEntry(companyId, entry.id, userId);

  await updateSession(sessionId, companyId, {
    openingBalancesSet: true,
    stepsCompleted: { opening_balances: true },
    errors,
  });

  log.info('Opening balances imported', { companyId, journalEntryId: entry.id, lines: lines.length }, 'migration');
  return { journalEntryId: entry.id, errors };
}

// ── AR Invoice Import ────────────────────────────────────────────────────────

export async function importARInvoices(
  companyId: string,
  sessionId: string,
  invoices: ARInvoiceRow[],
  userId: string,
): Promise<ImportResult> {
  const errors: MigrationError[] = [];
  let imported = 0;
  let skipped = 0;

  const arAccountId      = await getSystemAccountId('receivable', companyId);
  const revenueAccountId = await getSystemAccountId('default_revenue', companyId);
  const vatOutputId      = await getSystemAccountId('vat_output', companyId);

  const settlementAccountId = await resolveSettlementAccountId(
    companyId,
    invoices.some(inv => (inv.amountPaid ?? 0) > 0),
  );

  const custRows = (await sql`
    SELECT id, name FROM customers WHERE company_id = ${companyId}::UUID
  `) as DbRow[];

  // Migration 530 stores the origin of a document IsaFlow did not create as a
  // pair: external_ref plus the system it came from. Writing the reference
  // without the system leaves it unattributable.
  const sessRows = (await sql`
    SELECT source_system FROM migration_sessions
    WHERE id = ${sessionId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const sourceSystem = sessRows.length > 0 ? String(sessRows[0]!.source_system) : 'csv_import';

  for (let i = 0; i < invoices.length; i++) {
    const inv = invoices[i]!;
    try {
      const customerId = matchContact(inv.customerName, custRows);
      if (!customerId) {
        errors.push({ step: 'ar_invoices', row: i, field: 'customerName', message: `Customer not found: ${inv.customerName}` });
        skipped++;
        continue;
      }

      // M4/R-002: the journal is built from subtotal + tax and debited with
      // totalAmount, so a source file whose three amounts disagree by a cent
      // produces an unbalanced entry that postJournalEntry rejects — losing the
      // document with a raw Postgres-flavoured message. Reject it here instead,
      // naming all three amounts so the operator can correct the file.
      if (Math.abs(inv.subtotal + inv.taxAmount - inv.totalAmount) > 0.005) {
        errors.push({
          step: 'ar_invoices', row: i, field: 'totalAmount',
          message: `Amounts do not add up for ${inv.invoiceNumber}: subtotal ${inv.subtotal.toFixed(2)} + tax ${inv.taxAmount.toFixed(2)} != total ${inv.totalAmount.toFixed(2)}`,
        });
        skipped++;
        continue;
      }

      const amountPaid = inv.amountPaid ?? 0;
      const balance = inv.totalAmount - amountPaid;
      const status  = balance <= 0 ? 'paid' : amountPaid > 0 ? 'partially_paid' : 'approved';

      // customer_invoices has no `reference` column: migration 530 added
      // external_ref for exactly this — the source system's own reference on
      // a document IsaFlow did not originate.
      // Every statement for this row runs inside its own savepoint: a caught
      // per-row failure must not leave the request transaction aborted, or the
      // updateSession below dies with 25P02 and the whole route 500s.
      const rowImported = await withSavepoint('mig_ar_invoice_row', async () => {
        const invRows = (await sql`
          INSERT INTO customer_invoices (
            company_id, customer_id, invoice_number, invoice_date, due_date,
            subtotal, tax_amount, total_amount, amount_paid,
            status, external_ref, external_system, created_by
          ) VALUES (
            ${companyId}::UUID, ${customerId}::UUID, ${inv.invoiceNumber},
            ${inv.invoiceDate}::DATE, ${inv.dueDate}::DATE,
            ${inv.subtotal}, ${inv.taxAmount}, ${inv.totalAmount},
            ${amountPaid}, ${status},
            ${inv.reference ?? null}, ${inv.reference ? sourceSystem : null}, ${userId}::UUID
          )
          ON CONFLICT (company_id, invoice_number) DO NOTHING
          RETURNING id
        `) as DbRow[];

        // uq_customer_invoices_company_number swallowed the row silently; the
        // operator saw a skip count with no reason and no invoice number.
        if (invRows.length === 0) {
          errors.push({
            step: 'ar_invoices', row: i, field: 'invoiceNumber',
            message: `Invoice number already exists: ${inv.invoiceNumber}`,
          });
          return false;
        }
        const invoiceId = String(invRows[0]!.id);

        const journalLines = [
          { glAccountId: arAccountId,      debit: inv.totalAmount, credit: 0,             description: `AR — ${inv.invoiceNumber}` },
          { glAccountId: revenueAccountId, debit: 0,               credit: inv.subtotal,  description: `Revenue — ${inv.invoiceNumber}` },
        ];
        if (inv.taxAmount > 0) {
          journalLines.push({ glAccountId: vatOutputId, debit: 0, credit: inv.taxAmount, description: `VAT — ${inv.invoiceNumber}` });
        }

        // No sourceDocumentId: gl_journal_entries.source_document_id has an FK
        // to captured_documents(id) only (migration 409); the invoice's own id
        // would violate it. The invoice <-> journal entry link is instead
        // persisted below via customer_invoices.gl_journal_entry_id — same
        // column postCustomerInvoiceToGL uses for a normally-created invoice's
        // own posting entry; safe here because a migrated invoice is inserted
        // pre-approved and never goes through that flow afterward.
        const entry = await createJournalEntry(companyId, {
          entryDate: inv.invoiceDate,
          description: `Migrated AR invoice ${inv.invoiceNumber}`,
          source: 'auto_migration',
          lines: journalLines,
        }, userId);
        await postJournalEntry(companyId, entry.id, userId);
        await sql`
          UPDATE customer_invoices SET gl_journal_entry_id = ${entry.id}::UUID
          WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
        `;

        // The origination entry debits receivable with the FULL total, but the
        // invoice is stored with the amount already settled before the cutover.
        // Without this leg the AR control account and the AR subledger disagree
        // by exactly amountPaid. The contra is opening balance equity — the
        // clearing account for everything that happened before the cutover; a
        // bank leg would invent a cash movement the bank's own opening balance
        // already accounts for. The account is resolved once for the whole
        // step, so a company without one fails the step with a single message
        // instead of failing once per part-paid row.
        if (amountPaid > 0 && settlementAccountId) {
          const settlement = await createJournalEntry(companyId, {
            entryDate: inv.invoiceDate,
            description: `Migrated AR invoice ${inv.invoiceNumber} — settled before cutover`,
            source: 'auto_migration',
            lines: [
              { glAccountId: settlementAccountId, debit: amountPaid, credit: 0,   description: `Opening balance equity — ${inv.invoiceNumber}` },
              { glAccountId: arAccountId,  debit: 0,          credit: amountPaid, description: `AR settled — ${inv.invoiceNumber}` },
            ],
          }, userId);
          await postJournalEntry(companyId, settlement.id, userId);
        }
        return true;
      });
      if (rowImported) imported++; else skipped++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ step: 'ar_invoices', row: i, message: msg });
      skipped++;
    }
  }

  await updateSession(sessionId, companyId, { arInvoicesImported: imported, stepsCompleted: { ar_invoices: true }, errors });
  log.info('AR invoices imported', { companyId, imported, skipped }, 'migration');
  return { imported, skipped, errors };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function matchContact(name: string, candidates: DbRow[]): string | null {
  const normalized = name.toLowerCase().trim();
  const exact = candidates.find(c => String(c.name).toLowerCase().trim() === normalized);
  if (exact) return String(exact.id);
  let best: { id: string; score: number } | null = null;
  for (const c of candidates) {
    const score = diceCoefficient(normalized, String(c.name).toLowerCase().trim());
    if (score >= 0.7 && (!best || score > best.score)) best = { id: String(c.id), score };
  }
  return best?.id ?? null;
}

function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ba = new Set<string>(), bb = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) ba.add(a.substring(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) bb.add(b.substring(i, i + 2));
  let n = 0;
  for (const g of ba) { if (bb.has(g)) n++; }
  return (2 * n) / (ba.size + bb.size);
}
