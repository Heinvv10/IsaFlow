/**
 * The guards, and the one path that actually writes — against a real Postgres.
 *
 * Each refusal here is earned from a defect this repo has already had: a cycle
 * that wedged the dev database until the backend was killed by hand, a system
 * account whose subtype every auto-posting path resolves by, bank transactions
 * left reachable from nothing, and configuration rows still pointing at an
 * account nobody posts to any more.
 *
 * The live merge runs inside a rolled-back transaction. It is exercised here
 * and nowhere else: no production merge is part of this work.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';
import {
  assertMergeTestDb,
  createMergeFixture,
  type MergeFixture,
} from '../helpers/accountMergeFixture';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests, sql } from '@/lib/neon';
import { mergeAccounts, AccountMergeError } from '@/modules/accounting/services/gl/accountMergeService';
import { CONFIGURATION_REFERENCE_EXCLUSIONS } from '@/modules/accounting/services/gl/accountMergeGuards';

type Ctx = Parameters<typeof als.run>[0];
const ctxFor = (client: PoolClient, companyId: string): Ctx =>
  ({ client, userId: '00000000-0000-0000-0000-0000000000aa', companyId, claims: {} } as unknown as Ctx);

async function withFixture(fn: (c: PoolClient, f: MergeFixture) => Promise<void>): Promise<void> {
  assertMergeTestDb();
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const fixture = await createMergeFixture(client);
    await als.run(ctxFor(client, fixture.companyId), () => fn(client, fixture));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function refusalCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AccountMergeError);
    return (err as AccountMergeError).code;
  }
  throw new Error('expected a refusal, got a success');
}

describe('mergeAccounts refuses', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('the same account, a type mismatch, a cycle and a system source', async () => {
    await withFixture(async (_c, f) => {
      expect(await refusalCode(() => mergeAccounts(f.companyId, f.sourceId, f.sourceId)))
        .toBe('source_equals_target');
      expect(await refusalCode(() => mergeAccounts(f.companyId, f.sourceId, f.contraId)))
        .toBe('account_type_mismatch');
      // The target sits BELOW the source: merging would make the tree cyclic.
      expect(await refusalCode(() => mergeAccounts(f.companyId, f.sourceId, f.childId)))
        .toBe('target_is_descendant_of_source');
      expect(await refusalCode(() => mergeAccounts(f.companyId, f.systemId, f.targetId)))
        .toBe('source_is_system_account');
    });
  }, 60_000);

  it.skipIf(!reachable)('an account another company owns, without saying which', async () => {
    await withFixture(async (_c, f) => {
      const other = '99999999-9999-4999-8999-999999999999';
      expect(await refusalCode(() => mergeAccounts(f.companyId, other, f.targetId)))
        .toBe('account_not_found');
    });
  }, 60_000);

  it.skipIf(!reachable)('a source a configuration row still points at', async () => {
    await withFixture(async (c, f) => {
      await c.query(
        `INSERT INTO bank_rules (company_id, name, match_type, match_field, match_value, gl_account_id)
         VALUES ($1, 'merge fixture rule', 'contains', 'description', 'zzz', $2)`,
        [f.companyId, f.cleanSourceId],
      );
      const code = await refusalCode(() => mergeAccounts(f.companyId, f.cleanSourceId, f.targetId));
      expect(code).toBe('source_referenced_by_configuration');
    });
  }, 60_000);

  it.skipIf(!reachable)('a merge that crosses the VAT reporting boundary, in EITHER direction', async () => {
    await withFixture(async (_c, f) => {
      // The attack: SYS-7-shaped source (asset, NULL subtype, non-system) into a
      // vat_input target. Both asset, no cycle, no config references, zero skips —
      // and vatReturnService scopes VAT membership by account_subtype, so the
      // unclassified-input sweep would add the whole balance to box 15.
      expect(await refusalCode(() => mergeAccounts(f.companyId, f.cleanSourceId, f.vatInputId)))
        .toBe('account_subtype_reporting_class');
      // The mirror: lines moving OUT of a tax-class account drop out of the
      // membership filter entirely and understate the return. Covered today only
      // by accident, because most VAT accounts are system accounts — these two
      // shapes exist on Brightsphere right now and are not.
      expect(await refusalCode(() => mergeAccounts(f.companyId, f.taxSourceId, f.contraId)))
        .toBe('account_subtype_reporting_class');
    });
  }, 60_000);

  it.skipIf(!reachable)('but NOT the two merges this tool exists for', async () => {
    await withFixture(async (_c, f) => {
      // NULL -> receivable and NULL -> payable are both ordinary -> ordinary.
      // `receivable` and `payable` appear in neither the VAT membership filter
      // nor any bank-reachability path, so the class rule permits them.
      await sql`UPDATE gl_accounts SET account_subtype = 'receivable'
                 WHERE id = ${f.targetId}::UUID AND company_id = ${f.companyId}::UUID`;
      await expect(mergeAccounts(f.companyId, f.cleanSourceId, f.targetId)).resolves.toBeDefined();

      await sql`UPDATE gl_accounts
                   SET account_type = 'liability', account_subtype = 'payable', is_active = true
                 WHERE id = ${f.inactiveTargetId}::UUID AND company_id = ${f.companyId}::UUID`;
      await expect(mergeAccounts(f.companyId, f.cleanLiabilitySourceId, f.inactiveTargetId))
        .resolves.toBeDefined();
    });
  }, 60_000);

  it.skipIf(!reachable)('a bank-subtype source its statement rows still reference', async () => {
    await withFixture(async (_c, f) => {
      // bank -> bank, so the reporting-class rule permits it and the row-count
      // guard is the only thing left standing between the merge and a set of
      // statement rows reachable from nothing.
      expect(await refusalCode(() => mergeAccounts(f.companyId, f.bankSourceId, f.bankTargetId)))
        .toBe('source_bank_subtype_referenced');
    });
  }, 60_000);

  it.skipIf(!reachable)('a DEACTIVATED target, which would hide the balance again', async () => {
    await withFixture(async (_c, f) => {
      expect(await refusalCode(() => mergeAccounts(f.companyId, f.cleanSourceId, f.inactiveTargetId)))
        .toBe('target_is_inactive');
    });
  }, 60_000);

  it.skipIf(!reachable)('a source whose lines cannot all move', async () => {
    await withFixture(async (_c, f) => {
      // The fixture source carries a closed-period line and a no-period line.
      expect(await refusalCode(() => mergeAccounts(f.companyId, f.sourceId, f.targetId)))
        .toBe('lines_cannot_be_repointed');
    });
  }, 60_000);
});

describe('mergeAccounts writes', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('repoints the ledger, deactivates the source, and moves no money', async () => {
    await withFixture(async (c, f) => {
      const before = await c.query<{ d: string; cr: string }>(
        `SELECT COALESCE(SUM(l.debit),0) d, COALESCE(SUM(l.credit),0) cr
           FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
          WHERE l.company_id = $1 AND e.status = 'posted'`,
        [f.companyId],
      );

      const result = await mergeAccounts(f.companyId, f.cleanSourceId, f.targetId);
      expect(result.linesRepointed).toBe(1);
      expect(result.sourceDeactivated).toBe(true);

      const src = await c.query<{ n: string; active: boolean }>(
        `SELECT (SELECT COUNT(*) FROM gl_journal_lines WHERE gl_account_id = $1) n,
                (SELECT is_active FROM gl_accounts WHERE id = $1) active`,
        [f.cleanSourceId],
      );
      expect(Number(src.rows[0]!.n)).toBe(0);
      expect(src.rows[0]!.active).toBe(false);

      const tgt = await c.query<{ d: string }>(
        `SELECT COALESCE(SUM(debit),0) d FROM gl_journal_lines WHERE gl_account_id = $1`,
        [f.targetId],
      );
      expect(Number(tgt.rows[0]!.d)).toBeCloseTo(740, 2);

      const after = await c.query<{ d: string; cr: string }>(
        `SELECT COALESCE(SUM(l.debit),0) d, COALESCE(SUM(l.credit),0) cr
           FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
          WHERE l.company_id = $1 AND e.status = 'posted'`,
        [f.companyId],
      );
      expect(Number(after.rows[0]!.d)).toBeCloseTo(Number(before.rows[0]!.d), 2);
      expect(Number(after.rows[0]!.cr)).toBeCloseTo(Number(before.rows[0]!.cr), 2);
    });
  }, 60_000);

  it.skipIf(!reachable)('reparents the children and cascades level through the subtree', async () => {
    await withFixture(async (c, f) => {
      // Move the source's postings out of the way so only the tree work remains.
      await c.query(
        `UPDATE gl_journal_entries SET fiscal_period_id = $1
          WHERE company_id = $2 AND id IN (
            SELECT journal_entry_id FROM gl_journal_lines WHERE gl_account_id = $3)`,
        [f.openPeriodId, f.companyId, f.sourceId],
      );

      const result = await mergeAccounts(f.companyId, f.sourceId, f.targetId);
      expect(result.childAccountsReparented).toBe(1);

      const rows = await c.query<{ id: string; parent_account_id: string | null; level: number }>(
        `SELECT id, parent_account_id, level FROM gl_accounts WHERE id = ANY($1::uuid[]) ORDER BY level`,
        [[f.childId, f.grandchildId]],
      );
      expect(rows.rows[0]!.parent_account_id).toBe(f.targetId);
      expect(rows.rows[0]!.level).toBe(4);
      // The grandchild keeps its parent and shifts by the same delta.
      expect(rows.rows[1]!.parent_account_id).toBe(f.childId);
      expect(rows.rows[1]!.level).toBe(5);

      // The target's OWN child did not move and must not be re-levelled. A
      // cascade seeded from "everything under the target" would shift it too.
      const untouched = await c.query<{ level: number }>(
        'SELECT level FROM gl_accounts WHERE id = $1', [f.targetChildId]);
      expect(untouched.rows[0]!.level).toBe(4);
    });
  }, 60_000);
});

describe('the configuration-reference sweep', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('is driven by the catalogue, so a new FK cannot be missed', async () => {
    assertMergeTestDb();
    const client = await getPoolForTests().connect();
    try {
      const { rows } = await client.query<{ tbl: string; col: string }>(`
        SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
          FROM pg_constraint c
          JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(att, fatt, ord) ON true
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.att
          JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.fatt
         WHERE c.contype = 'f' AND c.confrelid = 'gl_accounts'::regclass AND fa.attname = 'id'
      `);
      // Every FK is either swept or deliberately excluded, and the exclusions
      // are named. A table added tomorrow lands in the sweep with no code change.
      const excluded = rows.filter((r) =>
        CONFIGURATION_REFERENCE_EXCLUSIONS.some((e) => e.table === r.tbl && e.column === r.col));
      expect(excluded).toHaveLength(CONFIGURATION_REFERENCE_EXCLUSIONS.length);
      expect(rows.length).toBeGreaterThan(CONFIGURATION_REFERENCE_EXCLUSIONS.length);
    } finally {
      client.release();
    }
  }, 60_000);
});
