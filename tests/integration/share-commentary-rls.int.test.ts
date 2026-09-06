// tests/integration/share-commentary-rls.int.test.ts
/**
 * Two properties, both of which a unit test cannot establish:
 *  1. Under RLS (role app_user, GUCs set for tenant A), tenant A sees zero of
 *     tenant B's share links, commentary and annotations, and cannot write a
 *     row into tenant B's company.
 *  2. A share page renders APPROVED text only. A draft on the same pack, for
 *     the same period, is absent from buildSharedPack's output.
 *
 * Deliberately fails (not skips) without a real DATABASE_URL — same convention
 * as share-link-lifecycle.int.test.ts and statement-grid-foots.int.test.ts.
 *
 * A third property is pinned here too: `shareResolver`'s public path runs on
 * the pool connection (a superuser that bypasses RLS — see the file header in
 * shareResolver.ts), not as `app_user`. `resolveShareLink` still returns 'ok'
 * with no tenant GUC set at all. That is the documented, intended shape — RLS
 * is the second line of defence for this feature, not the first, because an
 * unauthenticated visitor has no session to carry a GUC — so the test below
 * pins the CURRENT behaviour rather than assuming it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createShareLink } from '@/modules/accounting/services/share/shareLinkService';
import { resolveShareLink, commitShareView } from '@/modules/accounting/services/share/shareResolver';
import { buildSharedPack } from '@/modules/accounting/services/share/sharedPackService';
import { canonicalParamsHash } from '@/modules/accounting/services/reports/packParamsHash';
import { generateDrafts } from '@/modules/accounting/services/commentary/commentaryService';
import type { ManagementPackData } from '@/modules/accounting/services/reports/aiCommentaryService';
import { hashShareToken } from '@/modules/accounting/services/share/shareToken';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL || DATABASE_URL.includes('dummy.neon.tech')) {
  throw new Error('share-commentary-rls requires DATABASE_URL; it does not skip');
}

const CA = '00000000-0000-0000-0000-0000000054aa';
const CB = '00000000-0000-0000-0000-0000000054bb';
const UA = 'ws3-rls-user-A';
const UB = 'ws3-rls-user-B';
const PARAMS = { type: 'board', from: '2026-03-01', to: '2026-08-31' } as const;

let admin: Pool;

// Every ip/token combination this file hands to resolveShareLink charges a
// row in rate_limit_counters (see withinRateLimits in shareResolver.ts).
// Tracked here so afterAll can delete exactly those rows — scoped by fixture
// key, never a pattern DELETE that could touch a concurrent worktree's rows
// against the same isaflow_dev database.
const RESOLVE_IPS = ['203.0.113.10', '203.0.113.11'];
const resolvedTokens: string[] = [];
async function resolve(token: string, ctx: { ip: string; userAgent: string }) {
  resolvedTokens.push(token);
  return resolveShareLink(token, ctx);
}

beforeAll(async () => {
  admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
  await admin.query(`INSERT INTO companies (id,name,is_active) VALUES ($1,'WS3R-A',true),($2,'WS3R-B',true) ON CONFLICT (id) DO NOTHING`, [CA, CB]);
  await admin.query(`INSERT INTO users (id,email,is_active) VALUES ($1,'r-a@test.local',true),($2,'r-b@test.local',true) ON CONFLICT (id) DO NOTHING`, [UA, UB]);
  await admin.query(`INSERT INTO company_users (company_id,user_id,role) VALUES ($1,$3,'admin'),($2,$4,'admin') ON CONFLICT DO NOTHING`, [CA, CB, UA, UB]);

  const hash = canonicalParamsHash(PARAMS);
  // Tenant B: one link, one approved commentary, one annotation, and one
  // recorded view — without a view row here, the share_link_views leg of the
  // read-isolation loop below is vacuous (COUNT is 0 for tenant B regardless
  // of RLS, since tenant B never has any row to leak). commitShareView is the
  // real function the public page calls after a successful resolve.
  const { link: linkB } = await createShareLink({ companyId: CB, userId: UB, params: PARAMS });
  await commitShareView({ id: linkB.id, companyId: CB }, { ip: '203.0.113.20', userAgent: 'vitest-setup' });
  await admin.query(
    `INSERT INTO report_commentary (company_id, report_kind, params_hash, period_start, period_end, section_ref, row_ref, draft_text, approved_text, status, generated_by, approved_by, approved_at)
     VALUES ($1,'pack',$2,'2026-03-01','2026-08-31','income_statement','revenue','B DRAFT','B APPROVED','approved',$3,$3,NOW())`,
    [CB, hash, UB]);
  await admin.query(
    `INSERT INTO report_annotations (company_id,row_id,period_start,period_end,body,author)
     VALUES ($1,'line:4000','2026-03-01','2026-08-31','B NOTE',$2)`, [CB, UB]);
});

afterAll(async () => {
  for (const t of ['share_link_views', 'share_links', 'report_commentary', 'report_annotations']) {
    await admin.query(`DELETE FROM ${t} WHERE company_id IN ($1,$2)`, [CA, CB]);
  }
  await admin.query(`DELETE FROM company_users WHERE user_id IN ($1,$2)`, [UA, UB]);
  await admin.query(`DELETE FROM users WHERE id IN ($1,$2)`, [UA, UB]);
  await admin.query(`DELETE FROM companies WHERE id IN ($1,$2)`, [CA, CB]);
  const rateLimitKeys = [
    ...RESOLVE_IPS.map((ip) => `share:ip:${ip}`),
    ...resolvedTokens.map((t) => `share:token:${hashShareToken(t)}`),
  ];
  await admin.query(`DELETE FROM rate_limit_counters WHERE key = ANY($1)`, [rateLimitKeys]);
  await admin.end();
});

describe('RLS on the WS3 tables', () => {
  it('tenant A reads none of tenant B rows on any of the four tables', async () => {
    const client = await admin.connect();
    let inTx = false;
    try {
      await client.query('BEGIN');
      inTx = true;
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: UA })]);
      await client.query(`SELECT set_config('app.current_company_id',$1,true)`, [CA]);
      for (const t of ['share_links', 'share_link_views', 'report_commentary', 'report_annotations']) {
        const r = await client.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM public."${t}" WHERE company_id = $1::uuid`, [CB]);
        expect(r.rows[0]!.c, `${t} leaked tenant B rows to tenant A`).toBe(0);
      }
    } finally {
      // ROLLBACK must run even when an assertion above throws — otherwise the
      // client is released back to the pool with the transaction still open
      // (holding SET LOCAL ROLE app_user and the GUCs), and afterAll's DELETEs,
      // run over a DIFFERENT connection, never see this one's uncommitted work
      // and appear to silently lose the fixture cleanup.
      if (inTx) await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('tenant A cannot INSERT a share link for tenant B', async () => {
    const client = await admin.connect();
    let inTx = false;
    try {
      await client.query('BEGIN');
      inTx = true;
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: UA })]);
      await client.query(`SELECT set_config('app.current_company_id',$1,true)`, [CA]);
      await expect(client.query(
        `INSERT INTO share_links (company_id, report_kind, params, token_hash, created_by)
         VALUES ($1,'pack','{}'::jsonb,'deadbeef',$2)`, [CB, UA])).rejects.toThrow();
    } finally {
      if (inTx) await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('resolveShareLink depends on the pool\'s superuser role, not app_user — it never switches role, and would fail here if that role could not bypass RLS', async () => {
    // Pins the documented dependency in shareResolver.ts: the public resolve
    // path runs on the pool's superuser connection, which bypasses RLS by
    // design, because an unauthenticated visitor has no session to carry a
    // company GUC. This test never issues SET LOCAL ROLE app_user at all —
    // it calls the real service exactly as the public share page does, on
    // the plain pool connection — so a future change that routed this path
    // through a restricted role would fail here rather than silently altering
    // behaviour.
    const { token } = await createShareLink({ companyId: CA, userId: UA, params: PARAMS });
    const r = await resolve(token, { ip: '203.0.113.11', userAgent: 'vitest' });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.link.companyId).toBe(CA);
  });
});

describe('a share link publishes approved text only', () => {
  it('renders the approved sentence and not the draft on the same row', async () => {
    const hash = canonicalParamsHash(PARAMS);
    await admin.query(
      `INSERT INTO report_commentary (company_id, report_kind, params_hash, period_start, period_end, section_ref, row_ref, draft_text, approved_text, status, generated_by, approved_by, approved_at)
       VALUES ($1,'pack',$2,'2026-03-01','2026-08-31','income_statement','netProfit','SHOULD NOT APPEAR','APPROVED SENTENCE','approved',$3,$3,NOW()),
              ($1,'pack',$2,'2026-03-01','2026-08-31','income_statement','revenue','DRAFT SHOULD NOT APPEAR',NULL,'draft',$3,NULL,NULL),
              ($1,'pack',$2,'2026-03-01','2026-08-31','income_statement','costOfSales','WITHDRAWN DRAFT TEXT','WITHDRAWN APPROVAL LEFTOVER','draft',$3,NULL,NULL)`,
      [CA, hash, UA]);
    // The third row above is the case the status filter (not the NULL check
    // alone) exists for: an approval that was withdrawn back to 'draft' without
    // clearing approved_text. Dropping `AND status = 'approved'` from
    // loadApprovedCommentary would still pass `approved_text IS NOT NULL` for
    // this row and leak it — proven by the mutation in the PR description.

    const { token } = await createShareLink({ companyId: CA, userId: UA, params: PARAMS });
    const r = await resolve(token, { ip: '203.0.113.10', userAgent: 'vitest' });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;

    const shared = await buildSharedPack(r.link);
    const text = JSON.stringify(shared);
    expect(text).toContain('APPROVED SENTENCE');
    expect(text).not.toContain('SHOULD NOT APPEAR');
    expect(text).not.toContain('DRAFT SHOULD NOT APPEAR');
    expect(text).not.toContain('WITHDRAWN APPROVAL LEFTOVER');
    expect(text).not.toContain('WITHDRAWN DRAFT TEXT');
    expect(text).not.toContain('B APPROVED');   // tenant B's approved text
    expect(text).not.toContain('B NOTE');       // no annotation, ever
  });
});

/** Enough of a pack for the draft builder to write an income_statement:revenue
 *  sentence, which is the row the withdrawal test below regenerates. */
