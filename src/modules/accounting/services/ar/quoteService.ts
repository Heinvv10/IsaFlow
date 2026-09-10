/**
 * Customer Quote Service — Sage-parity quotes with convert-to-invoice
 * Convert operations split to quoteConvertService.ts
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertCustomerInCompany } from '../core/contactDirectoryService';
import { insertWithReservedNumber } from '../core/documentNumberRetry';

type Row = DbRow;

export interface QuoteLine {
  id: string;
  quoteId: string;
  lineNumber: number;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  lineTotal: number;
  accountId: string | null;
}

export interface Quote {
  id: string;
  quoteNumber: string;
  clientId: string | null;
  customerName: string;
  quoteDate: string;
  expiryDate: string | null;
  status: string;
  subtotal: number;
  taxAmount: number;
  total: number;
  notes: string | null;
  terms: string | null;
  convertedInvoiceId: string | null;
  createdAt: string;
  updatedAt: string;
  lines?: QuoteLine[];
}

interface QuoteFilters {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

interface QuoteInput {
  customerName: string;
  clientId?: string;
  quoteDate?: string;
  expiryDate?: string;
  notes?: string;
  terms?: string;
  lines: { description: string; quantity: number; unitPrice: number; taxRate?: number; accountId?: string }[];
}

function mapQuote(r: Row): Quote {
  return {
    id: String(r.id), quoteNumber: String(r.quote_number), clientId: r.client_id != null ? String(r.client_id) : null,
    // pg returns DATE columns as JS Date objects; String(Date) yields
    // "Sun Jul 05 2026 … GMT+0200 …" which Postgres rejects when the value is
    // fed back into conversion INSERTs (H3 family). fmtDate → YYYY-MM-DD.
    customerName: String(r.customer_name), quoteDate: fmtDate(r.quote_date),
    expiryDate: r.expiry_date != null ? fmtDate(r.expiry_date) : null, status: String(r.status),
    subtotal: Number(r.subtotal), taxAmount: Number(r.tax_amount),
    total: Number(r.total), notes: r.notes != null ? String(r.notes) : null, terms: r.terms != null ? String(r.terms) : null,
    convertedInvoiceId: r.converted_invoice_id != null ? String(r.converted_invoice_id) : null,
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

function mapLine(r: Row): QuoteLine {
  return {
    id: String(r.id), quoteId: String(r.quote_id), lineNumber: Number(r.sort_order),
    description: String(r.description), quantity: Number(r.quantity),
    unitPrice: Number(r.unit_price), taxRate: Number(r.tax_rate),
    lineTotal: Number(r.amount), accountId: r.gl_account_id != null ? String(r.gl_account_id) : null,
  };
}

/**
 * The quote number comes from the company's own `quotation` sequence.
 *
 * What it replaced read `SELECT quote_number FROM customer_quotes ORDER BY
 * created_at DESC LIMIT 1` with NO company_id filter, so company A's next quote
 * number was derived from whichever quote was created most recently ACROSS THE
 * PLATFORM. It leaked another tenant's numbering into this tenant's documents,
 * and it re-issued a number A had already used whenever the global newest
 * belonged to a tenant on a lower number — silently, because nothing enforced
 * uniqueness. Migration 666 adds `uq_customer_quotes_company_number`, which is
 * the constraint the retry below renumbers past.
 */
const QUOTE_NUMBER_CONSTRAINTS = [
  'uq_customer_quotes_company_number',
  // The name a parallel remediation branch (K-060) gives the same index.
  // Whichever migration reaches a database first is the one that raises.
  'uq_customer_quotes_company_quote_number',
];

/** Thrown for W1 line-validation failures — handlers map it to HTTP 400. */
export class LineValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LineValidationError';
  }
}

/**
 * W1 (P2.1): negative quantities/prices produced negative documents server-side
 * (the July-4 audit created a -R115 invoice live). Zero-quantity lines are
 * also meaningless on a quote. Throws before any SQL runs.
 */
