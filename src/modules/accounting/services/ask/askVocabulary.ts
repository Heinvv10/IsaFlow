/**
 * Which words of a question the parser accounts for (wave 5 M11). After an intent, a qualifier and a window are read, every
 * remaining content word is a refinement we did not understand ("profit by customer", "revenue from acme", "top 5 customers").
 * Answering with the plain figure would silently drop it, so the parser refuses instead and offers the plain question.
 *
 * The list is the vocabulary of the patterns in askIntents.ts plus a small fixed set of filler words. A word added to a pattern
 * must be added here too; the collision table in tests/unit/services/ask fails when a phrase that should answer is refused.
 */

const FILLER = ['what', 'whats', 'is', 'are', 'was', 'were', 'my', 'our', 'mine', 'i', 'we', 'me', 'us', 'you', 'your', 'the', 'a', 'an', 'for', 'in', 'of', 'on', 'at', 'as',
  'to', 'do', 'does', 'did', 'can', 'could', 'would', 'how', 'much', 'many', 'please', 'show', 'tell', 'give', 'list', 'it', 'its', 'there', 'been', 'be', 'have', 'has', 'had',
  'any', 'all', 'still', 'yet', 'need', 'needs', 'so', 'far', 'right', 'just', 'kindly', 'roughly', 'approximately', 'about', 'around', 'which', 'when', 'who', 'whom', 'with',
  'and', 'or', 'plus', 'vs', 'versus', 'than', 'due', 'now', 'currently', 'total', 'totals', 'number', 'count', 'get', 'got', 'pay', 'paid', 'owed', 'amount', 'figure', 'overall', 'company', 'business', 'thanks', 'thank', 'moment', 'return', 'sheet', 'statement', 'account', 'accounts'];

const INTENT_WORDS = ['owe', 'owes', 'owing', 'money', 'cash', 'bank', 'banks', 'balance', 'balances', 'hand', 'position', 'debtor', 'debtors', 'receivable', 'receivables',
  'customer', 'customers', 'outstanding', 'creditor', 'creditors', 'payable', 'payables', 'supplier', 'suppliers', 'transaction', 'transactions', 'line', 'lines', 'code',
  'coded', 'unallocated', 'unmatched', 'asset', 'assets', 'vat', 'emp', '201', 'emp201', 'paye', 'sdl', 'uif', 'sars', 'payroll', 'run', 'runs', 'cost', 'costs', 'costofsales',
  'expense', 'expenses', 'spend', 'spending', 'spent', 'profit', 'loss', 'net', 'gross', 'operating', 'income', 'revenue', 'sales', 'turnover', 'purchases', 'purchase',
  'input', 'output', 'latest', 'last', 'recent', 'margin'];

const INTENT_STEMS = [/^allocat/, /^categoris/, /^match/, /^liabilit/];

const PERIOD_WORDS = ['month', 'months', 'year', 'years', 'this', 'previous', 'prior', 'current', 'financial', 'fiscal', 'ytd', 'date', 'fy',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export const FILLER_WORDS: readonly string[] = FILLER;

const KNOWN = new Set<string>([...FILLER, ...INTENT_WORDS, ...PERIOD_WORDS]);

/** Whether a word is one the parser accounts for. */
export const isKnownWord = (w: string): boolean => KNOWN.has(w) || WINDOW_TOKEN.test(w) || INTENT_STEMS.some((re) => re.test(w));

/** A year, or a financial year label (fy2026): part of a window. */
const WINDOW_TOKEN = /^(?:(?:19|20)\d{2}|fy(?:19|20)\d{2})$/;

/** The words of an already-normalised question that no pattern or window accounts for (days of a date are removed by the caller). */
export function leftoverWords(normalised: string): string[] {
  const out: string[] = [];
  for (const w of normalised.split(' ')) {
    if (!w || KNOWN.has(w) || WINDOW_TOKEN.test(w) || INTENT_STEMS.some((re) => re.test(w))) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}
