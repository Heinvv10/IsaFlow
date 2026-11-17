/**
 * Money on the wire of the three-way tools (budget tools PR 3): the three-way services hold integer CENTS (the app's
 * routes answer cents); the MCP tools take and answer decimal TEXT, as every budget tool does. Pure.
 *  - The assumptions document's money fields (assumptionsSchema: capex `amountExVat`, a planned loan's
 *    `principal`, a share issue's and a dividend's `amount`, `minimumCash.value`), in a full document and in a
 *    scenario's `overrides`: `docToWire` / `docFromWire`. A number in a money field is refused (no floats).
 *  - A run or derive answer (`centsDeep`): an allowlist of the keys that hold cents (MONEY_KEYS) and of those that
 *    do not (NOT_MONEY_KEYS); a number under neither is refused, never guessed.
 */
import type { CashGroup } from '@/modules/accounting/services/afs/cashFlowClassification';
import { BUCKET_KEYS, PNL_BANDS } from '@/modules/accounting/services/budgets/threeWay/types';
import { centsText, parseMoney } from './budgetToolArgs';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Where a document holds money: [list or object path, field]. A list path applies to each item. */
const MONEY_FIELDS: ReadonlyArray<{ path: readonly string[]; list: boolean; field: string }> = [
  { path: ['capex'], list: true, field: 'amountExVat' },
  { path: ['loans', 'planned'], list: true, field: 'principal' },
  { path: ['equity', 'shareIssues'], list: true, field: 'amount' },
  { path: ['equity', 'dividends'], list: true, field: 'amount' },
  { path: ['minimumCash'], list: false, field: 'value' },
];

/** A deep copy with `fn` applied to every money field present; `fn` gets the field's path for messages. */
function mapMoney(doc: unknown, fn: (value: unknown, where: string) => unknown): unknown {
  const copy = structuredClone(doc) as unknown;
  if (!isObj(copy)) return copy;
  const root = isObj(copy.overrides) ? copy.overrides : copy;
  const prefix = root === copy ? '' : 'overrides.';
  for (const m of MONEY_FIELDS) {
    let node: unknown = root;
    for (const k of m.path) node = isObj(node) ? node[k] : undefined;
    const at = `${prefix}${m.path.join('.')}`;
    if (m.list && Array.isArray(node)) {
      node.forEach((item, i) => { if (isObj(item) && m.field in item) item[m.field] = fn(item[m.field], `${at}[${i}].${m.field}`); });
    } else if (!m.list && isObj(node) && m.field in node) {
      node[m.field] = fn(node[m.field], `${at}.${m.field}`);
    }
  }
  return copy;
}

/** A stored (cents) document as the tools answer it: money as decimal text. */
export function docToWire(doc: unknown): unknown {
  return mapMoney(doc, (v) => (Number.isInteger(v) ? centsText(v as number) : v));
}

/** A document the agent sent (decimal text) as the service takes it (cents), or every money field it cannot read. */
export function docFromWire(raw: unknown): { doc: unknown } | { errors: string[] } {
  const errors: string[] = [];
  const doc = mapMoney(raw, (v, where) => {
    if (typeof v !== 'string') { errors.push(`${where}: amounts are decimal strings such as "1500.00", never numbers`); return v; }
    const money = parseMoney(v);
    if ('error' in money) { errors.push(`${where}: ${money.error}`); return v; }
    return money.cents;
  });
  return errors.length > 0 ? { errors } : { doc };
}

/** Direct cash flow keys (a Record of CashGroup: the compiler holds this list complete). */
const CASH_GROUPS: Record<CashGroup, true> = {
  cash_received_from_customers: true, cash_paid_to_suppliers: true, cash_paid_to_employees: true, other_operating: true, investing: true, financing: true,
};

/**
 * Every numeric field of a run (ThreeWayView's sections) and of derive's evidence that holds CENTS, by key. An
 * ALLOWLIST (review round 1, M3): tests/unit/mcp/budgetThreeWayWire.test.ts walks those types with the compiler and
 * fails on a numeric field in neither set, and `centsDeep` refuses one at run time rather than guess its unit.
 */
export const MONEY_KEYS: ReadonlySet<string> = new Set([
  ...BUCKET_KEYS, ...PNL_BANDS, 'netProfit', ...Object.keys(CASH_GROUPS),
  // BalanceSheetSections
  'currentAssets', 'nonCurrentAssets', 'totalAssets', 'currentLiabilities', 'nonCurrentLiabilities', 'totalLiabilities', 'equity', 'check',
  // CashFlowMonth, IndirectCashFlow (the rest are buckets / bands)
  'openingCash', 'operating', 'net', 'closingCash', 'vat', 'incomeTax',
  // LookbackMonth, OpeningTotals, opening equity, UnmappedBalance, Runway, OpeningCashCheck / CashCheckAccount, VatSettlement, TaxEvent
  'supplierPurchases', 'assets', 'liabilities', 'posted', 'derivedRetainedEarnings', 'balance', 'minimumCash', 'minCash', 'bucket', 'ledger', 'difference', 'amount',
  // ThreeWayWarning / ServiceWarning figures
  'cents', 'budgeted', 'excess', 'differenceCents',
  // DeriveEvidence (trailing, vat, statutory, opening), AgingEvidence
  'statutoryPayroll', 'outputTax', 'inputTax', 'statutory', 'receivables', 'payables',
]);

/** Numeric fields that are not money: day and month counts, the SARS top-up offset (6 or 7) a warning compares. */
export const NOT_MONEY_KEYS: ReadonlySet<string> = new Set(['days', 'months', 'value', 'sars']);

/** Every integer under a MONEY key as decimal text; NOT_MONEY numbers as they are; any other number refused (unit unknown). */
export function centsDeep(value: unknown, key = ''): unknown {
  if (typeof value === 'number') {
    if (NOT_MONEY_KEYS.has(key)) return value;
    if (!MONEY_KEYS.has(key)) throw new Error(`unclassified three-way figure ${key}: classify it in budgetThreeWayWire (money or not)`);
    if (!Number.isInteger(value)) throw new Error(`three-way figure ${key} is not whole cents`);
    return centsText(value);
  }
  if (Array.isArray(value)) return value.map((v) => centsDeep(v, key));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, centsDeep(v, k)]));
  return value;
}
