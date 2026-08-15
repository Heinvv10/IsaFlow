// tests/integration/user-id-join-compat.int.test.ts
//
// `users.id` is character varying. Every column the codebase joins to it must
// therefore be a string too, or be cast explicitly. A uuid column joined
// straight onto users.id throws
//   ERROR: operator does not exist: character varying = uuid
// at runtime — never at compile time, because the SQL is a template string.
//
// Three such joins shipped to production and broke credit-note PDF generation,
// approval listings and practice timesheet reports. These probes execute the
// join shapes against the live schema, so a future schema change that flips one
// of these columns to uuid fails here instead of in production.
//
// `scripts/ci/audit-user-id-casts.ts` is the static half of the same guard;
// this file is the half that catches schema drift the source cannot reveal.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required');

/**
 * Join shapes the production code relies on. `cast` mirrors what the source
 * actually writes — so if the source and this table disagree, one of them is
 * wrong and the probe surfaces it.
 */
const JOINS: Array<{ site: string; table: string; column: string; cast: string }> = [
  // string columns — no cast needed
  { site: 'userAccessService.listCompanyUsers',      table: 'company_users',            column: 'user_id',        cast: '::VARCHAR' },
  { site: 'permissionService / analyticsService',    table: 'company_users',            column: 'user_id',        cast: '' },
  { site: 'bureauService',                           table: 'bureau_users',             column: 'user_id',        cast: '' },
  { site: 'customer-activities',                     table: 'customer_activities',      column: 'created_by',     cast: '' },
  { site: 'supplier-activities',                     table: 'supplier_activities',      column: 'created_by',     cast: '' },
  { site: 'invite/[token]',                          table: 'company_invitations',      column: 'invited_by',     cast: '' },
  { site: 'payrollEmployeeHistoryService',           table: 'payroll_employee_history',  column: 'changed_by',     cast: '' },
  { site: 'auditService',                            table: 'admin_audit_log',          column: 'admin_user_id',  cast: '' },
  // uuid columns — MUST be cast to text (these were the three broken joins)
  { site: 'creditNotePdfBuilder',                    table: 'credit_notes',             column: 'approved_by',    cast: '::TEXT' },
  { site: 'approvalService (requested_by)',          table: 'approval_requests',        column: 'requested_by',   cast: '::TEXT' },
  { site: 'approvalService (decided_by)',            table: 'approval_requests',        column: 'decided_by',     cast: '::TEXT' },
  { site: 'practiceReportsService',                  table: 'time_entries',             column: 'user_id',        cast: '::TEXT' },
];

describe('users.id join compatibility against the live schema', () => {
  let admin: Pool;

  beforeAll(() => { admin = new Pool({ connectionString: DATABASE_URL, max: 2 }); });
  afterAll(async () => { await admin.end(); });

  it('users.id is a string type, not uuid — the premise of every cast below', async () => {
    const { rows } = await admin.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name='users' AND column_name='id'`
    );
    expect(rows[0]?.data_type).toMatch(/character varying|text/);
  });

  it('company_users.user_id is a string type, so its comparisons take no ::UUID cast', async () => {
    const { rows } = await admin.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name='company_users' AND column_name='user_id'`
    );
    expect(rows[0]?.data_type).toMatch(/character varying|text/);
  });

  it.each(JOINS)('$site: users.id = $table.$column$cast executes', async ({ table, column, cast }) => {
    // Throws with "operator does not exist" if the types are incompatible.
    await expect(
      admin.query(`SELECT 1 FROM ${table} t LEFT JOIN users u ON u.id = t.${column}${cast} LIMIT 1`)
    ).resolves.toBeDefined();
  });

  it('proves the probe is real: the same join without ::TEXT on a uuid column fails', async () => {
    await expect(
      admin.query('SELECT 1 FROM credit_notes cn LEFT JOIN users u ON u.id = cn.approved_by LIMIT 1')
    ).rejects.toThrow(/operator does not exist/);
  });

  it('proves the probe is real: a ::UUID cast against company_users.user_id fails', async () => {
    await expect(
      admin.query('SELECT 1 FROM company_users WHERE user_id = $1::UUID LIMIT 1',
        ['00000000-0000-0000-0000-000000000001'])
    ).rejects.toThrow(/operator does not exist/);
  });
});
