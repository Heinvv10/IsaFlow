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
  /** An exact day ("as at 15 October"): honoured for positions, refused for everything else, never rounded to a month end. */
  | { kind: 'day'; day: number; month: number; year: number | null }
  | { kind: 'unsupported'; said: string };

/** A narrower figure of the same intent: gross/operating profit, cost of sales. Answered as that figure, labelled as it, never as the plain one. */
export type AskQualifier = 'gross' | 'operating' | 'cost_of_sales';

export interface AskIntent { id: AskIntentId; period: AskPeriod | null; qualifier?: AskQualifier }

export type ParsedQuestion =
  | { kind: 'intent'; intent: AskIntent }
  /** Two or more figures asked for (different intents, or a plain and a narrower figure of one): `examples` are the questions to choose from. */
  | { kind: 'ambiguous'; ids: AskIntentId[]; examples: string[] }
  /** One intent, but several windows ("this year vs last year"): one period at a time, `examples` one per window. */
  | { kind: 'periods'; id: AskIntentId; examples: string[] }
  /** A recognised refinement we cannot honour (an amount filter, a comparison, before/after tax): said, never answered with a broader figure. */
  | { kind: 'unsupported'; id: AskIntentId; said: string }
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
  ['emp201', /\b(emp\s?201|paye|sdl|uif)\b|\bsars\b.*\bpayroll\b|\bpayroll\b.*\bsars\b|\bpayroll\s+liabilit/],
  ['vat', /\bvat\b/],
  ['last_pay_run', /\b(last|latest|recent)\b.*\b(pay\s*run|payroll)\b|\bpay\s*run\b.*\bcost\b|\bpayroll\b.*\b(cost|total)\b/],
  ['profit', /\b(net\s+)?(profit|loss)\b|\bnet\s+income\b|\bincome\b(?!\s+tax)/],
  ['revenue', /\b(revenue|sales|turnover)\b/],
  ['expenses', /\b(expenses?|costs?|costofsales|spent|spending)\b|\b(did|do|have)\s+(i|we)\s+spend\b/],
];

/** Plain P&L words, and "liabilities" ("VAT liability" is a tax question): they lose to any more specific intent that also matched. */
const GENERIC: ReadonlySet<AskIntentId> = new Set<AskIntentId>(['profit', 'revenue', 'expenses', 'liabilities']);

const normalise = (question: string): string =>
  question.toLowerCase().replace(/\bcost\s+of\s+sales\b/g, 'costofsales').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

const QUARTER = /\b(q[1-4]|(?:first|second|third|fourth|1st|2nd|3rd|4th)\s+quarter|h[12]|half\s*year(?:ly)?|quarter(?:ly)?)\b/;
/** A number is a year only with year context, and never after a comparison word ("more than 2000" is an amount). */
const NOT_A_YEAR_AFTER = new Set(['than', 'over', 'under', 'above', 'below', 'exceeding', 'exceeds', 'least', 'most', 'about', 'around', 'rand', 'r']);
const YEAR_CONTEXT = new Set(['in', 'for', 'during', 'fy', 'year', 'of', 'since']);
const MONTH_RE = MONTHS.filter((m) => m !== 'may').join('|');
const ORD = '(?:st|nd|rd|th)?';

function bareYear(q: string): string | null {
  const words = q.split(' ');
  for (let i = 0; i < words.length; i += 1) {
    if (!/^(?:19|20)\d{2}$/.test(words[i]!)) continue;
    const prev = words[i - 1] ?? '';
    if (NOT_A_YEAR_AFTER.has(prev)) continue;
    if (YEAR_CONTEXT.has(prev) || i === words.length - 1) return words[i]!;
  }
  return null;
}

const validDay = (d: number, m: number, y: number | null): boolean => d >= 1 && m >= 1 && m <= 12 && d <= new Date(Date.UTC(y ?? 2024, m, 0)).getUTCDate();

