/**
 * D4 round 8, against Postgres: consolidated-reports create-elimination accepts a line only if
 * its groupAccountId is in getGroupAccounts(groupId). That owner returns this group's ACTIVE
 * accounts only — never another group's, never a deactivated one. Temp table, rolled back.
 */
import { describe, expect, it, vi } from 'vitest';
import { als } from '@/lib/als';
import { getPoolForTests, sql } from '@/lib/neon';
import { getGroupAccounts } from '@/modules/accounting/services/reports/groupCompanyService';
import { isDbReachable } from '../../helpers/dbReachable';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const A = '80000000-0000-4000-8000-000000000001';
const B = '80000000-0000-4000-8000-000000000002';
const id = (n: number) => `81000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('getGroupAccounts — own group, active only (Postgres)', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('returns group A\'s active accounts and nothing of group B', async () => {
    assertNotProductionDb('group accounts ownership');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      await als.run({ client, companyId: '', userId: '', claims: {} }, async () => {
        await sql`CREATE TEMP TABLE group_accounts (id uuid, group_id uuid, account_code text, account_name text,
          account_type text, account_subtype text, parent_account_id uuid, normal_balance text, level int,
          display_order int, is_active boolean, created_at timestamptz DEFAULT now()) ON COMMIT DROP`;
        await sql`INSERT INTO group_accounts (id, group_id, account_code, account_name, account_type, normal_balance, level, display_order, is_active) VALUES
          (${id(1)}::uuid, ${A}::uuid, 'G4000', 'Revenue', 'revenue', 'credit', 1, 1, true),
          (${id(2)}::uuid, ${A}::uuid, 'G5000', 'Expense', 'expense', 'debit', 1, 2, true),
          (${id(3)}::uuid, ${A}::uuid, 'G9000', 'Old', 'expense', 'debit', 1, 3, false),
          (${id(4)}::uuid, ${B}::uuid, 'G4000', 'Revenue', 'revenue', 'credit', 1, 1, true)`;
        expect((await getGroupAccounts(A)).map(a => a.id).sort()).toEqual([id(1), id(2)]);
        expect((await getGroupAccounts(B)).map(a => a.id)).toEqual([id(4)]);
      });
    } finally {
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    }
  });
});
