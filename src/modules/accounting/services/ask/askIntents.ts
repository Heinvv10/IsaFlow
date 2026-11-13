/**
 * "Ask IsaFlow" question parser (wave 5 M11). No model: fixed patterns. Pure and synchronous, so the palette can
 * tell a question it understands from one it does not before anything is sent. The answers live in askAnswer.ts.
 *
 * Routing is by agreement, never by pattern order: every intent whose pattern matches is collected, the generic P&L
 * words (profit, revenue, expenses) step aside when a more specific intent also matched ("VAT on my sales" is a VAT
 * question), and when two or more specific intents still match the parser says so and the caller asks which was meant.
 */

import { leftoverWords } from './askVocabulary';

export type AskIntentId =
  | 'owed_to_me' | 'i_owe' | 'cash' | 'profit' | 'revenue' | 'expenses'
  | 'assets' | 'liabilities' | 'vat' | 'emp201' | 'last_pay_run' | 'bank_to_allocate';

/** The window a question named. `unsupported` is a window we recognise as a window but cannot honour. */
export type AskPeriod =
  | { kind: 'this_month' } | { kind: 'last_month' } | { kind: 'this_year' } | { kind: 'last_year' }
  | { kind: 'month'; year: number | null; month: number }
  /** An exact day ("as at 15 October"): honoured for positions, refused for everything else, never rounded to a month end. */
  | { kind: 'day'; day: number; month: number; year: number | null }
  /** A financial year by its label ("FY2026", "financial year 2026"), read through the fiscal-year registry. */
  | { kind: 'fy'; year: number }
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
  /** One intent, but words the parser could not account for: refused rather than dropped, with the plain question offered. */
  | { kind: 'leftover'; id: AskIntentId; words: string[] }
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

