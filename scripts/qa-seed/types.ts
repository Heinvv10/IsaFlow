/**
 * Tagged-template SQL function shape returned by createSql() in scripts/_pg.ts.
 * Matches the shape so per-module seeders can be typed without importing pg.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TaggedSql = <T = Record<string, any>>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T[]>;

export type Customer = { id: string; name: string; code: string };
export type Supplier = { id: string; name: string; code: string };
export type WorkItem = { catId: string; itemId: string; catName: string; itemName: string };
export type PracticeClient = { id: string; name: string; linkedCustomerId: string | null };

export const QA_RECORD_PREFIX = 'QA-';
