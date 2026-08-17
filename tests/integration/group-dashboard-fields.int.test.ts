// tests/integration/group-dashboard-fields.int.test.ts
//
// `/accounting/group` crashed with "Cannot read properties of undefined
// (reading 'length')" the first time it rendered with a group present: the page
// declared its own response shape with invented field names (`entities` where
// the API returns `entitySummaries`, `combinedCash` where it returns
// `combinedCashPosition`, and `holdingCompanyName` which did not exist at all).
//
// This file replaces an earlier "contract test" that asserted hardcoded fixtures
// against the TypeScript type. Blind review proved that test was decorative:
// reverting the page to the exact original bug left it 8/8 green, while its own
// comment claimed it would fail. A fixture asserted against a type cannot
// detect drift in the SQL that produces the data.
//
// These tests call the REAL service functions against the REAL schema, so they
// catch what tsc cannot: a column renamed in SQL, a join dropped, a GROUP BY
// mistake. The GROUP BY bug introduced while adding `holdingCompanyName` would
// have been caught here — and was, by the sibling group-bootstrap suite.
//
// Note on the division of labour: tsc is the guard for "does the page read the
// right field name" (the page now uses the service's own exported types, so a
// wrong name is a compile error). This file is the guard for "does the service
// actually produce those fields from the database".

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { listGroupsForUser } from '@/modules/accounting/services/reports/groupCrudService';
import { getGroupDashboardStats } from '@/modules/accounting/services/reports/consolidatedReportingService';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required');

const HOLDING = '00000000-0000-0000-0000-0000000d0001';
const SUB = '00000000-0000-0000-0000-0000000d0002';
const GROUP = '00000000-0000-0000-0000-0000000d0090';
const USER = '00000000-0000-0000-0000-0000000d005a';

/** Field names `pages/accounting/group/index.tsx` reads off each payload. */
const STAT_CARD_KEYS = ['combinedCashPosition', 'combinedRevenue', 'combinedARTotal', 'combinedAPTotal'] as const;
const ENTITY_FIELDS = ['companyId', 'companyName', 'revenue', 'expenses', 'netProfit', 'cashPosition'] as const;

describe('group dashboard: the services produce the fields the page renders', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1,'GD Holding Co',true), ($2,'GD Sub Co',true)
       ON CONFLICT (id) DO NOTHING`, [HOLDING, SUB]);
    await admin.query(
      `INSERT INTO users (id, email, account_type) VALUES ($1,'gd@fixture.test','direct')
       ON CONFLICT (id) DO NOTHING`, [USER]);
    await admin.query(
      `INSERT INTO company_users (company_id, user_id, role) VALUES ($1,$3,'owner'), ($2,$3,'owner')
       ON CONFLICT DO NOTHING`, [HOLDING, SUB, USER]);
    // A group WITH a holding company, so holdingCompanyName is exercised non-null.
    await admin.query(
      `INSERT INTO company_groups (id, name, is_active, created_by, holding_company_id)
       VALUES ($1,'GD Fixture Group',true,$2::UUID,$3) ON CONFLICT (id) DO NOTHING`, [GROUP, USER, HOLDING]);
    await admin.query(
      `INSERT INTO company_group_members (group_id, company_id, is_holding)
       SELECT $1, v.c, v.h FROM (VALUES ($2::UUID,true),($3::UUID,false)) AS v(c,h)
       WHERE NOT EXISTS (SELECT 1 FROM company_group_members WHERE group_id=$1 AND company_id=v.c)`,
      [GROUP, HOLDING, SUB]);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM company_group_members WHERE group_id=$1`, [GROUP]);
    await admin.query(`DELETE FROM company_groups WHERE id=$1`, [GROUP]);
    await admin.query(`DELETE FROM company_users WHERE company_id = ANY($1::UUID[])`, [[HOLDING, SUB]]);
    await admin.query(`DELETE FROM users WHERE id=$1`, [USER]);
    await admin.query(`DELETE FROM companies WHERE id = ANY($1::UUID[])`, [[HOLDING, SUB]]);
    await admin.end();
  });

  describe('listGroupsForUser — the group picker', () => {
    it('returns holdingCompanyName resolved from the joined company', async () => {
      const groups = await listGroupsForUser(USER);
      const g = groups.find(x => x.id === GROUP);
      expect(g).toBeDefined();
      // The field the page renders. It did not exist before this fix.
      expect(g?.holdingCompanyName).toBe('GD Holding Co');
    });

    it('returns memberCount, and the join for the name does not inflate it', async () => {
      const g = (await listGroupsForUser(USER)).find(x => x.id === GROUP);
      // 2 members, not 4 — proves the LEFT JOIN companies did not fan out rows.
      expect(g?.memberCount).toBe(2);
    });

    it('leaves holdingCompanyName null when the group has no holding company', async () => {
      await admin.query(`UPDATE company_groups SET holding_company_id = NULL WHERE id=$1`, [GROUP]);
      try {
        const g = (await listGroupsForUser(USER)).find(x => x.id === GROUP);
        expect(g?.holdingCompanyName).toBeNull();
        expect(g?.memberCount).toBe(2);
      } finally {
        await admin.query(`UPDATE company_groups SET holding_company_id=$2 WHERE id=$1`, [GROUP, HOLDING]);
      }
    });
  });

  describe('getGroupDashboardStats — the stat cards and entity table', () => {
    it('produces every stat-card key the page indexes, as a number', async () => {
      const stats = await getGroupDashboardStats(GROUP);
      for (const key of STAT_CARD_KEYS) {
        expect(stats, `missing stat key ${key}`).toHaveProperty(key);
        expect(typeof stats[key]).toBe('number');
      }
    });

    it('names the entity list `entitySummaries` — the field whose absence crashed the page', async () => {
      const stats = await getGroupDashboardStats(GROUP);
      expect(Array.isArray(stats.entitySummaries)).toBe(true);
      expect(stats.entitySummaries).toHaveLength(2);
      // The page passes this straight into GroupEntityTable, which reads .length.
      expect(() => stats.entitySummaries.length).not.toThrow();
    });

    it('every entity row carries the fields the totals reducer and table read', async () => {
      const stats = await getGroupDashboardStats(GROUP);
      for (const e of stats.entitySummaries) {
        for (const f of ENTITY_FIELDS) {
          expect(e, `entity missing ${f}`).toHaveProperty(f);
        }
        expect(typeof e.cashPosition).toBe('number');
      }
    });

    it('the totals the page computes are finite, never NaN', async () => {
      const stats = await getGroupDashboardStats(GROUP);
      const totals = stats.entitySummaries.reduce(
        (a, e) => ({
          revenue: a.revenue + e.revenue, expenses: a.expenses + e.expenses,
          netProfit: a.netProfit + e.netProfit, cashPosition: a.cashPosition + e.cashPosition,
        }),
        { revenue: 0, expenses: 0, netProfit: 0, cashPosition: 0 },
      );
      for (const [k, v] of Object.entries(totals)) {
        expect(Number.isFinite(v), `${k} is not finite`).toBe(true);
      }
    });

    it('covers both member companies, not just the holding one', async () => {
      const stats = await getGroupDashboardStats(GROUP);
      expect(stats.entitySummaries.map(e => e.companyName).sort())
        .toEqual(['GD Holding Co', 'GD Sub Co']);
    });
  });
});