/** An exact day: "15 october [2026]", "october 15th", "2026 10 15" (an ISO date once its dashes are gone). */
function dayIn(q: string): AskPeriod | null {
  const dm = new RegExp(`\\b(\\d{1,2})${ORD}\\s+(?:of\\s+)?(${MONTHS.join('|')})(?:\\s+(20\\d{2}))?\\b`).exec(q);
  if (dm) {
    const day = Number(dm[1]); const month = MONTHS.indexOf(dm[2]!) + 1; const year = dm[3] ? Number(dm[3]) : null;
    return validDay(day, month, year) ? { kind: 'day', day, month, year } : { kind: 'unsupported', said: dm[0]! };
  }
  const md = new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2})${ORD}(?:\\s+(20\\d{2}))?\\b`).exec(q);
  if (md) {
    const day = Number(md[2]); const month = MONTHS.indexOf(md[1]!) + 1; const year = md[3] ? Number(md[3]) : null;
    return validDay(day, month, year) ? { kind: 'day', day, month, year } : { kind: 'unsupported', said: md[0]! };
  }
  const iso = /\b(20\d{2}) (\d{1,2}) (\d{1,2})\b/.exec(q);
  if (iso && validDay(Number(iso[3]), Number(iso[2]), Number(iso[1]))) return { kind: 'day', day: Number(iso[3]), month: Number(iso[2]), year: Number(iso[1]) };
  return null;
}

/** The window named, or null when none was. A window we recognise but cannot honour is `unsupported`, never dropped. */
export function parsePeriod(raw: string): AskPeriod | null {
  const q = normalise(raw);
  const quarter = QUARTER.exec(q);
  if (quarter) return { kind: 'unsupported', said: quarter[1]! };
  const day = dayIn(q);
  if (day) return day;
  if (/\blast\s+month\b/.test(q)) return { kind: 'last_month' };
  if (/\bthis\s+month\b/.test(q)) return { kind: 'this_month' };
  if (/\b(last|previous|prior)\s+(financial\s+|fiscal\s+)?year\b/.test(q)) return { kind: 'last_year' };
  if (/\b(this|current)\s+(financial\s+|fiscal\s+)?year\b|\byear\s+to\s+date\b|\bytd\b/.test(q)) return { kind: 'this_year' };
  const named = new RegExp(`\\b(${MONTH_RE})(?:\\s+(20\\d{2}))?\\b`).exec(q)
    ?? /\b(?:(?:for|in|of|during|since)\s+(may)(?:\s+(20\d{2}))?|(may)\s+(20\d{2}))\b/.exec(q);
  if (named) {
    const m = named[1] ?? named[3];
    const y = named[2] ?? named[4];
    if (m) return { kind: 'month', month: MONTHS.indexOf(m) + 1, year: y ? Number(y) : null };
  }
  const other = /\b(week|today|yesterday|tomorrow)\b/.exec(q);
  if (other?.[1]) return { kind: 'unsupported', said: other[1] };
  const year = bareYear(q);
  return year ? { kind: 'unsupported', said: year } : null;
}

/** Every distinct window a question names, as the words to put after a stem. Two or more is "one period at a time". */
function windowPhrases(q: string): string[] {
  const found = new Set<string>();
  for (const [re, phrase] of [[/\blast\s+month\b/, 'last month'], [/\bthis\s+month\b/, 'this month'],
    [/\b(last|previous|prior)\s+(financial\s+|fiscal\s+)?year\b/, 'last year'],
    [/\b(this|current)\s+(financial\s+|fiscal\s+)?year\b|\byear\s+to\s+date\b|\bytd\b/, 'this year']] as const) {
    if (re.test(q)) found.add(phrase);
  }
  const months = new RegExp(`\\b(${MONTH_RE})(?:\\s+(20\\d{2}))?\\b|\\b(?:for|in|of|during|since)\\s+(may)(?:\\s+(20\\d{2}))?\\b|\\b(may)\\s+(20\\d{2})\\b`, 'g');
  for (const m of q.matchAll(months)) {
    const name = m[1] ?? m[3] ?? m[5];
    const year = m[2] ?? m[4] ?? m[6];
    if (name) found.add(`${name[0]!.toUpperCase()}${name.slice(1)}${year ? ` ${year}` : ''}`);
  }
  return [...found];
}

const STEMS: Readonly<Record<AskIntentId, string>> = {
  owed_to_me: 'Who owes me money', i_owe: 'Who do I owe', cash: 'How much cash is in the bank', profit: 'What is my profit',
  revenue: 'What is my revenue', expenses: 'What are my expenses', assets: 'What are my total assets', liabilities: 'What are my total liabilities',
  vat: 'What VAT do I owe', emp201: 'What do I owe SARS for payroll', last_pay_run: 'What did payroll cost', bank_to_allocate: 'How many bank transactions need allocating',
};

/** One intent with its refinement, as the question that asks exactly that. */
interface Key { id: AskIntentId; qualifier?: AskQualifier }
const keyName = (k: Key): string => `${k.id}:${k.qualifier ?? ''}`;
function exampleForKey(k: Key): string {
  if (k.id === 'profit' && k.qualifier === 'gross') return 'What is my gross profit this month?';
  if (k.id === 'profit' && k.qualifier === 'operating') return 'What is my operating profit this month?';
  if (k.id === 'expenses' && k.qualifier === 'cost_of_sales') return 'What is my cost of sales this month?';
  return exampleFor(k.id);
}

function qualifierOf(q: string, id: AskIntentId): AskQualifier | undefined {
  if (id === 'profit' && /\bgross\s+(profit|margin)\b/.test(q)) return 'gross';
  if (id === 'profit' && /\boperating\s+(profit|income)\b/.test(q)) return 'operating';
  if (id === 'expenses' && /\bcostofsales\b/.test(q)) return 'cost_of_sales';
  return undefined;
}

/** The intents one clause asks for: every pattern that matched, the plain words stepping aside for a specific one. */
function keysOf(clause: string): Key[] {
  const hits = PATTERNS.filter(([, re]) => re.test(clause)).map(([id]) => id);
  const specific = hits.filter((id) => !GENERIC.has(id));
  return (specific.length > 0 ? specific : hits).map((id) => ({ id, qualifier: qualifierOf(clause, id) }));
}

/** Clauses joined by and / & / , / plus / vs: each may ask for something different, and silently answering one drops the other. */
const JOINERS = /[,;&]|\b(?:and|plus|vs\.?|versus)\b|\bas\s+well\s+as\b/;

const AMOUNT_FILTER = /\b(?:more than|less than|greater than|fewer than|over|under|above|below|exceeding|at least|at most)\s+(?:r\s?)?\d/;
const COMPARISON = /\b(?:vs|versus|compared\s+(?:to|with)|compare|comparison|against)\b/;
const TAX_BASIS = /\b(?:before|after|pre|post)\s+tax\b|\b(?:excluding|including|incl|excl|ex)\s+vat\b/;

export function parseQuestion(question: string): ParsedQuestion {
  const q = normalise(question);
  if (q.length < 3) return { kind: 'none' };
  // The whole question first (a comma inside a clause must not split "cash, roughly, in the bank"), then each clause: a question
  // joining clauses that ask for different things is ambiguous, and clauses that match nothing are ignored.
  const found = new Map<string, Key>();
  for (const k of [...keysOf(q), ...question.toLowerCase().split(JOINERS).flatMap((c) => keysOf(normalise(c)))]) found.set(keyName(k), k);
  const keys = [...found.values()];
  if (keys.length === 0) return { kind: 'none' };
  if (keys.length > 1) return { kind: 'ambiguous', ids: [...new Set(keys.map((k) => k.id))], examples: keys.map(exampleForKey) };
  const { id, qualifier } = keys[0]!;
  if (AMOUNT_FILTER.test(q)) return { kind: 'unsupported', id, said: 'amount filters ("more than R2 000")' };
  if (TAX_BASIS.test(q)) return { kind: 'unsupported', id, said: 'figures before or after tax' };
  const windows = windowPhrases(q);
  if (windows.length > 1) return { kind: 'periods', id, examples: windows.map((w) => `${STEMS[id]} ${w}?`) };
  if (COMPARISON.test(q)) return { kind: 'unsupported', id, said: 'comparisons' };
  return { kind: 'intent', intent: { id, period: parsePeriod(q), qualifier } };
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
