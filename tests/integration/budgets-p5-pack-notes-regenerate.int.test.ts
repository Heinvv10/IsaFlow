/**
 * Budgets P5 §9, prod acceptance 2026-11-06. An approved variance note must reach the management pack:
 * - with budget_variance off (the default) it prints under Income vs Budget, and not twice when both are on;
 * - in a month with no budget it prints under the "No budget" sentence;
 * and a month's draft pack can be rebuilt, while a signed-off pack and another company's stay.
 * Real generator as app_user, real PostgreSQL. Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { DuplicatePackError, generateManagementPack } from '@/modules/accounting/services/afs/managementPackGeneratorService';
import { PackNotReplaceableError } from '@/modules/accounting/services/afs/managementPackExisting';
import type { ManagementPackConfig, NoteContent } from '@/modules/accounting/services/afs/afsTypes';
import { varianceParamsHash } from '@/modules/accounting/services/reports/varianceParamsHash';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';

vi.mock('@/modules/accounting/services/afs/packAiSummaryService', () => ({
  generateExecutiveSummary: vi.fn(async () => 'summary'),
  generateSectionCommentary: vi.fn(async () => 'commentary'),
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;

beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM report_commentary WHERE company_id = ANY($1::UUID[])', [[f.a, f.b]]);
    await dropTrackingFixture(pool, f);
  } finally { await pool.end(); }
});

const NOTE = 'Rent rose in the month.';
const approvedNote = (c: PoolClient, month: string) => c.query(
  `INSERT INTO report_commentary (company_id, report_kind, params_hash, period_start, period_end, section_ref, row_ref,
     draft_text, approved_text, status, generated_by, approved_by, approved_at)
   VALUES ($1, 'budget_variance', $2, $3::DATE, ($3::DATE + INTERVAL '1 month - 1 day')::DATE, 'account', $4, $5, $5, 'approved', 'human:u', 'owner', now())`,
  [f.a, varianceParamsHash(f.v.primary27, month), `${month}-01`, `${f.acc.opex}|||`, NOTE]);

const config = (sectionsEnabled: Record<string, boolean>): ManagementPackConfig => ({
  id: '', companyId: f.a, enabled: true, generationDay: 5, deliveryDay: 10, reviewRequired: true,
  sectionsEnabled, recipients: [], packStyle: 'detailed', comparisonMode: 'budget', currencyDisplay: 'full',
});
const sectionsOf = async (documentId: string) => {
  const rows = await sql`SELECT section_type, content FROM afs_sections WHERE document_id = ${documentId}::UUID AND company_id = ${f.a}::UUID` as { section_type: string; content: NoteContent }[];
  return new Map(rows.map((r) => [r.section_type, JSON.stringify(r.content)]));
};
const pack = async (sections: Record<string, boolean>, before: (c: PoolClient) => Promise<unknown>, month = '2026-09') =>
  asRequest(pool, f.a, f.userA, async () => {
    const { documentId } = await generateManagementPack({ companyId: f.a, period: month, config: config(sections), triggeredBy: 'manual' });
    return sectionsOf(documentId);
  }, { appUser: true, before: async (c) => { await before(c); } });

describe('an approved variance note reaches the pack', () => {
  it('under Income vs Budget when budget_variance is off', async () => {
    const out = await pack({ income_vs_budget: true }, (c) => approvedNote(c, '2026-09'));
    expect(out.get('income_vs_budget')).toContain(NOTE);
    expect(out.has('budget_variance')).toBe(false);
  });

  it('once, under Budget Variance, when both are on', async () => {
    const out = await pack({ income_vs_budget: true, budget_variance: true }, (c) => approvedNote(c, '2026-09'));
    expect(out.get('budget_variance')).toContain(NOTE);
    expect(out.get('income_vs_budget')).not.toContain(NOTE);
  });

  it('nowhere when neither budget section is on', async () => {
    const out = await pack({ income_statement: true }, (c) => approvedNote(c, '2026-09'));
    expect([...out.values()].join()).not.toContain(NOTE);
  });

  it('under the "No budget" sentence in a month the version has no budget for', async () => {
    const out = await pack({ income_vs_budget: true, budget_variance: true }, async (c) => {
      // An approved version's rows are frozen by trigger; the request's transaction is rolled back.
      await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(`DELETE FROM budget_month_amounts WHERE version_id = $1 AND month = '2026-10-01'`, [f.v.primary27]);
      await c.query(`SET LOCAL session_replication_role = origin`);
      await approvedNote(c, '2026-10');
    }, '2026-10');
    const printed = out.get('budget_variance')!;
    expect(printed).toContain('No budget for FY2027');
    expect(printed.indexOf(NOTE)).toBeGreaterThan(printed.indexOf('No budget for FY2027'));
  });
});

describe('rebuilding a month\'s pack', () => {
  const documents = (co: string) => sql`SELECT id::TEXT AS id FROM afs_documents
    WHERE company_id = ${co}::UUID AND document_type = 'management_pack' AND period = '2026-08'` as Promise<{ id: string }[]>;
  const generate = (replace?: boolean, sections: Record<string, unknown> = {}) => generateManagementPack({
    companyId: f.a, period: '2026-08', config: { ...config({ income_vs_budget: true }), ...sections }, triggeredBy: 'manual', replaceDraft: replace ? { actorUserId: f.userA } : undefined,
  });

  it('refuses without the flag; with it, replaces the draft and its sections, and shows a note approved since', async () => {
    await asRequest(pool, f.a, f.userA, async () => {
      const first = await generate();
      await expect(generate()).rejects.toBeInstanceOf(DuplicatePackError);
      const second = await generate(true);
      expect(second.documentId).not.toBe(first.documentId);
      expect((await documents(f.a)).map((d) => d.id)).toEqual([second.documentId]);
      const orphans = await sql`SELECT 1 FROM afs_sections WHERE document_id = ${first.documentId}::UUID` as unknown[];
      expect(orphans).toEqual([]);
    }, { appUser: true });
  });

  it('never replaces a pack that is not an unlocked draft', async () => {
    await asRequest(pool, f.a, f.userA, async () => {
      const first = await generate();
      await sql`UPDATE afs_documents SET status = 'signed_off' WHERE id = ${first.documentId}::UUID AND company_id = ${f.a}::UUID`;
      await expect(generate(true)).rejects.toBeInstanceOf(DuplicatePackError);
      expect((await documents(f.a)).map((d) => d.id)).toEqual([first.documentId]);
    }, { appUser: true });
  });

  const refusedAfter = (act: (doc: string) => Promise<unknown>, why: RegExp) => asRequest(pool, f.a, f.userA, async () => {
    const first = await generate();
    await act(first.documentId);
    await expect(generate(true)).rejects.toThrow(why);
    await expect(generate(true)).rejects.toBeInstanceOf(PackNotReplaceableError);
    expect((await documents(f.a)).map((d) => d.id)).toEqual([first.documentId]);
  }, { appUser: true });

  it('refuses a draft with a reviewed section', () => refusedAfter((doc) => sql`
    UPDATE afs_sections SET reviewed_by = ${f.userA}, reviewed_at = now() WHERE document_id = ${doc}::UUID AND company_id = ${f.a}::UUID`, /reviewed or signed off/));

  it('refuses a draft with a signed-off section', () => refusedAfter((doc) => sql`
    UPDATE afs_sections SET signed_off_by = ${f.userA}, signed_off_at = now() WHERE document_id = ${doc}::UUID AND company_id = ${f.a}::UUID`, /reviewed or signed off/));

  it('refuses a draft with a comment', () => refusedAfter(async (doc) => {
    const [section] = await sql`SELECT id FROM afs_sections WHERE document_id = ${doc}::UUID AND company_id = ${f.a}::UUID LIMIT 1` as { id: string }[];
    await sql`INSERT INTO afs_section_comments (section_id, company_id, author_id, body) VALUES (${section!.id}::UUID, ${f.a}::UUID, ${f.userA}, 'Check this')`;
  }, /has comments/));

  it('refuses a draft emailed for that month, not one whose email failed or was another month\'s', async () => {
    const mail = (subject: string, status: string) => sql`INSERT INTO email_log (company_id, recipient_email, subject, email_type, status)
      VALUES (${f.a}::UUID, 'a@example.com', ${subject}, 'other', ${status})`;
    await asRequest(pool, f.a, f.userA, async () => {
      await generate();
      await mail('Co — Management Accounts 2026-08', 'failed');
      await mail('Co — Management Accounts 2026-07', 'sent');
      const second = await generate(true);
      await mail('Co — Management Accounts 2026-08', 'sent');
      await expect(generate(true)).rejects.toThrow(/has been emailed/);
      expect((await documents(f.a)).map((d) => d.id)).toEqual([second.documentId]);
    });
  });

  it('sees the sent email as the request\'s own role does (app_user, RLS on email_log)', async () => {
    await asRequest(pool, f.a, f.userA, async () => {
      await generate();
      await expect(generate(true)).rejects.toThrow(/has been emailed/);
    }, {
      appUser: true,
      before: (c) => c.query(`INSERT INTO email_log (company_id, recipient_email, subject, email_type, status)
        VALUES ($1, 'a@example.com', 'Co — Management Accounts 2026-08', 'other', 'sent')`, [f.a]),
    });
  });

  it('holds the rebuilt pack for review even with review off and recipients set, and audits the replacement', async () => {
    await asRequest(pool, f.a, f.userA, async () => {
      const first = await generate();
      const rebuilt = await generate(true, { reviewRequired: false, recipients: [{ name: 'A', email: 'a@example.com', receives: 'both' }] });
      expect(rebuilt).toMatchObject({ status: 'draft', deliveryScheduled: false });
      const audit = await sql`SELECT user_id::TEXT AS user_id, action FROM audit_log
        WHERE company_id = ${f.a}::UUID AND entity_type = 'management_pack' AND entity_id = ${first.documentId}::UUID` as { user_id: string; action: string }[];
      expect(audit).toEqual([{ user_id: f.userA, action: 'delete' }]);
    }, { appUser: true });
  });

  it('leaves another company\'s draft of the same month', async () => {
    const other = String((await pool.query(
      `INSERT INTO afs_documents (company_id, fiscal_year, period, document_type, reporting_framework, status)
       VALUES ($1, 2027, '2026-08', 'management_pack', 'ifrs_smes', 'draft') RETURNING id`, [f.b])).rows[0].id);
    try {
      // Not as app_user: RLS would hide the row, and this is about the query's own company filter (the cron's role has no claims).
      const seen = await asRequest(pool, f.a, f.userA, async () => {
        await generate(true);
        return sql`SELECT 1 FROM afs_documents WHERE id = ${other}::UUID` as Promise<unknown[]>;
      });
      expect(seen).toHaveLength(1);
    } finally {
      await pool.query('DELETE FROM afs_documents WHERE id = $1', [other]);
    }
  });
});
