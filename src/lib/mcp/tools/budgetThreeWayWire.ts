/**
 * Money on the wire of the three-way tools (budget tools PR 3): the three-way services hold integer CENTS (the app's
 * routes answer cents); the MCP tools take and answer decimal TEXT, as every budget tool does. Pure.
 *  - The assumptions document's money fields (assumptionsSchema: capex `amountExVat`, a planned loan's
 *    `principal`, a share issue's and a dividend's `amount`, `minimumCash.value`), in a full document and in a
 *    scenario's `overrides`: `docToWire` / `docFromWire`. A number in a money field is refused (no floats).
 *  - A run or derive answer (`centsDeep`): every integer is cents except the keys in NOT_MONEY (day and month
 *    counts, the SARS offset), and a non-integer is never money (days, shares, rates stay numbers).
 */
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

const NOT_MONEY = new Set(['days', 'months', 'value', 'sars', 'schemaVersion']);

/** Every integer under `value` as decimal text, except under the NOT_MONEY keys; strings, booleans and fractions as they are. */
export function centsDeep(value: unknown, key = ''): unknown {
  if (typeof value === 'number') return Number.isInteger(value) && !NOT_MONEY.has(key) ? centsText(value) : value;
  if (Array.isArray(value)) return value.map((v) => centsDeep(v, key));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, centsDeep(v, k)]));
  return value;
}
