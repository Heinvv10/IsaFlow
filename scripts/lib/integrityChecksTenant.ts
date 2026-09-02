/**
 * Tenant-isolation + balance-cache integrity checks.
 *
 * Added 2026-06-21 from financial-integrity-loop findings:
 *  - cross-tenant GL line -> account (guards the class fixed in PR #186)
 *  - journal line company_id must equal its parent entry's company_id
 *  - reversal pairs must net to zero per account
 *  - gl_account_balances cache drift (advisory: the cache is trigger-maintained
 *    and not refreshed on draft->posted; see AFS fix PR #187)
 */
import type { CheckResult, IntegrityCheck, IntegritySql } from './integrityTypes';
import { plural } from './integrityTypes';

export const tenantChecks: IntegrityCheck[] = [
  // 9b — Exactly one system account per resolved role, and its type must fit.
  // systemAccountResolver hands these rows to every auto-posting path; a
  // duplicate made the winner depend on heap order (found in prod 2026-09-02,
  // migration 525), and a mistyped row (a liability flagged vat_input) posts
  // VAT to the wrong side of the balance sheet.
  async (sql: IntegritySql): Promise<CheckResult> => {
    const rows = (await sql`
      WITH legal(account_type, account_subtype) AS (
        VALUES ('asset','bank'), ('asset','receivable'), ('asset','vat_input'),
               ('asset','accumulated_depreciation'), ('liability','payable'),
               ('liability','vat_output'), ('equity','retained_earnings'),
               ('equity','opening_balance_equity'), ('revenue','default_revenue'),
               ('revenue','other_income'), ('expense','default_expense'),
               ('expense','admin_expense'), ('expense','depreciation_expense')
      ),
      sys AS (
        SELECT g.company_id, g.account_subtype, g.account_code, g.account_name, g.account_type,
               EXISTS (SELECT 1 FROM legal l WHERE l.account_type = g.account_type
                                               AND l.account_subtype = g.account_subtype) AS fits
        FROM gl_accounts g
        WHERE g.is_system_account = true AND g.is_active = true
          AND g.account_subtype IN (SELECT account_subtype FROM legal)
      )
      SELECT s.company_id, s.account_subtype, s.account_code, s.account_name, s.account_type,
             CASE WHEN NOT s.fits THEN 'type mismatch' ELSE 'duplicate' END AS problem
      FROM sys s
      WHERE NOT s.fits
         OR (SELECT COUNT(*) FROM sys d
             WHERE d.company_id = s.company_id AND d.account_subtype = s.account_subtype) > 1
      ORDER BY s.company_id, s.account_subtype, s.account_code
      LIMIT 40
    `) as Array<Record<string, string>>;
    if (rows.length === 0) {
      return { label: 'One system account per role', status: 'pass', detail: '0 duplicate or mistyped system accounts' };
    }
    return {
      label: 'One system account per role', status: 'fail',
      detail: `${rows.length} system ${plural(rows.length, 'row', 'rows')} share a role with another or carry a subtype their type cannot`,
      lines: rows.map((r) => `co=${String(r.company_id).slice(0, 8)}  ${r.account_subtype}: ${r.account_code} ${r.account_name} (${r.account_type}) — ${r.problem}`),
    };
  },

  // 10 — Journal line references a GL account owned by a different company
  async (sql: IntegritySql): Promise<CheckResult> => {
    const rows = (await sql`
      SELECT jl.id, jl.company_id AS line_company, a.company_id AS account_company,
             a.account_code, a.account_name
      FROM gl_journal_lines jl
      JOIN gl_accounts a ON a.id = jl.gl_account_id
      WHERE a.company_id IS DISTINCT FROM jl.company_id
      LIMIT 20
    `) as Array<Record<string, string>>;
    if (rows.length === 0) return { label: 'GL line → same-tenant account', status: 'pass', detail: "0 lines reference another tenant's account" };
    return {
      label: 'GL line → same-tenant account', status: 'fail',
      detail: `${rows.length} ${plural(rows.length, 'line', 'lines')} reference a GL account owned by a different company`,
      lines: rows.map((r) => `line=${String(r.id).slice(0, 8)}  line_co=${String(r.line_company).slice(0, 8)}  acct=${r.account_code} ${r.account_name} (co ${String(r.account_company).slice(0, 8)})`),
    };
  },

  // 11 — Journal line company_id must match its parent entry's company_id
  async (sql: IntegritySql): Promise<CheckResult> => {
    const [row] = (await sql`
      SELECT COUNT(*)::int AS cnt
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.company_id IS DISTINCT FROM je.company_id
    `) as Array<{ cnt: number }>;
    const cnt = row?.cnt ?? 0;
    return cnt === 0
      ? { label: 'Line company = entry company', status: 'pass', detail: "0 lines disagree with their entry's company" }
      : { label: 'Line company = entry company', status: 'fail', detail: `${cnt} ${plural(cnt, 'line', 'lines')} have company_id ≠ parent entry` };
  },

  // 12 — Reversal pairs must net to zero per account (original + reversal)
  async (sql: IntegritySql): Promise<CheckResult> => {
    const [row] = (await sql`
      WITH pair AS (
        SELECT r.id AS rid, r.reversal_of_id AS oid
        FROM gl_journal_entries r WHERE r.reversal_of_id IS NOT NULL
      ),
      combined AS (
        SELECT p.rid, jl.gl_account_id, ROUND(SUM(jl.debit - jl.credit), 2) AS net
        FROM pair p
        JOIN gl_journal_lines jl ON jl.journal_entry_id IN (p.rid, p.oid)
        GROUP BY p.rid, jl.gl_account_id
      )
      SELECT COUNT(DISTINCT rid)::int AS cnt FROM combined WHERE net <> 0
    `) as Array<{ cnt: number }>;
    const cnt = row?.cnt ?? 0;
    return cnt === 0
      ? { label: 'Reversal pairs net to zero', status: 'pass', detail: '0 reversal pairs with a residual balance' }
      : { label: 'Reversal pairs net to zero', status: 'fail', detail: `${cnt} reversal ${plural(cnt, 'pair', 'pairs')} do not net to zero per account` };
  },

  // 13 — gl_account_balances cache drift vs posted journal lines (advisory).
  //      The cache is maintained by a gl_journal_lines trigger that is never
  //      refreshed on draft->posted, so it drifts. Reported as INFO so it does
  //      not gate CI; AFS reads source-of-truth directly after PR #187.
  async (sql: IntegritySql): Promise<CheckResult> => {
    const [row] = (await sql`
      WITH actual AS (
        SELECT jl.gl_account_id, je.fiscal_period_id AS fp,
               ROUND(SUM(jl.debit), 2) dr, ROUND(SUM(jl.credit), 2) cr
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        WHERE je.status = 'posted' AND je.fiscal_period_id IS NOT NULL
        GROUP BY jl.gl_account_id, je.fiscal_period_id
      ),
      cached AS (
        SELECT gl_account_id, fiscal_period_id AS fp,
               ROUND(debit_total, 2) dr, ROUND(credit_total, 2) cr
        FROM gl_account_balances
      )
      -- FULL OUTER JOIN: 'missing' = actual rows with no cache row (left-only);
      -- 'stale' = cache rows with no posted lines (right-only, non-zero);
      -- 'mismatched' = both present but totals differ.
      SELECT
        COUNT(*) FILTER (WHERE c.fp IS NOT NULL AND a.fp IS NOT NULL AND (c.dr <> a.dr OR c.cr <> a.cr))::int AS mismatched,
        COUNT(*) FILTER (WHERE a.fp IS NOT NULL AND c.fp IS NULL)::int AS missing,
        COUNT(*) FILTER (WHERE c.fp IS NOT NULL AND a.fp IS NULL AND (c.dr <> 0 OR c.cr <> 0))::int AS stale
      FROM actual a
      FULL OUTER JOIN cached c ON c.gl_account_id = a.gl_account_id AND c.fp = a.fp
    `) as Array<{ mismatched: number; missing: number; stale: number }>;
    const m = row ?? { mismatched: 0, missing: 0, stale: 0 };
    const total = m.mismatched + m.missing + m.stale;
    return {
      label: 'Balance-cache drift (advisory)', status: 'info',
      lines: [
        `gl_account_balances vs posted journal lines: ${m.missing} missing, ${m.stale} stale, ${m.mismatched} mismatched (${total} total)`,
        total === 0 ? 'cache is consistent' : 'cache is trigger-maintained and not refreshed on draft→posted — reports/AFS should read journal lines directly',
      ],
    };
  },
];