export function assertValidLines(lines: QuoteInput['lines']): void {
  for (const l of lines || []) {
    if (!(Number(l.quantity) > 0)) {
      throw new LineValidationError(`Line "${l.description}": quantity must be positive`);
    }
    if (Number(l.unitPrice) < 0) {
      throw new LineValidationError(`Line "${l.description}": unit price cannot be negative`);
    }
  }
}

function calcTotals(lines: QuoteInput['lines']) {
  let subtotal = 0;
  let taxAmount = 0;
  for (const l of lines) {
    const lt = Math.round(l.quantity * l.unitPrice * 100) / 100;
    const lineTax = Math.round(lt * ((l.taxRate ?? 15) / 100) * 100) / 100;
    subtotal += lt;
    taxAmount += lineTax;
  }
  return { subtotal: Math.round(subtotal * 100) / 100, taxAmount: Math.round(taxAmount * 100) / 100, total: Math.round((subtotal + taxAmount) * 100) / 100 };
}

export async function getQuotes(companyId: string, filters?: QuoteFilters): Promise<{ quotes: Quote[]; total: number }> {
  const limit = filters?.limit || 50;
  const offset = filters?.offset || 0;
  let rows: Row[];
  let countRows: Row[];

  if (filters?.search) {
    const pattern = `%${filters.search}%`;
    rows = (await sql`
      SELECT * FROM customer_quotes
      WHERE company_id = ${companyId}
        AND (quote_number ILIKE ${pattern} OR customer_name ILIKE ${pattern})
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`
      SELECT COUNT(*) AS cnt FROM customer_quotes
      WHERE company_id = ${companyId}
        AND (quote_number ILIKE ${pattern} OR customer_name ILIKE ${pattern})
    `) as Row[];
  } else if (filters?.status) {
    rows = (await sql`
      SELECT * FROM customer_quotes WHERE company_id = ${companyId} AND status = ${filters.status}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`
      SELECT COUNT(*) AS cnt FROM customer_quotes WHERE company_id = ${companyId} AND status = ${filters.status}
    `) as Row[];
  } else {
    rows = (await sql`
      SELECT * FROM customer_quotes WHERE company_id = ${companyId} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`SELECT COUNT(*) AS cnt FROM customer_quotes WHERE company_id = ${companyId}`) as Row[];
  }
  return { quotes: rows.map(mapQuote), total: Number(countRows[0]?.cnt || 0) };
}

export async function getQuote(companyId: string, id: string): Promise<Quote | null> {
  const rows = companyId
    ? (await sql`SELECT * FROM customer_quotes WHERE id = ${id}::UUID AND company_id = ${companyId}`) as Row[]
    : (await sql`SELECT * FROM customer_quotes WHERE id = ${id}::UUID`) as Row[];
  if (rows.length === 0) return null;
  const quote = mapQuote(rows[0]!);
  const lineRows = (await sql`
    SELECT * FROM customer_quote_lines WHERE quote_id = ${id}::UUID ORDER BY sort_order
  `) as Row[];
  quote.lines = lineRows.map(mapLine);
  return quote;
}

export async function createQuote(companyId: string, input: QuoteInput, userId?: string): Promise<Quote> {
  // R-067: before insertWithReservedNumber, which writes the company's counter.
  // convertToInvoice copies this client_id onto the invoice verbatim.
  await assertCustomerInCompany(companyId, input.clientId);
  assertValidLines(input.lines);
  const { subtotal, taxAmount, total } = calcTotals(input.lines);
  const qd = input.quoteDate || fmtDate(new Date()); // local date — toISOString rolls back a day before 02:00 SAST

  // Header AND lines inside the savepointed attempt: a 23505 on the number must
  // take the lines with the header, or the retry leaves orphaned lines behind.
  const { id, quoteNumber } = await insertWithReservedNumber(
    companyId, 'quotation', 'quote_insert_', QUOTE_NUMBER_CONSTRAINTS,
    async (number) => {
      const rows = (await sql`
        INSERT INTO customer_quotes (company_id, quote_number, client_id, customer_name, quote_date, expiry_date,
          subtotal, tax_amount, total, notes, terms, created_by)
        VALUES (${companyId}, ${number}, ${input.clientId || null}, ${input.customerName}, ${qd},
          ${input.expiryDate || null}, ${subtotal}, ${taxAmount}, ${total},
          ${input.notes || null}, ${input.terms || null}, ${userId || null})
        RETURNING id
      `) as Row[];
      const quoteId = String(rows[0]!.id);
      for (let i = 0; i < input.lines.length; i++) {
        const l = input.lines[i];
        if (!l) continue;
        const amount = Math.round(l.quantity * l.unitPrice * 100) / 100;
        await sql`
          INSERT INTO customer_quote_lines (quote_id, sort_order, description, quantity, unit_price, tax_rate, amount, gl_account_id)
          VALUES (${quoteId}::UUID, ${i + 1}, ${l.description}, ${l.quantity}, ${l.unitPrice}, ${l.taxRate ?? 15}, ${amount}, ${l.accountId || null})
        `;
      }
      return { id: quoteId, quoteNumber: number };
    },
  );
  log.info('Quote created', { quoteNumber, total });
  return (await getQuote(companyId, id))!;
}

export async function updateQuote(companyId: string, id: string, input: QuoteInput): Promise<Quote | null> {
  const existing = await getQuote(companyId, id);
  if (!existing || existing.status !== 'draft') return null;
  await assertCustomerInCompany(companyId, input.clientId);
  assertValidLines(input.lines);
  const { subtotal, taxAmount, total } = calcTotals(input.lines);

  await sql`
    UPDATE customer_quotes SET customer_name = ${input.customerName}, client_id = ${input.clientId || null},
      quote_date = ${input.quoteDate || existing.quoteDate}, expiry_date = ${input.expiryDate || null},
      subtotal = ${subtotal}, tax_amount = ${taxAmount}, total = ${total},
      notes = ${input.notes || null}, terms = ${input.terms || null}, updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = 'draft'
  `;
  // Parent-verified: getQuote(companyId, id) at the top of this function early-returns null for cross-tenant ids, so this quote_id is tenant-owned.
  await sql`DELETE FROM customer_quote_lines WHERE quote_id = ${id}::UUID`;
  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i];
    if (!l) continue;
    const amount = Math.round(l.quantity * l.unitPrice * 100) / 100;
    await sql`
      INSERT INTO customer_quote_lines (quote_id, sort_order, description, quantity, unit_price, tax_rate, amount, gl_account_id)
      VALUES (${id}::UUID, ${i + 1}, ${l.description}, ${l.quantity}, ${l.unitPrice}, ${l.taxRate ?? 15}, ${amount}, ${l.accountId || null})
    `;
  }
  log.info('Quote updated', { id });
  return getQuote(companyId, id);
}

export async function deleteQuote(companyId: string, id: string): Promise<boolean> {
  const rows = (await sql`DELETE FROM customer_quotes WHERE id = ${id}::UUID AND company_id = ${companyId} AND status = 'draft' RETURNING id`) as Row[];
  return rows.length > 0;
}

export async function updateQuoteStatus(companyId: string, id: string, status: string): Promise<Quote | null> {
  const result = (await sql`UPDATE customer_quotes SET status = ${status}, updated_at = NOW() WHERE id = ${id}::UUID AND company_id = ${companyId} RETURNING id`) as Row[];
  if (result.length === 0) throw new Error(`Quote not found: ${id}`);
  log.info('Quote status changed', { id, status });
  return getQuote(companyId, id);
}

// Convert operations split to quoteConvertService.ts — re-exported for backward compat
export { convertToSalesOrder, convertToInvoice } from './quoteConvertService';