const PACK_DATA: ManagementPackData = {
  companyName: 'WS3R-A',
  period: '2026-03-01 to 2026-08-31',
  incomeStatement: { revenue: 1_000_000, costOfSales: 600_000, grossProfit: 400_000, operatingExpenses: 250_000, netProfit: 150_000 },
  balanceSheet: { totalAssets: 2_000_000, totalLiabilities: 800_000, equity: 1_200_000, currentRatio: 0.9, debtEquityRatio: 0.67 },
  priorPeriod: { revenue: 800_000, costOfSales: 500_000, grossProfit: 300_000, operatingExpenses: 220_000, netProfit: 80_000 },
  ratios: { grossMargin: 40, netMargin: 15, currentRatio: 0.9, quickRatio: 0.7 },
};

describe('withdrawing an approval keeps the approver on the row (migration 612)', () => {
  it('stamps withdrawn_by/withdrawn_at, preserves approved_by, and publishes nothing', async () => {
    const hash = canonicalParamsHash(PARAMS);
    await admin.query(
      `INSERT INTO report_commentary (company_id, report_kind, params_hash, period_start, period_end, section_ref, row_ref, draft_text, approved_text, status, generated_by, approved_by, approved_at)
       VALUES ($1,'pack',$2,'2026-03-01','2026-08-31','income_statement','revenue','OLD DRAFT','APPROVED BY A NAMED PERSON','approved',$3,$3,NOW())
       ON CONFLICT (company_id, report_kind, params_hash, section_ref, row_ref) DO UPDATE SET
         draft_text = EXCLUDED.draft_text, approved_text = EXCLUDED.approved_text,
         status = 'approved', approved_by = EXCLUDED.approved_by, approved_at = NOW(),
         withdrawn_by = NULL, withdrawn_at = NULL`,
      [CA, hash, UA]);

    await generateDrafts({
      companyId: CA, userId: 'ws3-rls-withdrawer', params: PARAMS, data: PACK_DATA, replace: true,
    });

    const { rows } = await admin.query(
      `SELECT status, approved_text, approved_by, withdrawn_by, withdrawn_at, draft_text
       FROM report_commentary
       WHERE company_id = $1 AND params_hash = $2 AND section_ref = 'income_statement' AND row_ref = 'revenue'`,
      [CA, hash]);
    const row = rows[0];

    expect(row.status).toBe('draft');
    // The whole point: the record of who signed off survives the withdrawal.
    expect(row.approved_by).toBe(UA);
    expect(row.approved_text).toBe('APPROVED BY A NAMED PERSON');
    // And the withdrawal itself is now on the record too.
    expect(row.withdrawn_by).toBe('ws3-rls-withdrawer');
    expect(row.withdrawn_at).not.toBeNull();
    expect(row.draft_text).not.toBe('OLD DRAFT');

    // Keeping approved_text leaks nothing: the published query filters on
    // status, and this row is a draft again. Proven end to end, not argued.
    const { token } = await createShareLink({ companyId: CA, userId: UA, params: PARAMS });
    const r = await resolve(token, { ip: '203.0.113.11', userAgent: 'vitest' });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(JSON.stringify(await buildSharedPack(r.link))).not.toContain('APPROVED BY A NAMED PERSON');
  });
});
