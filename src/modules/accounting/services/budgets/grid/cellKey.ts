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

function id(v: string | null, what: string): string {
  if (v === null) return '';
  if (v === '' || v.includes('|')) throw new RangeError(`Bad ${what} id: ${JSON.stringify(v)}`);
  return v;
}

export function cellKey(ref: CellRef): CellKey {
  if (!MONTH.test(ref.month)) throw new RangeError(`Bad month: ${JSON.stringify(ref.month)}`);
  if (ref.glAccountId === '') throw new RangeError('Missing account id');
  return [id(ref.glAccountId, 'account'), id(ref.cc1Id, 'CC1'), id(ref.cc2Id, 'CC2'), id(ref.buId, 'BU'), ref.month].join('|');
}

export function parseKey(key: CellKey): CellRef {
  const parts = key.split('|');
  if (parts.length !== 5 || parts[0] === '' || !MONTH.test(parts[4])) throw new RangeError(`Bad cell key: ${key}`);
  const [glAccountId, cc1, cc2, bu, month] = parts;
  return { glAccountId, cc1Id: cc1 || null, cc2Id: cc2 || null, buId: bu || null, month };
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
  if (set.length === 0) return 'company';
  return set.length === 1 ? set[0] : 'multi';
}
