/**
 * R-082 round 3, MEDIUM — the SQL rule and its JS twin must never drift.
 *
 * `shared/documentPopulation.ts` carries two expressions of the same rule:
 * `documentInPopulationExpr` (spliced into SQL) and `documentInPopulation`
 * (evaluated in JS, added round 2 so a report can classify an excluded
 * invoice into its own `excluded` bucket instead of filtering it out of the
 * query). Both read the same `EXCLUDED_STATUSES` list, but the round-2
 * review broke the JS function body alone (kept `pending_approval` in the
 * population) and every gate — the full CI suite, all 48 r059/k053/r082/r096
 * integration files — stayed green, because nothing ever compared the two
 * expressions' actual output. The emailed statement and both MCP tools
 * showed a pending-approval invoice the screen, ageing and subledger did
 * not.
 *
 * This test drives EVERY status value the database itself will accept — read
 * live from each table's own CHECK constraint via pg_get_constraintdef, not
 * hand-copied — plus NULL, through both expressions, and asserts they agree
 * on every one. A future edit to either expression that admits or excludes a
 * status the other doesn't goes red here, not silently in production.
 */
import { describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import {
  documentInPopulation,
  documentInPopulationExpr,
} from '@/modules/accounting/services/shared/documentPopulation';
import type { InvoiceAlias } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

/** Pulls the allowed status list straight off the live CHECK constraint. */
async function liveStatusValues(constraintName: string): Promise<string[]> {
  const [row] = (await sql`
    SELECT pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conname = ${constraintName}
  `) as { def: string }[];
  if (!row) throw new Error(`Constraint not found: ${constraintName}`);
  // pg_get_constraintdef renders e.g.
  // CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, ...])::text[])))
  const matches = [...row.def.matchAll(/'([a-z_]+)'::character varying/g)];
  const values = matches.map((m) => m[1]!);
  if (values.length === 0) throw new Error(`Could not parse statuses from: ${row.def}`);
  return values;
}

/** Evaluates documentInPopulationExpr(alias) in SQL, with no real table needed. */
async function sqlSaysIncluded(status: string | null, alias: InvoiceAlias): Promise<boolean> {
  const [row] = (await sql`
    SELECT (${sql.unsafe(documentInPopulationExpr(alias))}) AS included
    FROM (SELECT ${status}::text AS status) AS ${sql.unsafe(alias)}
  `) as { included: boolean }[];
  return row!.included;
}

describeIfDb('R-082 round 3 — documentInPopulationExpr and documentInPopulation agree', () => {
  it('both CHECK constraints spell pending_approval identically', async () => {
    const ar = await liveStatusValues('customer_invoices_status_check');
    const ap = await liveStatusValues('supplier_invoices_status_check');
    expect(ar).toContain('pending_approval');
    expect(ap).toContain('pending_approval');
    expect(ar).toContain('draft');
    expect(ar).toContain('cancelled');
  });

  it('SQL and JS agree on every customer_invoices status, plus NULL', async () => {
    const statuses = await liveStatusValues('customer_invoices_status_check');
    const candidates: (string | null)[] = [...statuses, null];
    const disagreements: string[] = [];
    for (const status of candidates) {
      const sqlIncluded = await sqlSaysIncluded(status, 'ci');
      const jsIncluded = documentInPopulation(status);
      if (sqlIncluded !== jsIncluded) {
        disagreements.push(`${status ?? 'NULL'}: sql=${sqlIncluded} js=${jsIncluded}`);
      }
    }
    expect(disagreements).toEqual([]);
    // The premise: this actually enumerated every live status plus NULL —
    // not an empty or truncated list silently passing vacuously.
    expect(candidates.length).toBeGreaterThanOrEqual(8);
  });

  it('SQL and JS agree on every supplier_invoices status, plus NULL', async () => {
    const statuses = await liveStatusValues('supplier_invoices_status_check');
    const candidates: (string | null)[] = [...statuses, null];
    const disagreements: string[] = [];
    for (const status of candidates) {
      const sqlIncluded = await sqlSaysIncluded(status, 'si');
      const jsIncluded = documentInPopulation(status);
      if (sqlIncluded !== jsIncluded) {
        disagreements.push(`${status ?? 'NULL'}: sql=${sqlIncluded} js=${jsIncluded}`);
      }
    }
    expect(disagreements).toEqual([]);
    expect(candidates.length).toBeGreaterThanOrEqual(7);
  });

  it('the excluded set is exactly draft, pending_approval and cancelled', () => {
    expect(documentInPopulation('draft')).toBe(false);
    expect(documentInPopulation('pending_approval')).toBe(false);
    expect(documentInPopulation('cancelled')).toBe(false);
    expect(documentInPopulation('approved')).toBe(true);
    expect(documentInPopulation('paid')).toBe(true);
    expect(documentInPopulation(null)).toBe(true);
    expect(documentInPopulation(undefined)).toBe(true);
  });
});
