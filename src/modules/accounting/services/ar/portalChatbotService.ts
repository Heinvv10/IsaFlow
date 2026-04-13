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

const INTERNAL_PATTERNS = [
  /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN)\b[^.!?]*/gi,
  /\b(customer_invoices|supplier_invoices|gl_accounts|bank_transactions|payslips|employees)\b/gi,
  /\btable\s+\w+/gi,
  /\bcolumn\s+\w+/gi,
  /\bquery\b/gi,
];

export function sanitizeClientResponse(text: string): string {
  let clean = text;
  for (const pattern of INTERNAL_PATTERNS) {
    clean = clean.replace(pattern, '').replace(/\s{2,}/g, ' ').trim();
  }
  return clean || text;
}
