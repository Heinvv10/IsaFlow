/**
 * "Ask IsaFlow" question parser (wave 5 M11). No model: fixed patterns. Pure and synchronous, so the palette can
 * tell a question it understands from one it does not before anything is sent. The answers live in askAnswer.ts.
 *
 * Routing is by agreement, never by pattern order: every intent whose pattern matches is collected, the generic P&L
 * words (profit, revenue, expenses) step aside when a more specific intent also matched ("VAT on my sales" is a VAT
 * question), and when two or more specific intents still match the parser says so and the caller asks which was meant.
 */

export type AskIntentId =
  | 'owed_to_me' | 'i_owe' | 'cash' | 'profit' | 'revenue' | 'expenses'
  | 'assets' | 'liabilities' | 'vat' | 'emp201' | 'last_pay_run' | 'bank_to_allocate';

/** The window a question named. `unsupported` is a window we recognise as a window but cannot honour. */
export type AskPeriod =
  | { kind: 'this_month' } | { kind: 'last_month' } | { kind: 'this_year' } | { kind: 'last_year' }
  | { kind: 'month'; year: number | null; month: number }
  | { kind: 'unsupported'; said: string };

export interface AskIntent { id: AskIntentId; period: AskPeriod | null }

export type ParsedQuestion =
  | { kind: 'intent'; intent: AskIntent }
  | { kind: 'ambiguous'; ids: AskIntentId[] }
  | { kind: 'none' };

export interface IntentDoc { id: AskIntentId; example: string }

/** One example per intent, in the words the patterns accept. The "not understood" and "which did you mean" replies suggest these. */
export const INTENT_EXAMPLES: readonly IntentDoc[] = [
  { id: 'owed_to_me', example: 'Who owes me money?' },
  { id: 'i_owe', example: 'Who do I owe?' },
  { id: 'cash', example: 'How much cash is in the bank?' },
  { id: 'profit', example: 'What is my profit this month?' },
  { id: 'revenue', example: 'What is my revenue this year?' },
  { id: 'expenses', example: 'What are my expenses last month?' },
  { id: 'assets', example: 'What are my total assets?' },
  { id: 'liabilities', example: 'What are my total liabilities?' },
  { id: 'vat', example: 'What VAT do I owe for October?' },
  { id: 'emp201', example: 'What do I owe SARS for payroll in October?' },
  { id: 'last_pay_run', example: 'What did the last pay run cost?' },
  { id: 'bank_to_allocate', example: 'How many bank transactions need allocating?' },
];

export const exampleFor = (id: AskIntentId): string => INTENT_EXAMPLES.find((i) => i.id === id)?.example ?? '';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const PATTERNS: ReadonlyArray<readonly [AskIntentId, RegExp]> = [
  ['owed_to_me', /\b(who|what)\b.*\b(owes?|owing)\s+(me|us)\b|\b(debtors?|receivables?)\b|\bcustomers?\b.*\b(owe|owing|outstanding)\b|\bowed\s+to\s+(me|us)\b/],
  ['i_owe', /\bwho\s+do\s+(i|we)\s+owe\b|\b(creditors?|payables?)\b|\bwhat\s+do\s+(i|we)\s+owe\s+(my\s+|our\s+)?suppliers?\b|\bsuppliers?\b.*\b(owed|outstanding)\b/],
  ['cash', /\b(cash|money)\b.*\b(bank|have|hand)\b|\bbank\s+balances?\b|\bcash\s+(balance|position)\b/],
  ['bank_to_allocate', /\bbank\b.*\b(transactions?|lines?)\b.*\b(allocat|categoris|code|match)|\b(unallocated|unmatched)\b.*\bbank\b/],
  ['assets', /\btotal\s+assets\b|\bwhat\s+(do|are)\s+(i|we|my|our)\b.*\bassets\b/],
  ['liabilities', /\bliabilit/],
  ['emp201', /\b(emp\s?201|paye|sdl|uif)\b|\bsars\b.*\bpayroll\b|\bpayroll\b.*\bsars\b/],
  ['vat', /\bvat\b/],
  ['last_pay_run', /\b(last|latest|recent)\b.*\b(pay\s*run|payroll)\b|\bpay\s*run\b.*\bcost\b|\bpayroll\b.*\b(cost|total)\b/],
  ['profit', /\b(net\s+)?(profit|loss)\b|\bnet\s+income\b|\bincome\b(?!\s+tax)/],
  ['revenue', /\b(revenue|sales|turnover)\b/],
  ['expenses', /\b(expenses?|costs?|spend(ing)?)\b/],
];

/** Plain P&L words: they lose to any more specific intent that also matched. */
const GENERIC: ReadonlySet<AskIntentId> = new Set<AskIntentId>(['profit', 'revenue', 'expenses']);

const normalise = (question: string): string => question.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

/** The window named, or null when none was. A window we recognise but cannot honour is `unsupported`, never dropped. */
export function parsePeriod(q: string): AskPeriod | null {
  if (/\blast\s+month\b/.test(q)) return { kind: 'last_month' };
  if (/\bthis\s+month\b/.test(q)) return { kind: 'this_month' };
  if (/\b(last|previous|prior)\s+(financial\s+|fiscal\s+)?year\b/.test(q)) return { kind: 'last_year' };
  if (/\b(this|current)\s+(financial\s+|fiscal\s+)?year\b|\byear\s+to\s+date\b|\bytd\b/.test(q)) return { kind: 'this_year' };
  const named = new RegExp(`\\b(${MONTHS.filter((m) => m !== 'may').join('|')})(?:\\s+(20\\d{2}))?\\b`).exec(q)
    ?? /\b(?:(?:for|in|of|during|since)\s+(may)(?:\s+(20\d{2}))?|(may)\s+(20\d{2}))\b/.exec(q);
  if (named) {
    const m = named[1] ?? named[3];
    const y = named[2] ?? named[4];
    if (m) return { kind: 'month', month: MONTHS.indexOf(m) + 1, year: y ? Number(y) : null };
  }
  const other = /\b(quarter|week|today|yesterday|tomorrow|(?:19|20)\d{2})\b/.exec(q);
  return other?.[1] ? { kind: 'unsupported', said: other[1] } : null;
}

export function parseQuestion(question: string): ParsedQuestion {
  const q = normalise(question);
  if (q.length < 3) return { kind: 'none' };
  const hits = PATTERNS.filter(([, re]) => re.test(q)).map(([id]) => id);
  const specific = hits.filter((id) => !GENERIC.has(id));
  const chosen = specific.length > 0 ? specific : hits;
  if (chosen.length === 0) return { kind: 'none' };
  if (chosen.length > 1) return { kind: 'ambiguous', ids: chosen };
  return { kind: 'intent', intent: { id: chosen[0]!, period: parsePeriod(q) } };
}

/**
 * The Flow operation an answer is charged as, matching the report its figure comes from (Hein, wave 5): the income statement
 * figures charge `report.pnl`, the balance sheet figures `report.bs`; everything else is free, as its page is.
 */
export function meteredOperation(id: AskIntentId): 'report.pnl' | 'report.bs' | null {
  if (id === 'profit' || id === 'revenue' || id === 'expenses') return 'report.pnl';
  if (id === 'assets' || id === 'liabilities') return 'report.bs';
  return null;
}
