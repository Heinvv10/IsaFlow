/**
 * The Sage migration runner's integration world: two unrelated companies (items-suite fixture), the three fixture suppliers
 * in company A (one linked by Sage reference to a differently named supplier, two found by exact name), and the synthetic export.
 * Synthetic values only. Reads run as the superuser pool (the tables' RLS is for the runner, not for the assertions).
 */
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { itemsWorld, type ItemsWorld } from './itemsWorld';
import { parseSageExport } from '@/modules/accounting/services/sage-migration/sageExportParser';
import type { ParsedExport } from '@/modules/accounting/services/sage-migration/sageExportTypes';

export interface SageWorld {
  w: ItemsWorld;
  companyId: string;
  userId: string;
  otherCompanyId: string;
  otherUserId: string;
  suppliers: { alpha: string; bravo: string; charlie: string };
}

export const exportFile = (): Record<string, unknown> => JSON.parse(readFileSync('tests/fixtures/sage-export/sage-export.json', 'utf8'));
export const parsedExport = (file: Record<string, unknown> = exportFile()): ParsedExport => parseSageExport(file);

export async function sageWorld(pool: Pool): Promise<SageWorld> {
  const w = await itemsWorld(pool);
  const company = w.a.u.homeCompanyId;
  const supplier = async (name: string, ref: string | null) => String((await pool.query(
    `INSERT INTO suppliers (company_id, name, external_system, external_ref) VALUES ($1, $2, $3, $4) RETURNING id`,
    [company, name, ref ? 'sage' : null, ref])).rows[0].id);
  return {
    w, companyId: company, userId: w.a.u.userId, otherCompanyId: w.b.u.homeCompanyId, otherUserId: w.b.u.userId,
    suppliers: {
      // Sage supplier 301 is "Alpha Optics (Pty) Ltd" in the export: here it carries another name and the Sage reference.
      alpha: await supplier('Alpha Optics (renamed)', '301'),
      bravo: await supplier('Bravo Poles CC', null),
      charlie: await supplier('charlie tools', null),
    },
  };
}

export const n = async (pool: Pool, text: string, params: unknown[]): Promise<number> => Number((await pool.query(text, params)).rows[0].n);

/** Counts of what a run leaves in the company, read directly. */
export async function booked(pool: Pool, company: string) {
  return {
    items: await n(pool, `SELECT count(*) AS n FROM items WHERE company_id = $1`, [company]),
    categories: await n(pool, `SELECT count(*) AS n FROM item_categories WHERE company_id = $1`, [company]),
    pos: await n(pool, `SELECT count(*) AS n FROM purchase_orders WHERE company_id = $1`, [company]),
    poLines: await n(pool, `SELECT count(*) AS n FROM po_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)`, [company]),
    movements: await n(pool, `SELECT count(*) AS n FROM stock_movements WHERE company_id = $1`, [company]),
    toolCalls: await n(pool, `SELECT count(*) AS n FROM mcp_tool_calls WHERE company_id = $1`, [company]),
    poTotalCents: await n(pool, `SELECT COALESCE(round(sum(total) * 100), 0) AS n FROM purchase_orders WHERE company_id = $1`, [company]),
  };
}

export async function cleanupSageWorld(pool: Pool, s: SageWorld): Promise<void> {
  for (const c of [s.companyId, s.otherCompanyId]) {
    await pool.query('DELETE FROM mcp_tool_calls WHERE company_id = $1', [c]);
    await pool.query('DELETE FROM audit_log WHERE company_id = $1', [c]);
    await pool.query('DELETE FROM po_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)', [c]);
    await pool.query('DELETE FROM purchase_orders WHERE company_id = $1', [c]);
    await pool.query('DELETE FROM stock_movements WHERE company_id = $1', [c]);
    await pool.query('DELETE FROM items WHERE company_id = $1', [c]);
    await pool.query('DELETE FROM item_categories WHERE company_id = $1', [c]);
    await pool.query('DELETE FROM suppliers WHERE company_id = $1', [c]);
  }
}

