/**
 * The VAT-lock reclassification check decides journal MEMBERSHIP in the filed
 * VAT201 with the snapshot's own SQL rule (reports/vatEntryMembership), but
 * evaluated with changing accounts' before/after attributes SUBSTITUTED
 * (gl/vatLockLineClassification `changedAccountsSql` + `memberLineUnderSql`).
 * This pins that production path against the snapshot's plain rule over the
 * same 55 real lines — 11 account shapes × 5 vat_type values (P&L, balance
 * sheet with NULL subtype, settlement subtypes, a legitimate VAT balance-sheet
 * subtype, the generic `tax` subtype on both sides, vat_input / vat_output;
 * NULL, standard, zero_rated, no_vat, ''):
 *
 *   1. substituting an account's OWN attributes (or nothing) changes nothing:
 *      the substituted fragment equals the plain one, line by line;
 *   2. substituting OTHER attributes gives exactly what the plain fragment says
 *      after the account is ACTUALLY changed to them (in a savepoint, rolled
 *      back) — for every account and every target shape.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PoolClient } from 'pg';
import { getPoolForTests, sql } from '@/lib/neon';
import { vatEntryMemberLineSql } from '@/modules/accounting/services/reports/vatEntryMembership';
import {
  changedAccountsSql, memberLineUnderSql, type AccountAttributeChange,
} from '@/modules/accounting/services/gl/vatLockLineClassification';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

type Row = Record<string, unknown>;
let fx: Fixture;
const accounts: { id: string; type: string; sub: string | null }[] = [];

const SHAPES: [string, string | null][] = [
  ['expense', 'operating_expense'], // P&L
  ['revenue', 'revenue'],
  ['asset', null], // balance sheet, NULL subtype
  ['asset', 'receivable'], // settlement subtype
  ['asset', 'bank'],
  ['liability', 'payable'],
  ['asset', 'fixed_asset'], // legitimate VAT balance-sheet subtype
  ['expense', 'tax'], // generic tax (PAYE)
  ['liability', 'tax'],
  ['asset', 'vat_input'],
  ['liability', 'vat_output'],
];
const VAT_TYPES: (string | null)[] = [null, 'standard', 'zero_rated', 'no_vat', ''];

/** Per line id: the plain fragment, and the substituted one for `changes`. */
async function evaluate(c: PoolClient, changes: AccountAttributeChange[], side: 'from' | 'to') {
  const q = sql`
    WITH ch AS (${changedAccountsSql(changes)})
    SELECT jl.id, ${vatEntryMemberLineSql()} AS plain, ${memberLineUnderSql(side)} AS substituted
    FROM gl_journal_lines jl
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
    LEFT JOIN ch ON ch.id = jl.gl_account_id
    WHERE jl.company_id = ${fx.companyId}::UUID
    ORDER BY jl.id`;
  const r = await c.query(q.text, q.values);
  return r.rows as { id: string; plain: boolean; substituted: boolean }[];
}

const self = (a: { id: string; type: string; sub: string | null }): AccountAttributeChange => ({
  accountId: a.id, accountCode: a.id, from: { accountType: a.type, accountSubtype: a.sub },
  to: { accountType: a.type, accountSubtype: a.sub },
});

describeIfDb('VAT201 membership: the substituted-attribute fragment the lock check uses agrees with the snapshot', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test writes journal lines and changes account attributes in rolled-back savepoints.');
    fx = await seedFixture('VEM', DATABASE_URL!);
    const je = String(((await sql`
      INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by)
      VALUES (${fx.companyId}::UUID, ${`VEM-${fx.tag}`}, '2026-06-10', 'shapes', 'draft', ${fx.userId}::UUID)
      RETURNING id`) as Row[])[0]!.id);
    let n = 0;
    for (const [t, st] of SHAPES) {
      const id = String(((await sql`
        INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
        VALUES (${fx.companyId}::UUID, ${`9${String(++n).padStart(3, '0')}`}, ${`${t}/${st} ${fx.tag}`}, ${t}, ${st}, 'debit', true)
        RETURNING id`) as Row[])[0]!.id);
      accounts.push({ id, type: t, sub: st });
      for (const v of VAT_TYPES) {
        await sql`
          INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description, vat_type)
          VALUES (${fx.companyId}::UUID, ${je}::UUID, ${id}::UUID, 1, 0, ${`${t}|${st}|${v}`}, ${v})`;
      }
    }
  }, 120000);

  afterAll(async () => { await dropFixture(fx); }, 120000);

  it('substituting accounts\' own attributes (or nothing) equals the plain fragment on every line', async () => {
    const c = await getPoolForTests().connect();
    try {
      for (const changes of [[], accounts.map(self)]) {
        for (const side of ['from', 'to'] as const) {
          const rows = await evaluate(c, changes, side);
          expect(rows).toHaveLength(SHAPES.length * VAT_TYPES.length);
          expect(rows.filter((r) => r.plain !== r.substituted).map((r) => r.id)).toEqual([]);
        }
      }
      // Both answers occur, so agreement is not two constants agreeing.
      const rows = await evaluate(c, [], 'to');
      expect(rows.some((r) => r.plain)).toBe(true);
      expect(rows.some((r) => !r.plain)).toBe(true);
    } finally {
      c.release();
    }
  });

  it('substituted attributes give what the plain fragment says after ACTUALLY changing the account', async () => {
    const c = await getPoolForTests().connect();
    const disagreements: string[] = [];
    let compared = 0;
    try {
      await c.query('BEGIN');
      for (const a of accounts) {
        for (const [t, st] of SHAPES) {
          if (t === a.type && st === a.sub) continue;
          const change = { ...self(a), to: { accountType: t, accountSubtype: st } };
          const predicted = await evaluate(c, [change], 'to');
          await c.query('SAVEPOINT vem');
          try {
            await c.query('UPDATE gl_accounts SET account_type = $1, account_subtype = $2 WHERE id = $3',
              [t, st, a.id]);
          } catch (err) {
            // A shape the table refuses (a CHECK on type/subtype) cannot happen
            // for real, so there is nothing to compare.
            await c.query('ROLLBACK TO SAVEPOINT vem');
            expect((err as { code?: string }).code).toMatch(/^23/);
            continue;
          }
          const actual = await evaluate(c, [], 'to');
          await c.query('ROLLBACK TO SAVEPOINT vem');
          compared += 1;
          const actualById = new Map(actual.map((r) => [r.id, r.plain]));
          for (const p of predicted) {
            if (actualById.get(p.id) !== p.substituted) {
              disagreements.push(`${a.type}/${a.sub} → ${t}/${st}, line ${p.id}: predicted ${p.substituted}`);
            }
          }
        }
      }
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    expect(disagreements).toEqual([]);
    expect(compared).toBeGreaterThan(50);
  });
});
