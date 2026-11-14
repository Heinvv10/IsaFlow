/**
 * Which words of a question the parser accounts for (wave 5 M11). After an intent, a qualifier and a window are read, every
 * remaining content word is a refinement we did not understand ("profit by customer", "revenue from acme", "top 5 customers").
 * Answering with the plain figure would silently drop it, so the parser refuses instead and offers the plain question.
 *
 * The list is the vocabulary of the patterns in askIntents.ts plus a small fixed set of filler words. A word added to a pattern
 * must be added here too; the collision table in tests/unit/services/ask fails when a phrase that should answer is refused.
 */

const FILLER = ['what', 'whats', 'is', 'are', 'was', 'were', 'my', 'our', 'mine', 'i', 'we', 'me', 'us', 'you', 'your', 'the', 'a', 'an', 'for', 'in', 'of', 'on', 'at', 'as',
  'to', 'do', 'does', 'did', 'can', 'could', 'how', 'much', 'many', 'please', 'show', 'tell', 'give', 'list', 'it', 'its', 'there', 'been', 'be', 'have', 'has', 'had',
  'any', 'all', 'still', 'yet', 'need', 'needs', 'so', 'far', 'right', 'just', 'kindly', 'roughly', 'approximately', 'about', 'around', 'which', 'when', 'who', 'whom', 'with',
  'and', 'or', 'plus', 'vs', 'versus', 'than', 'due', 'now', 'currently', 'total', 'totals', 'number', 'count', 'get', 'got', 'pay', 'paid', 'owed', 'amount', 'figure', 'overall', 'company', 'business', 'thanks', 'thank', 'moment', 'return', 'sheet', 'statement', 'account', 'accounts',
  'am', 'make', 'made', 'making', 'earn', 'earned', 'earning', 'earnings', 'see', 'look', 'check', 'also', 'really', 'actually',
  'doing', 'done', 'being', 'little', 'bit', 'quick', 'quickly', 'vendor', 'vendors', 'looking', 'looks'];

const INTENT_WORDS = ['owe', 'owes', 'owing', 'money', 'cash', 'bank', 'banks', 'balance', 'balances', 'hand', 'position', 'debtor', 'debtors', 'receivable', 'receivables',
  'customer', 'customers', 'outstanding', 'creditor', 'creditors', 'payable', 'payables', 'supplier', 'suppliers', 'transaction', 'transactions', 'line', 'lines', 'code',
  'coded', 'coding', 'waiting', 'needing', 'uncategorised', 'uncoded', 'unallocated', 'unmatched', 'asset', 'assets', 'vat', 'emp', '201', 'emp201', 'paye', 'sdl', 'uif', 'sars', 'payroll', 'run', 'runs', 'cost', 'costs', 'costofsales',
  'expense', 'expenses', 'spend', 'spending', 'spent', 'profit', 'loss', 'net', 'gross', 'operating', 'income', 'revenue', 'sales', 'turnover', 'purchases', 'purchase',
  'input', 'output', 'latest', 'last', 'recent', 'margin'];

/** Phrases whose preposition belongs to the question ("outstanding from customers"), removed before the scan. */
/**
 * Window phrases the parser reads (askIntents parsePeriod): only inside these do "year", "month", "financial", "period" and "date"
 * carry no leftover. Alone ("year end", "for the period", "last period") they are refinements we do not understand.
 */
const WINDOW_PHRASES = /\bthe\s+end\s+of\s+(?:this|last|previous|prior)\s+(?:financial\s+|fiscal\s+)?(?:year|month)\b|\b(?:this|last|previous|prior|current)\s+(?:financial\s+|fiscal\s+)?(?:year|month)\b|\b(?:year|month)\s+to\s+date\b|\b(?:financial|fiscal)\s+year\s+(?:19|20)\d{2}\b|\b(?:19|20)\d{2}\s+(?:financial|fiscal)\s+year\b/g;
const CURRENT_PERIOD = /\b(?:this|current)\s+period\b/g;
/** Negation is meaning, never filler. Its one real use: bank lines that have not been allocated. */
const NOT_ALLOCATED = /\b(?:(?:have|has|had|are|is|were|was)\s+)?not\s+(?:yet\s+)?(?:been\s+)?(?:allocated|categorised|coded|matched)\b/g;

const PHRASES = /\b(?:outstanding|owed|owing)\s+(?:from|by)\s+(?:customers?|debtors?)\b|\b(?:owe|owed|owing|outstanding|payable)\s+(?:to|from)\s+(?:suppliers?|creditors?|vendors?)\b/g;

const INTENT_STEMS = [/^allocat/, /^categoris/, /^match/, /^liabilit/];

const PERIOD_WORDS = ['this', 'previous', 'prior', 'current', 'ytd', 'mtd', 'fy',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export const FILLER_WORDS: readonly string[] = FILLER;

const KNOWN = new Set<string>([...FILLER, ...INTENT_WORDS, ...PERIOD_WORDS]);

/** Whether a word is one the parser accounts for. */
export const isKnownWord = (w: string): boolean => KNOWN.has(w) || WINDOW_TOKEN.test(w) || INTENT_STEMS.some((re) => re.test(w));

/** A year, or a financial year label (fy2026): part of a window. */
const WINDOW_TOKEN = /^(?:(?:19|20)\d{2}|fy(?:19|20)\d{2})$/;

/** The question with the windows the parser reads removed, so a bare "year" or "year end" that is left over can be named as such. */
export const withoutWindowPhrases = (normalised: string): string => normalised.replace(WINDOW_PHRASES, ' ').replace(/\bfy\s?(?:19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();

/** The words of an already-normalised question that no pattern or window accounts for (days of a date are removed by the caller). */
export function leftoverWords(normalised: string, vat = false): string[] {
  const out: string[] = [];
  let text = normalised.replace(PHRASES, ' ').replace(WINDOW_PHRASES, ' ').replace(NOT_ALLOCATED, ' ');
  if (vat) text = text.replace(CURRENT_PERIOD, ' '); // the current VAT period is the VAT intent's own window
  for (const w of text.split(' ')) {
    if (!w || KNOWN.has(w) || WINDOW_TOKEN.test(w) || INTENT_STEMS.some((re) => re.test(w))) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}