/**
 * A pool whose Nth COMMIT (counted from 1 across every client it hands out) throws before it reaches the server: the request
 * transaction stays open and the runner's own ROLLBACK ends it, so the batch is not in the books. Dry runs and reads never
 * COMMIT (they roll back), so the count is the live batches in order: 4 categories, the item batches, then the PO batches.
 * The runner cannot tell this from a COMMIT that landed without answering: the batch is `commitUnconfirmed` and the run STOPS there
 * (MigrationStopped). For a batch that fails and lets the run go on, use failingBatchPool.
 */
export function failingCommitPool(pool: Pool, failOn: readonly number[]): Pool {
  let commits = 0;
  return {
    options: pool.options, // the runner checks the pool's connection string
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, prop) {
          if (prop === 'query') {
            return (...args: unknown[]) => {
              if (args[0] === 'COMMIT' && failOn.includes(++commits)) return Promise.reject(new Error(`injected: COMMIT ${commits} failed`));
              return (target.query as (...a: unknown[]) => Promise<unknown>)(...args);
            };
          }
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  } as unknown as Pool;
}

/**
 * A pool on which ONE live batch fails before its COMMIT: the first query whose parameters name the batch's idempotency key (the registry's
 * idempotency lock, `mcp:<company>:<tool>:<key>`) starting with `keyPrefix` (e.g. 'sage-mig-purchase_order-0002-') rejects. The dry run's keys
 * end in "-dry" and are let through. The request transaction rolls back: the batch is failed, nothing of it written, and its COMMIT is never
 * sent (not `commitUnconfirmed`), so the run goes on as it does after a batch the tool refused.
 */
export function failingBatchPool(pool: Pool, keyPrefix: string): Pool {
  let fired = false;
  const names = (p: unknown): boolean => typeof p === 'string' && p.includes(`:${keyPrefix}`) && !p.endsWith('-dry');
  return {
    options: pool.options,
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, prop) {
          if (prop === 'query') {
            return (...args: unknown[]) => {
              if (!fired && Array.isArray(args[1]) && args[1].some(names)) { fired = true; return Promise.reject(new Error(`injected: batch ${keyPrefix} failed`)); }
              return (target.query as (...a: unknown[]) => Promise<unknown>)(...args);
            };
          }
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  } as unknown as Pool;
}

/** Row stamps: a row nothing touched keeps its xmin. */
export async function stamps(pool: Pool, company: string): Promise<Record<string, string>> {
  const rows = (await pool.query(
    `SELECT 'item:' || id AS k, xmin::TEXT AS x FROM items WHERE company_id = $1
     UNION ALL SELECT 'po:' || id, xmin::TEXT FROM purchase_orders WHERE company_id = $1
     UNION ALL SELECT 'poline:' || id, xmin::TEXT FROM po_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)
     UNION ALL SELECT 'cat:' || id, xmin::TEXT FROM item_categories WHERE company_id = $1`, [company])).rows;
  return Object.fromEntries(rows.map((r) => [r.k, r.x]));
}

/**
 * A pool that reacts to a BATCH, not to a connection count: after the COMMIT of the transaction that ran `tool` (the dry run rolls back, so
 * only a live batch counts), `after` runs once on the real pool; with `failNextConnect` the next connect() then rejects (a lost connection).
 * It finds the tool from the registry's own `mcp_tool_calls` audit insert in that transaction.
 */
export function afterCommitOf(pool: Pool, tool: string, opts: { after?: () => Promise<void>; failNextConnect?: boolean }): Pool {
  let fired = false;
  let failNext = false;
  return {
    options: pool.options,
    connect: async () => {
      if (failNext) { failNext = false; throw new Error('injected: connection lost'); }
      const client = await pool.connect();
      let last: string | null = null;
      return new Proxy(client, {
        get(target, prop) {
          if (prop === 'query') {
            return async (...args: unknown[]) => {
              const [text, params] = args as [unknown, unknown];
              if (text === 'BEGIN') last = null;
              if (typeof text === 'string' && text.includes('INSERT INTO mcp_tool_calls') && Array.isArray(params) && params.includes(tool)) last = tool;
              const out = await (target.query as (...a: unknown[]) => Promise<unknown>)(...args);
              if (text === 'COMMIT' && last === tool && !fired) {
                fired = true;
                if (opts.after) await opts.after();
                if (opts.failNextConnect) failNext = true;
              }
              return out;
            };
          }
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  } as unknown as Pool;
}