export const PATTERNS: ReadonlyArray<readonly [AskIntentId, RegExp]> = [
  ['owed_to_me', /\b(who|what)\b.*\b(owes?|owing)\s+(me|us)\b|\b(debtors?|receivables?)\b|\bcustomers?\b.*\b(owe|owing|outstanding)\b|\bowed\s+to\s+(me|us)\b|\b(?:am|are)\s+(?:i|we)\s+owed\b|\boutstanding\b.*\b(?:customers?|debtors?)\b/],
  ['i_owe', /\bwho\s+do\s+(i|we)\s+owe\b|\b(creditors?|payables?)\b|\b(?:owe|owing)\b.*\b(?:suppliers?|creditors?|vendors?)\b|\bsuppliers?\b.*\b(owed|outstanding)\b|\boutstanding\b.*\b(?:suppliers?|creditors?|vendors?)\b|\b(?:how\s+much|what)\s+(?:do|did|are)\s+(?:i|we)\s+owe\b(?!.*\b(?:sars|vat|paye|sdl|uif|tax|payroll)\b)/],
  ['cash', /\b(cash|money)\b.*\b(bank|have|hand)\b|\bbank\s+balances?\b|\bbalances?\b.*\bbank\b|\b(?:account|statement)\s+balances?\b|\bcash\s+(balance|position)\b/],
  ['bank_to_allocate', /\bbank\b.*\b(transactions?|lines?)\b.*\b(allocat|categoris|cod(?:e|ed|ing)|match)|\b(transactions?|lines?)\b.*\bbank\b.*\b(allocat|categoris|cod(?:e|ed|ing)|match)|\b(unallocated|unmatched)\b.*\bbank\b/],
  ['assets', /\btotal\s+(?:balance\s+sheet\s+)?assets\b|\bwhat\s+(do|are)\s+(i|we|my|our)\b.*\bassets\b/],
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

const ABBREVIATED: Readonly<Record<string, string>> = { jan: 'january', feb: 'february', mar: 'march', apr: 'april', jun: 'june', jul: 'july', aug: 'august', sep: 'september', sept: 'september', oct: 'october', nov: 'november', dec: 'december' };

/** "what's" -> "what is", "didn't" -> "did not": the apostrophe must not leave a stray "s" or "t" behind. */
const expandContractions = (q: string): string => q.replace(/[\u2018\u2019]/g, "'")
  .replace(/\b(won)'t\b/g, 'will not').replace(/\b(can)'t\b/g, 'can not').replace(/n't\b/g, ' not')
  .replace(/'re\b/g, ' are').replace(/'ve\b/g, ' have').replace(/'m\b/g, ' am').replace(/'ll\b/g, ' will').replace(/'d\b/g, ' would').replace(/'s\b/g, ' is');

const normalise = (question: string): string =>
  expandContractions(question.toLowerCase()).replace(/\bcost\s+of\s+sales\b/g, 'costofsales').replace(/\b(jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b/g, (a) => ABBREVIATED[a]!).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

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

/** Numeric dates once their separators are gone: "2026 10 15" (ISO) and "15 10 2026" (day month year, as South Africa writes it). */
const ISO_RE = /\b(20\d{2}) (\d{1,2}) (\d{1,2})\b/g;
const DMY_RE = /\b(\d{1,2}) (\d{1,2}) (20\d{2})\b/g;

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
  const iso = new RegExp(ISO_RE.source).exec(q);
  if (iso) return validDay(Number(iso[3]), Number(iso[2]), Number(iso[1])) ? { kind: 'day', day: Number(iso[3]), month: Number(iso[2]), year: Number(iso[1]) } : { kind: 'unsupported', said: iso[0]! };
  const dmy = new RegExp(DMY_RE.source).exec(q);
  if (dmy) return validDay(Number(dmy[1]), Number(dmy[2]), Number(dmy[3])) ? { kind: 'day', day: Number(dmy[1]), month: Number(dmy[2]), year: Number(dmy[3]) } : { kind: 'unsupported', said: dmy[0]! };
  return null;
}

/** "fy2026", "fy 2026", "financial year 2026", "2026 financial year": a financial year by its label. */
const FY = /\bfy\s?((?:19|20)\d{2})\b|\b(?:financial|fiscal)\s+year\s+((?:19|20)\d{2})\b|\b((?:19|20)\d{2})\s+(?:financial|fiscal)\s+year\b/;

/** Window phrases we do not support: a duration, "past/next/since ...", a week or fortnight. Refused, never dropped for the default. */
const UNSUPPORTED_WINDOW = /\b(?:(?:last|past|next|previous)\s+\d+\s+(?:days?|weeks?|months?|years?)|\d+\s+(?:days?|weeks?|months?|years?)|past\s+(?:\w+\s+)?(?:days?|weeks?|months?|years?)|next\s+\w+|since\s+\w+(?:\s+20\d{2})?|fortnight|last\s+week|this\s+week)\b/;

/** The window named, or null when none was. A window we recognise but cannot honour is `unsupported`, never dropped. */
export function parsePeriod(raw: string): AskPeriod | null {
  const q = normalise(raw);
  const quarter = QUARTER.exec(q);
  if (quarter) return { kind: 'unsupported', said: quarter[1]! };
  const fy = FY.exec(q);
  if (fy) return { kind: 'fy', year: Number(fy[1] ?? fy[2] ?? fy[3]) };
  const day = dayIn(q);
  if (day) return day;
  const odd = UNSUPPORTED_WINDOW.exec(q);
  if (odd) return { kind: 'unsupported', said: odd[0]! };
  if (/\blast\s+month\b/.test(q)) return { kind: 'last_month' };
  if (/\bthis\s+month\b|\b(?:this|current)\s+period\b/.test(q)) return { kind: 'this_month' };
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
/** Every exact day in a question, with its month name ('15 october', 'october 15th'). */
const DAY_RE = new RegExp(`\\b(\\d{1,2})${ORD}\\s+(?:of\\s+)?(${MONTHS.join('|')})(?:\\s+(20\\d{2}))?\\b|\\b(${MONTHS.join('|')})\\s+(\\d{1,2})${ORD}(?:\\s+(20\\d{2}))?\\b`, 'g');

const MONTH_LABEL = MONTHS.map((m) => `${m[0]!.toUpperCase()}${m.slice(1)}`);

/** The question with every exact date (named, ISO, day-month-year) removed: their numbers are part of a window, not leftover words. */
const stripDates = (q: string): string => q.replace(DAY_RE, ' ').replace(ISO_RE, ' ').replace(DMY_RE, ' ').replace(/\s+/g, ' ').trim();

function windowPhrases(raw: string): string[] {
  const found = new Set<string>();
  let q = raw;
  // Exact days first, counted by the day itself, then removed so their month names are not counted again.
  for (const m of raw.matchAll(DAY_RE)) {
    const day = m[1] ?? m[5]; const name = m[2] ?? m[4]; const year = m[3] ?? m[6];
    found.add(`as at ${Number(day)} ${name![0]!.toUpperCase()}${name!.slice(1)}${year ? ` ${year}` : ''}`);
  }
  for (const [re, order] of [[ISO_RE, [3, 2, 1]], [DMY_RE, [1, 2, 3]]] as const) {
    for (const m of raw.matchAll(re)) {
      const [d, mo, y] = [Number(m[order[0]]), Number(m[order[1]]), Number(m[order[2]])];
      if (validDay(d, mo, y)) found.add(`as at ${d} ${MONTH_LABEL[mo - 1]} ${y}`);
    }
  }
  q = q.replace(DAY_RE, ' '); // numeric dates carry no month name, so the month scan below cannot see them
  const fy = FY.exec(q);
  if (fy) { found.add(`for FY${fy[1] ?? fy[2] ?? fy[3]}`); q = q.replace(FY, ' '); }
  for (const [re, phrase] of [[/\blast\s+month\b/, 'last month'], [/\bthis\s+month\b/, 'this month'],
    [/\b(last|previous|prior)\s+(financial\s+|fiscal\s+)?year\b/, 'last year'],
    [/\b(this|current)\s+(financial\s+|fiscal\s+)?year\b|\byear\s+to\s+date\b|\bytd\b/, 'this year']] as const) {
    if (re.test(q)) found.add(phrase);
  }
  const months = new RegExp(`\\b(${MONTH_RE})(?:\\s+(20\\d{2}))?\\b|\\b(?:for|in|of|during|since)\\s+(may)(?:\\s+(20\\d{2}))?\\b|\\b(may)\\s+(20\\d{2})\\b`, 'g');
  for (const m of q.matchAll(months)) {
    const name = m[1] ?? m[3] ?? m[5];
    const year = m[2] ?? m[4] ?? m[6];
    if (name) found.add(`in ${name[0]!.toUpperCase()}${name.slice(1)}${year ? ` ${year}` : ''}`);
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
const QUALIFIER_STEMS: Readonly<Record<AskQualifier, string>> = { gross: 'What is my gross profit', operating: 'What is my operating profit', cost_of_sales: 'What is my cost of sales' };
/** The question that asks exactly this figure, in the window the person named (or the intent's own example when they named none). */
function exampleForKey(k: Key, window: string | null): string {
  if (window) return `${k.qualifier ? QUALIFIER_STEMS[k.qualifier] : STEMS[k.id]} ${window}?`;
  if (k.qualifier) return `${QUALIFIER_STEMS[k.qualifier]} this month?`;
  return exampleFor(k.id);
}

function qualifierOf(q: string, id: AskIntentId): AskQualifier | undefined {
  if (id === 'profit' && /\bgross\s+(profit|margin)\b|\b(profit|margin)\s+gross\b/.test(q)) return 'gross';
  if (id === 'profit' && /\boperating\s+(profit|income)\b|\b(profit|income)\s+operating\b/.test(q)) return 'operating';
  if (id === 'expenses' && /\bcostofsales\b/.test(q)) return 'cost_of_sales';
  return undefined;
}

/** The intents one clause asks for: every pattern that matched, the plain words stepping aside for a specific one. */
function keysOf(clause: string): Key[] {
  const hits = PATTERNS.filter(([, re]) => re.test(clause)).map(([id]) => id);
  // "VAT payable" is a VAT question, not a supplier one: i_owe stands only on its own words.
  const own = hits.includes('vat') && hits.includes('i_owe') && !/\bwho\s+do\s+(i|we)\s+owe\b|\bsuppliers?\b|\bcreditors?\b/.test(clause) ? hits.filter((id) => id !== 'i_owe') : hits;
  const specific = own.filter((id) => !GENERIC.has(id));
  return (specific.length > 0 ? specific : own).map((id) => ({ id, qualifier: qualifierOf(clause, id) }));
}

/** Clauses joined by and / & / , / plus / vs: each may ask for something different, and silently answering one drops the other. */
const JOINERS = /[,;&]|\b(?:and|plus|vs\.?|versus)\b|\bas\s+well\s+as\b/;

const AMOUNT_FILTER = /\b(?:more than|less than|greater than|fewer than|over|under|above|below|exceeding|at least|at most)\s+(?:r\s?)?\d+\s*([a-z]*)/;
const DURATION_UNIT = /^(?:days?|weeks?|months?|years?)$/;
/** "over 90 days", "overdue", "buckets": a refinement by age, which the plain total does not honour. */
const AGING_BUCKET = /\b\d+\s+days?\b|\boverdue\b|\bbuckets?\b|\bolder\s+than\b/;
const COMPARISON = /\b(?:vs|versus|compared\s+(?:to|with)|compare|comparison|against)\b/;
const TAX_BASIS = /\b(?:before|after|pre|post|net\s+of|less|excluding|including|incl|excl|ex)\s+tax\b/;
/** "excluding VAT" modifies a figure; it is not a VAT question, so it is cut out before the intents are read. */
const VAT_BASIS = /\b(?:excluding|including|incl|excl|ex|net\s+of|before|after|less)\s+vat\b/g;

export function parseQuestion(question: string): ParsedQuestion {
  const full = normalise(question);
  const vatBasis = new RegExp(VAT_BASIS.source).test(full);
  const q = full.replace(VAT_BASIS, ' ').replace(/\s+/g, ' ').trim();
  if (q.length < 3) return { kind: 'none' };
  // The whole question first (a comma inside a clause must not split "cash, roughly, in the bank"), then each clause: a question
  // joining clauses that ask for different things is ambiguous, and clauses that match nothing are ignored.
  const found = new Map<string, Key>();
  for (const k of [...keysOf(q), ...question.toLowerCase().replace(/\b(?:excluding|including|incl|excl|ex|net\s+of|before|after|less)\s+vat\b/g, ' ').split(JOINERS).flatMap((c) => keysOf(normalise(c)))]) found.set(keyName(k), k);
  const keys = [...found.values()];
  if (keys.length === 0) return { kind: 'none' };
  if (keys.length > 1) return { kind: 'ambiguous', ids: [...new Set(keys.map((k) => k.id))], examples: keys.map((k) => exampleForKey(k, windowPhrases(q)[0] ?? null)) };
  const { id, qualifier } = keys[0]!;
  if ((id === 'owed_to_me' || id === 'i_owe') && AGING_BUCKET.test(q)) return { kind: 'unsupported', id, said: 'by aging bucket' };
  const amount = AMOUNT_FILTER.exec(q);
  if (amount && !DURATION_UNIT.test(amount[1] ?? '')) return { kind: 'unsupported', id, said: 'amount filters ("more than R2 000")' };
  if (vatBasis && (id === 'revenue' || id === 'expenses' || id === 'profit')) return { kind: 'unsupported', id, said: 'figures including or excluding VAT' };
  if (TAX_BASIS.test(q)) return { kind: 'unsupported', id, said: 'figures before or after tax' };
  const windows = windowPhrases(q);
  const statement = id === 'profit' || id === 'revenue' || id === 'expenses';
  // A statement covers a month or a financial year: a single day or a day range is not one, and "as at" is never offered for it.
  if (statement && windows.some((w) => w.startsWith('as at'))) return { kind: 'unsupported', id, said: 'a single day or a date range' };
  if (windows.length > 1) return { kind: 'periods', id, examples: windows.map((w) => `${STEMS[id]} ${w}?`) };
  if (COMPARISON.test(q)) return { kind: 'unsupported', id, said: 'comparisons' };
  const period = parsePeriod(q);
  // Every remaining content word is something we did not understand: refuse rather than answer the plain figure without it.
  if (period?.kind !== 'unsupported') {
    const words = leftoverWords(stripDates(q));
    if (words.length > 0) return { kind: 'leftover', id, words };
  }
  return { kind: 'intent', intent: { id, period, qualifier } };
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
