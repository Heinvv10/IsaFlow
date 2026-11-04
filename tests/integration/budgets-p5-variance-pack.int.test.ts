/**
 * Budgets P5 T10 (spec §3e, §6 T10, §7), on real PostgreSQL: where approved variance notes print, and
 * where they never do.
 *  - The generated management pack's budget_variance section prints the APPROVED notes of the pack
 *    month's version under the variance table, labelled, escaped by the renderer; never a draft, another
 *    month's, another version's or another company's note, and nothing in any other section.
 *  - The share link and the board pack's page 4 read `report_kind = 'pack'` only: a variance row is absent
 *    even when it is filed under the shared pack's own params_hash (a forged collision), so the kind
 *    filter, not the hash, is what keeps it out.
 * Runs as app_user under forced RLS, as the manual pack route does; the share build runs as the public
 * share path does (the pool connection). Only the AI calls are stubbed.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { als } from '@/lib/als';
import { generateManagementPack } from '@/modules/accounting/services/afs/managementPackGeneratorService';
import { renderSectionContent } from '@/modules/accounting/services/afs/afsHtmlTableRenderer';
import { VARIANCE_NOTES_HEADING } from '@/modules/accounting/services/afs/managementPackVarianceNotes';
import type { AfsSection, ManagementPackConfig, NoteContent } from '@/modules/accounting/services/afs/afsTypes';
import { buildSharedPack } from '@/modules/accounting/services/share/sharedPackService';
import { readPackDraftState } from '@/modules/accounting/services/packs/pages/packDraftState';
import { canonicalParamsHash } from '@/modules/accounting/services/reports/packParamsHash';
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

const bounds: Record<string, [string, string]> = { '2026-08': ['2026-08-01', '2026-08-31'], '2026-09': ['2026-09-01', '2026-09-30'] };

/** One report_commentary row, written by the owner role before the request drops to app_user. */
function note(c: PoolClient, o: { co?: string; kind?: string; hash: string; month?: string; rowRef: string; text: string; approved: boolean }) {
  const [start, end] = bounds[o.month ?? '2026-09']!;
  return c.query(
    `INSERT INTO report_commentary (company_id, report_kind, params_hash, period_start, period_end, section_ref, row_ref,
       draft_text, approved_text, status, generated_by, approved_by, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'human:u', $11, $12)`,
    [o.co ?? f.a, o.kind ?? 'budget_variance', o.hash, start, end, o.kind === 'pack' ? 'income_statement' : 'account', o.rowRef,
      o.approved ? `draft of ${o.text}` : o.text, o.approved ? o.text : null, o.approved ? 'approved' : 'draft',
      o.approved ? 'owner' : null, o.approved ? new Date() : null]);
}

describe('the management pack prints approved variance notes under the variance table', () => {
  const config = (): ManagementPackConfig => ({
    id: '', companyId: f.a, enabled: true, generationDay: 5, deliveryDay: 10, reviewRequired: true,
    sectionsEnabled: { income_statement: true, income_vs_budget: true, budget_variance: true },
    recipients: [], packStyle: 'detailed', comparisonMode: 'budget', currencyDisplay: 'full',
  });

  it('the pack month\'s approved notes of its version only, labelled and escaped; no draft, no other month, version or company', async () => {
    const sept = varianceParamsHash(f.v.primary27, '2026-09');
    const seed = async (c: PoolClient) => {
      await note(c, { hash: sept, rowRef: `${f.acc.opex}|||`, text: 'Rent <script>alert(1)</script> & rates rose.', approved: true });
      await note(c, { hash: sept, rowRef: `${f.acc.sales}||${f.cc.P1}|`, text: 'Project 1 billed late.', approved: true });
      await note(c, { hash: sept, rowRef: `${f.acc.cos}|${f.cc.FT}||`, text: 'DRAFT SECRET', approved: false });
      await note(c, { hash: varianceParamsHash(f.v.primary27, '2026-08'), month: '2026-08', rowRef: `${f.acc.opex}|||`, text: 'AUGUST', approved: true });
      await note(c, { hash: varianceParamsHash(f.v.reforecast27, '2026-09'), rowRef: `${f.acc.sales}|||`, text: 'REFORECAST', approved: true });
      await note(c, { co: f.b, hash: sept, rowRef: `${f.acc.bSales}|||`, text: 'B SECRET', approved: true });
      // A withdrawn approval: back to draft, the approval columns kept (612). Only the status says it is not published.
      await c.query(`INSERT INTO report_commentary (company_id, report_kind, params_hash, period_start, period_end, section_ref, row_ref,
        draft_text, approved_text, status, generated_by, approved_by, approved_at, withdrawn_by, withdrawn_at)
        VALUES ($1, 'budget_variance', $2, '2026-09-01', '2026-09-30', 'account', $3, 'redraft', 'WITHDRAWN SECRET', 'draft', 'human:u',
          'owner', now(), 'owner', now())`, [f.a, sept, `${f.acc.fin}|||${f.bu.B1}`]);
    };
    const sections = await asRequest(pool, f.a, f.userA, async () => {
      const { documentId } = await generateManagementPack({ companyId: f.a, period: '2026-09', config: config(), triggeredBy: 'manual' });
      const rows = await sql`
        SELECT section_type, content FROM afs_sections WHERE document_id = ${documentId}::UUID AND company_id = ${f.a}::UUID
      ` as { section_type: string; content: NoteContent }[];
      return new Map(rows.map((r) => [r.section_type, r.content]));
    }, { appUser: true, before: seed });

    const variance = sections.get('budget_variance')!;
    const kinds = variance.blocks.map((b) => b.type);
    const heading = variance.blocks.findIndex((b) => b.type === 'heading' && b.text === VARIANCE_NOTES_HEADING);
    expect(kinds.indexOf('table')).toBeGreaterThanOrEqual(0);
    expect(heading).toBe(kinds.indexOf('table') + 1);
    const list = variance.blocks[heading + 1];
    expect(list?.type === 'list' && list.items).toEqual([
      'BT-4000 Sales · BT-P1 Project 1: Project 1 billed late.',
      'BT-6000 Opex: Rent <script>alert(1)</script> & rates rose.',
    ]);
    const html = renderSectionContent({ id: 'bv', content: variance, overrides: null } as unknown as AfsSection);
    expect(html).toContain('Rent &lt;script&gt;alert(1)&lt;/script&gt; &amp; rates rose.');
    expect(html).not.toContain('<script>');
    for (const [type, content] of sections) {
      const text = JSON.stringify(content);
      for (const secret of ['DRAFT SECRET', 'WITHDRAWN SECRET', 'AUGUST', 'REFORECAST', 'B SECRET', 'draft of']) expect(text, `${type}: ${secret}`).not.toContain(secret);
      if (type !== 'budget_variance') expect(text, type).not.toContain('Project 1 billed late');
    }
  });
});

