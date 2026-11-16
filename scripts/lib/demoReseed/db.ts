/**
 * The reseed's one connection: a single pg.Client (no pool, so every statement
 * is on the one transaction), with a tagged template in the shape the deploy's
 * integrity checks take (IntegritySql), so they run inside the transaction too.
 */

import type pg from 'pg';
import type { IntegritySql } from '../integrityTypes';

export interface Tx {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<T[]>;
  sql: IntegritySql;
  client: pg.Client;
}

export function txOver(client: pg.Client): Tx {
  const query = async <T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> =>
    (await client.query(text, values)).rows as T[];
  const sql: IntegritySql = async <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]> => {
    let text = '';
    strings.forEach((s, i) => { text += s + (i < values.length ? `$${i + 1}` : ''); });
    return query<T>(text, values);
  };
  return { query, sql, client };
}
