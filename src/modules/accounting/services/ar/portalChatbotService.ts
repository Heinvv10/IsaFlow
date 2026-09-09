/**
 * AI Client Portal Chatbot Service
 * Query classification, prompt building, response parsing, sanitization.
 * Pure business logic — no database dependencies.
 */

export type ClientQueryType = 'balance' | 'invoices' | 'payments' | 'statement' | 'tax' | 'general';

export interface ClientContext {
  clientName: string;
  outstandingBalance: number;
  overdueAmount: number;
  lastPaymentDate: string;
  lastPaymentAmount: number;
  openInvoices: number;
  companyName: string;
}

export interface ChatResponse {
  message: string;
  action: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// QUERY CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════

const QUERY_PATTERNS: Array<{ type: ClientQueryType; patterns: RegExp[] }> = [
  { type: 'balance', patterns: [/\bbalance\b/i, /\bowe\b/i, /\boutstanding\b/i, /how much/i] },
  { type: 'invoices', patterns: [/\binvoice/i, /\bbill/i, /\bstatement of account/i] },
  { type: 'payments', patterns: [/\bpayment/i, /\bpaid\b/i, /\breceipt/i, /\btransaction/i] },
  { type: 'statement', patterns: [/\bstatement\b/i, /\baccount.*summary/i] },
  { type: 'tax', patterns: [/\bvat\b/i, /\btax\b/i, /\bsars\b/i] },
];

export function classifyClientQuery(question: string): ClientQueryType {
  for (const { type, patterns } of QUERY_PATTERNS) {
    if (patterns.some(p => p.test(question))) return type;
  }
  return 'general';
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTEXT
// ═══════════════════════════════════════════════════════════════════════════

const fmt = (n: number) => `R${Math.abs(n).toLocaleString('en-ZA', { minimumFractionDigits: 0 })}`;

export function buildClientContext(ctx: ClientContext): string {
  return [
    `Client: ${ctx.clientName}`,
    `Outstanding balance: ${fmt(ctx.outstandingBalance)}`,
    ctx.overdueAmount > 0 ? `Overdue: ${fmt(ctx.overdueAmount)}` : 'No overdue amounts',
    `${ctx.openInvoices} open invoice${ctx.openInvoices !== 1 ? 's' : ''}`,
    ctx.lastPaymentDate ? `Last payment: ${fmt(ctx.lastPaymentAmount)} on ${ctx.lastPaymentDate}` : 'No recent payments',
    `Company: ${ctx.companyName}`,
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// PROMPT
// ═══════════════════════════════════════════════════════════════════════════

export function buildClientChatPrompt(question: string, ctx: ClientContext): string {
  return `You are a friendly AI assistant for ${ctx.companyName}'s client portal. You are helping ${ctx.clientName}.

Client Account Summary:
${buildClientContext(ctx)}

Client Question: ${question}

Respond in JSON: {"message": "Your friendly response in plain language", "action": null}
Available actions: "download_statement", "view_invoices", "make_payment", null
Rules:
- Be polite and professional
- Use ZAR (R) for amounts
- Never expose internal system details, SQL, or table names
- If you can't answer, suggest contacting the accountant`;
}

// ═══════════════════════════════════════════════════════════════════════════
// RESPONSE PARSING
// ═══════════════════════════════════════════════════════════════════════════

export function parseClientChatResponse(response: string): ChatResponse | null {
  if (!response || response.trim() === '') return null;

  try {
    const match = response.match(/\{[\s\S]*"message"[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return { message: String(parsed.message || ''), action: parsed.action || null };
    }
  } catch { /* not JSON */ }

  // Plain text fallback
  return { message: response.trim(), action: null };
}

// ═══════════════════════════════════════════════════════════════════════════
// SANITIZATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Replaces a reply that could not be made safe. Never return the raw text on
 * failure: the case where stripping empties the string is exactly the case
 * where the whole reply was internal SQL, and this output is customer-facing.
 */
export const SANITIZED_FALLBACK =
  "I'm sorry — I can't answer that here. Please contact your accountant for help with this query.";

/** Zero-width characters can be wedged inside a keyword to slip it past \b. */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

/**
 * A sentence matching any of these is dropped whole, never edited in place.
 * Partial stripping is what leaked fragments verbatim — a column list longer
 * than the bound, a quoted identifier, or a bare `WHERE company_id = '...'`
 * survived the edit with the tenant id intact.
 *
 * The SELECT rules deliberately do NOT match case-insensitive prose: "Please
 * select the invoice from the list below" is the most likely sentence on an
 * invoice portal, so a lower-case select/from pair must also carry SQL
 * structure (a star, a semicolon, or a following clause keyword) to count.
 */
const SQL_SENTENCE_PATTERNS: RegExp[] = [
  // Statement keywords in caps — how a leaked query is actually written.
  /\bSELECT\b[\s\S]{0,2000}?\bFROM\b/,
  /\bINSERT\s+INTO\b/,
  /\bUPDATE\b[\s\S]{0,200}?\bSET\b/,
  /\bDELETE\s+FROM\b/,
  /\bGROUP\s+BY\b|\bORDER\s+BY\b/,
  /\bJOIN\b[\s\S]{0,200}?\bON\b/,
  // Lower-case select ... from, but only with SQL structure alongside.
  /\bselect\b\s*\*/i,
  /\bselect\b[\s\S]{0,2000}?\bfrom\b[\s\S]{0,400}?(?:\bwhere\b|\bjoin\b|\bgroup\s+by\b|\border\s+by\b|\blimit\b|[*;])/i,
  // Predicates and internal identifiers, which leak tenant ids on their own.
  /\bwhere\b[\s\S]{0,200}?[a-z_]+\s*=\s*(?:['"$]|\d)/i,
  /\b\w+\s*\.\s*\w+\s*=\s*['"$]/,
  /\b(?:customer_invoices|supplier_invoices|customer_invoice_disputes|gl_accounts|gl_journal_entries|gl_journal_lines|bank_transactions|dunning_sends|credit_notes|captured_documents)\b/i,
  /\b(?:company_id|customer_id|client_id|invoice_id|supplier_id|deleted_at|amount_paid|total_amount|portal_token|created_by)\b/i,
];

function isInternal(sentence: string): boolean {
  return SQL_SENTENCE_PATTERNS.some(p => p.test(sentence));
}

/**
 * Drop every sentence that looks like internal SQL or schema, keep the rest.
 * Fails CLOSED: if nothing survives, the customer gets SANITIZED_FALLBACK,
 * never the original text.
 */
export function sanitizeClientResponse(text: string): string {
  const normalized = text.replace(ZERO_WIDTH, '');
  const kept = normalized
    .split(/(?<=[.!?])(?=\s)/)
    .filter(sentence => !isInternal(sentence))
    .join('')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return kept || SANITIZED_FALLBACK;
}
