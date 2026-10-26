/**
 * One budget cell = (account, CC1, CC2, BU, month). The key is a flat string so
 * it can index a Map: `${glAccountId}|${cc1|''}|${cc2|''}|${bu|''}|${YYYY-MM}`.
 */

export type CellKey = string;
export type Grain = 'company' | 'cc1' | 'cc2' | 'bu' | 'multi';
export type Dimension = 'cc1' | 'cc2' | 'bu';

export interface CellRef {
  glAccountId: string;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
  /** 'YYYY-MM' */
  month: string;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Ids are uuids; anything printable up to 64 characters without the separator is accepted. */
const ID = /^[\x21-\x7b\x7d\x7e]{1,64}$/;

function id(v: string | null, what: string): string {
  if (v === null) return '';
  if (!ID.test(v)) throw new RangeError(`Bad ${what} id: ${JSON.stringify(v.slice(0, 80))}`);
  return v;
}

export function cellKey(ref: CellRef): CellKey {
  if (!MONTH.test(ref.month)) throw new RangeError(`Bad month: ${JSON.stringify(ref.month)}`);
  return [id(ref.glAccountId, 'account'), id(ref.cc1Id, 'CC1'), id(ref.cc2Id, 'CC2'), id(ref.buId, 'BU'), ref.month].join('|');
}

export function parseKey(key: CellKey): CellRef {
  const [glAccountId, cc1, cc2, bu, month, ...rest] = key.split('|');
  const optional = (v: string | undefined) => (v === undefined || v === '' ? null : v);
  if (glAccountId === undefined || month === undefined || rest.length > 0) throw new RangeError(`Bad cell key: ${key.slice(0, 200)}`);
  const ref = { glAccountId, cc1Id: optional(cc1), cc2Id: optional(cc2), buId: optional(bu), month };
  // Re-encoding validates every part (id shape, month) the same way `cellKey` does.
  if (cellKey(ref) !== key) throw new RangeError(`Bad cell key: ${key.slice(0, 200)}`);
  return ref;
}

/** The key without its month: one grid row at one grain. */
export function rowKeyOf(key: CellKey): string {
  return key.slice(0, key.lastIndexOf('|'));
}

export function grainOf(ref: Pick<CellRef, 'cc1Id' | 'cc2Id' | 'buId'>): Grain {
  const set: Dimension[] = [];
  if (ref.cc1Id !== null) set.push('cc1');
  if (ref.cc2Id !== null) set.push('cc2');
  if (ref.buId !== null) set.push('bu');
  const [only, ...more] = set;
  if (only === undefined) return 'company';
  return more.length === 0 ? only : 'multi';
}
