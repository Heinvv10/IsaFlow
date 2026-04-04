/**
 * Migration Import Service — Opening Balances + AR Invoices
 * PRD: Customer Migration Wizard — Phase 1
 *
 * AP invoice import is in migrationApService.ts.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from './journalEntryService';
import { getSystemAccountId } from './systemAccountResolver';
import { updateSession, type ImportResult, type MigrationError } from './migrationService';
type Row = any;


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
  amountPaid: number;
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
    `) as Row[];

    if (acctRows.length === 0) {
      errors.push({ step: 'opening_balances', row: i, field: 'accountCode', message: `Account ${bal.accountCode} not found` });
      continue;
    }

    lines.push({
      glAccountId: String(acctRows[0].id),
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

  const arAccountId      = await getSystemAccountId('receivable');
  const revenueAccountId = await getSystemAccountId('default_revenue');
  const vatOutputId      = await getSystemAccountId('vat_output');

  const custRows = (await sql`
    SELECT id, name FROM customers WHERE company_id = ${companyId}::UUID
  `) as Row[];

  for (let i = 0; i < invoices.length; i++) {
    const inv = invoices[i]!;
    try {
      const customerId = matchContact(inv.customerName, custRows);
      if (!customerId) {
        errors.push({ step: 'ar_invoices', row: i, field: 'customerName', message: `Customer not found: ${inv.customerName}` });
        skipped++;
        continue;
      }

      const balance = inv.totalAmount - (inv.amountPaid ?? 0);
      const status  = balance <= 0 ? 'paid' : inv.amountPaid > 0 ? 'partially_paid' : 'approved';

      const invRows = (await sql`
        INSERT INTO customer_invoices (
          company_id, customer_id, invoice_number, invoice_date, due_date,
          subtotal, tax_amount, total_amount, amount_paid, balance_due,
          status, reference, created_by
        ) VALUES (
          ${companyId}::UUID, ${customerId}::UUID, ${inv.invoiceNumber},
          ${inv.invoiceDate}::DATE, ${inv.dueDate}::DATE,
          ${inv.subtotal}, ${inv.taxAmount}, ${inv.totalAmount},
          ${inv.amountPaid ?? 0}, ${balance}, ${status},
          ${inv.reference ?? null}, ${userId}::UUID
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `) as Row[];

      if (invRows.length === 0) { skipped++; continue; }
      const invoiceId = String(invRows[0].id);

      const journalLines = [
        { glAccountId: arAccountId,      debit: inv.totalAmount, credit: 0,             description: `AR — ${inv.invoiceNumber}` },
        { glAccountId: revenueAccountId, debit: 0,               credit: inv.subtotal,  description: `Revenue — ${inv.invoiceNumber}` },
      ];
      if (inv.taxAmount > 0) {
        journalLines.push({ glAccountId: vatOutputId, debit: 0, credit: inv.taxAmount, description: `VAT — ${inv.invoiceNumber}` });
      }

      const entry = await createJournalEntry(companyId, {
        entryDate: inv.invoiceDate,
        description: `Migrated AR invoice ${inv.invoiceNumber}`,
        source: 'auto_migration',
        sourceDocumentId: invoiceId,
        lines: journalLines,
      }, userId);
      await postJournalEntry(companyId, entry.id, userId);
      imported++;
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

export function matchContact(name: string, candidates: Row[]): string | null {
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
