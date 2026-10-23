/**
 * Row handling shared by the AR and AP invoice steps of the migration wizard.
 *
 * - Contact matching is the SERVER's matcher (`matchContactWithConfidence`), so
 *   the preview the operator approves is the match the import makes. The pages
 *   used to substring-match, which disagreed with the server both ways.
 * - The payload carries a contact id ONLY when the operator chose one by hand
 *   (see the pages); an automatic preview match is never sent as authoritative.
 * - Amounts go through `parseAmount` and dates through `parseImportDate`: an
 *   unreadable cell is a problem the page shows against its row, never a 0 or
 *   a date Postgres reads month-first.
 */

import { parseAmount } from '@/lib/parseAmount';
import { parseImportDate } from '@/lib/parseImportDate';
import {
  matchContactWithConfidence,
  type ContactCandidate,
  type ContactMatch,
} from '@/modules/accounting/services/core/migrationContactMatch';

export type { ContactMatchConfidence as MatchConfidence } from '@/modules/accounting/services/core/migrationContactMatch';

export function matchRowContact(name: string, contacts: readonly ContactCandidate[]): ContactMatch {
  return matchContactWithConfidence(name, contacts);
}

/** The mapped CSV cells the payload reads; the contact-name column is the page's own. */
export interface InvoiceCells {
  invoice_number?: string;
  invoice_date?: string;
  due_date?: string;
  subtotal?: string;
  tax_amount?: string;
  total_amount?: string;
  amount_paid?: string;
  reference?: string;
}

export interface InvoicePayloadCore {
  invoiceNumber?: string;
  invoiceDate: string;
  dueDate: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  amountPaid: number;
  reference?: string;
}

const AMOUNT_FIELDS = [
  ['subtotal', 'subtotal'], ['tax_amount', 'taxAmount'], ['total_amount', 'totalAmount'], ['amount_paid', 'amountPaid'],
] as const;
const DATE_FIELDS = [['invoice_date', 'invoiceDate'], ['due_date', 'dueDate']] as const;

/**
 * The amount / date / number part of one row's request body, plus every cell
 * that could not be read. A row with problems must not be sent.
 */
export function buildInvoicePayload(cells: InvoiceCells): { payload: InvoicePayloadCore; problems: string[] } {
  const problems: string[] = [];
  const payload: InvoicePayloadCore = {
    invoiceDate: '', dueDate: '', subtotal: 0, taxAmount: 0, totalAmount: 0, amountPaid: 0,
  };
  // Absent, not blank, when the column is unmapped: the routes tell the two apart.
  if (cells.invoice_number !== undefined) payload.invoiceNumber = cells.invoice_number;
  if (cells.reference) payload.reference = cells.reference;

  for (const [cell, key] of AMOUNT_FIELDS) {
    const raw = cells[cell] ?? '';
    const n = parseAmount(raw);
    if (Number.isNaN(n)) problems.push(`${cell} "${raw}" is not a number`);
    else payload[key] = n;
  }
  for (const [cell, key] of DATE_FIELDS) {
    const raw = (cells[cell] ?? '').trim();
    // Blank goes through as blank: the route refuses that one row by name,
    // exactly as before. Only a value that is THERE but unreadable stops here.
    if (raw === '') continue;
    const iso = parseImportDate(raw);
    if (!iso) problems.push(`${cell} "${raw}" is not a date (use DD/MM/YYYY or YYYY-MM-DD)`);
    else payload[key] = iso;
  }
  return { payload, problems };
}

/** One message per row that cannot be sent, numbered as the operator counts data rows. */
export function rowProblems(rows: ReadonlyArray<{ problems: string[]; label?: string }>): string[] {
  return rows.flatMap((r, i) => (r.problems.length > 0
    ? [`Row ${i + 1}${r.label ? ` (${r.label})` : ''}: ${r.problems.join('; ')}`]
    : []));
}
