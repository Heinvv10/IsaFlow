/**
 * Customer Quote Service — Sage-parity quotes with convert-to-invoice
 * Convert operations split to quoteConvertService.ts
 */

import { sql, withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

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
    customerName: String(r.customer_name), quoteDate: String(r.quote_date),
    expiryDate: r.expiry_date != null ? String(r.expiry_date) : null, status: String(r.status),
    subtotal: Number(r.subtotal), taxAmount: Number(r.tax_amount),
    total: Number(r.total), notes: r.notes != null ? String(r.notes) : null, terms: r.terms != null ? String(r.terms) : null,
    convertedInvoiceId: r.converted_invoice_id != null ? String(r.converted_invoice_id) : null,
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

function mapLine(r: Row): QuoteLine {
  return {
    id: String(r.id), quoteId: String(r.quote_id), lineNumber: Number(r.line_number),
    description: String(r.description), quantity: Number(r.quantity),
    unitPrice: Number(r.unit_price), taxRate: Number(r.tax_rate),
    lineTotal: Number(r.line_total), accountId: r.account_id != null ? String(r.account_id) : null,
  };
}

async function nextQuoteNumber(): Promise<string> {
  const rows = (await sql`
    SELECT quote_number FROM customer_quotes ORDER BY created_at DESC LIMIT 1
  `) as Row[];
  if (rows.length === 0) return 'QUO-00001';
  const last = String(rows[0]!.quote_number);
  const num = parseInt(last.replace('QUO-', ''), 10) || 0;
  return `QUO-${String(num + 1).padStart(5, '0')}`;
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
    SELECT * FROM customer_quote_lines WHERE quote_id = ${id}::UUID ORDER BY line_number
  `) as Row[];
  quote.lines = lineRows.map(mapLine);
  return quote;
}

export async function createQuote(companyId: string, input: QuoteInput, userId?: string): Promise<Quote> {
  const quoteNumber = await nextQuoteNumber();
  const { subtotal, taxAmount, total } = calcTotals(input.lines);
  const qd = input.quoteDate || new Date().toISOString().split('T')[0];

  const rows = (await sql`
    INSERT INTO customer_quotes (company_id, quote_number, client_id, customer_name, quote_date, expiry_date,
      subtotal, tax_amount, total, notes, terms, created_by)
    VALUES (${companyId}, ${quoteNumber}, ${input.clientId || null}, ${input.customerName}, ${qd},
      ${input.expiryDate || null}, ${subtotal}, ${taxAmount}, ${total},
      ${input.notes || null}, ${input.terms || null}, ${userId || null})
    RETURNING *
  `) as Row[];

  const quote = mapQuote(rows[0]!);
  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i];
    if (!l) continue;
    const lineTotal = Math.round(l.quantity * l.unitPrice * 100) / 100;
    await sql`
      INSERT INTO customer_quote_lines (quote_id, line_number, description, quantity, unit_price, tax_rate, line_total, account_id)
      VALUES (${quote.id}::UUID, ${i + 1}, ${l.description}, ${l.quantity}, ${l.unitPrice}, ${l.taxRate ?? 15}, ${lineTotal}, ${l.accountId || null})
    `;
  }
  log.info('Quote created', { quoteNumber, total });
  return (await getQuote(companyId, quote.id))!;
}

export async function updateQuote(companyId: string, id: string, input: QuoteInput): Promise<Quote | null> {
  const existing = await getQuote(companyId, id);
  if (!existing || existing.status !== 'draft') return null;
  const { subtotal, taxAmount, total } = calcTotals(input.lines);

  await sql`
    UPDATE customer_quotes SET customer_name = ${input.customerName}, client_id = ${input.clientId || null},
      quote_date = ${input.quoteDate || existing.quoteDate}, expiry_date = ${input.expiryDate || null},
      subtotal = ${subtotal}, tax_amount = ${taxAmount}, total = ${total},
      notes = ${input.notes || null}, terms = ${input.terms || null}, updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = 'draft'
  `;
  await sql`DELETE FROM customer_quote_lines WHERE quote_id = ${id}::UUID`;
  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i];
    if (!l) continue;
    const lineTotal = Math.round(l.quantity * l.unitPrice * 100) / 100;
    await sql`
      INSERT INTO customer_quote_lines (quote_id, line_number, description, quantity, unit_price, tax_rate, line_total, account_id)
      VALUES (${id}::UUID, ${i + 1}, ${l.description}, ${l.quantity}, ${l.unitPrice}, ${l.taxRate ?? 15}, ${lineTotal}, ${l.accountId || null})
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

// Suppress unused import lint error — withTransaction used by quoteConvertService
void withTransaction;