describe('the scheduled pack (cron) reads the approved notes on the service pool', () => {
  // scripts/isaflow-management-packs.timer → POST /api/accounting/afs/cron/management-packs (no withAuth) →
  // packSchedulerService.runDailyScheduler → generateManagementPack(triggeredBy 'cron'): bare `sql` on the
  // pool, which logs in as isaflow_service (inherits app_service; migration 915), with NO claims and no
  // company GUC. app_service sees report_commentary through the app_service_<cmd> mirrors that
  // app_service_sync_policies() keeps (every migration run). Here: one client, SET ROLE isaflow_service, no
  // claims set, so every query the generator makes runs as the cron's role.
  it('as isaflow_service with no claims, the budget_variance section prints the approved note', async () => {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      await note(client, { hash: varianceParamsHash(f.v.primary27, '2026-09'), rowRef: `${f.acc.opex}|||`, text: 'CRON NOTE', approved: true });
      await client.query('SET LOCAL ROLE isaflow_service');
      expect((await client.query("SELECT current_setting('request.jwt.claims', true) AS c")).rows[0].c ?? '').toBe('');
      const sections = await als.run({ client, userId: 'cron', claims: {} }, async () => {
        const { documentId } = await generateManagementPack({ companyId: f.a, period: '2026-09', config: {
          id: '', companyId: f.a, enabled: true, generationDay: 5, deliveryDay: 10, reviewRequired: true,
          sectionsEnabled: { budget_variance: true }, recipients: [], packStyle: 'detailed', comparisonMode: 'budget', currencyDisplay: 'full',
        }, triggeredBy: 'cron' });
        return await sql`SELECT section_type, content FROM afs_sections WHERE document_id = ${documentId}::UUID AND company_id = ${f.a}::UUID` as
          { section_type: string; content: NoteContent }[];
      });
      const variance = sections.find((r) => r.section_type === 'budget_variance')!.content;
      expect(variance.blocks.some((b) => b.type === 'table')).toBe(true); // the budget itself was readable too
      expect(variance.blocks).toContainEqual({ type: 'list', items: ['BT-6000 Opex: CRON NOTE'] });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('a variance row never reaches the share link or the board pack page 4', () => {
  const PARAMS = { type: 'board', from: '2026-09-01', to: '2026-09-30' } as const;

  it('even filed under the shared pack\'s own params_hash, only the pack row is published', async () => {
    const hash = canonicalParamsHash(PARAMS);
    const seed = async (c: PoolClient) => {
      await note(c, { kind: 'pack', hash, rowRef: 'revenue', text: 'PACK SENTENCE', approved: true });
      await note(c, { hash, rowRef: `${f.acc.opex}|||`, text: 'VARIANCE COLLISION', approved: true });
      await note(c, { hash: varianceParamsHash(f.v.primary27, '2026-09'), rowRef: `${f.acc.sales}|||`, text: 'VARIANCE NOTE', approved: true });
    };
    const shared = await asRequest(pool, f.a, f.userA, () => buildSharedPack({ id: crypto.randomUUID(), companyId: f.a, params: PARAMS }), { before: seed });
    expect(shared.commentary.map((c) => c.text)).toEqual(['PACK SENTENCE']);

    const page4 = await asRequest(pool, f.a, f.userA, () => readPackDraftState(f.a, 'board', PARAMS.from, PARAMS.to), { appUser: true, before: seed });
    expect(page4.commentary?.body).toBe('PACK SENTENCE');
  });
});
