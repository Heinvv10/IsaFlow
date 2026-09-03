import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', async () => {
  const original = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { ...original, sql: sqlFn };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql } from '@/lib/neon';
import { queryAuditTrail } from '@/modules/accounting/services/gl/auditTrailLedgerService';

const COMPANY = '11111111-1111-4111-8111-111111111111';

function texts() {
  return vi.mocked(sql).mock.calls.map((c) => (c[0] as unknown as TemplateStringsArray).join('?'));
}
function params() {
  return vi.mocked(sql).mock.calls.flatMap((c) => c.slice(1));
}

/** page rows, summary buckets, unattributed sample, universe count. */
function mockFourQueries(page: unknown[], buckets: unknown[], excluded: unknown[], universe: number) {
  vi.mocked(sql)
    .mockResolvedValueOnce(page as never)
    .mockResolvedValueOnce(buckets as never)
    .mockResolvedValueOnce(excluded as never)
    .mockResolvedValueOnce([{ cnt: excluded.length }] as never)  // unattributed total
    .mockResolvedValueOnce([{ cnt: universe }] as never);
}

const PAGE_ROW = {
  id: 'je-1', entry_number: 'JE-1', entry_date: '2026-09-01', description: 'x',
  source: 'manual', status: 'posted', posting_agent: 'mcp:create_draft_journal:v1',
  actor_type: 'agent', actor_token_jti: 'tok-1', created_by: 'u1', created_by_name: 'Hein van Vuuren',
  posted_by: 'u2', posted_by_name: 'Willem Marneweck', acting_company_id: null,
  created_at: '2026-09-01T10:00:00Z', posted_at: '2026-09-01T10:00:01Z',
  reversed_at: null, reversal_of_id: null, source_record_id: null, source_document_id: null,
  amount: 100,
};

beforeEach(() => {
  // clearAllMocks does NOT drain queued mockResolvedValueOnce values; a test
  // that leaves one behind would shift every query in the next test.
  vi.mocked(sql).mockReset();
});

describe('queryAuditTrail', () => {
  it('scopes every query by company_id, including the line join', async () => {
    mockFourQueries([], [], [], 0);
    await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50 });

    for (const t of texts()) expect(t).toMatch(/company_id\s*=\s*\?/);
    expect(texts()[0]).toMatch(/jl\.company_id\s*=\s*\?/);
    expect(params().filter((p) => p === COMPANY).length).toBeGreaterThanOrEqual(4);
  });

  it('reports a RECORDED actor as recorded', async () => {
    mockFourQueries([PAGE_ROW], [{ bucket: 'agent', recorded: true, cnt: 1, latest: '2026-09-01T10:00:00Z' }], [], 1);
    const res = await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50 });

    expect(res.rows[0]!.actorType).toBe('agent');
    expect(res.rows[0]!.actorProvenance).toBe('recorded');
    expect(res.rows[0]!.actorCaveat).toBeNull();
    expect(res.rows[0]!.actorTokenJti).toBe('tok-1');
  });

  it('NEVER presents a derived human as a recorded one, and carries the caveat', async () => {
    const legacy = { ...PAGE_ROW, actor_type: null, actor_token_jti: null, posting_agent: 'human:u1' };
    mockFourQueries([legacy], [{ bucket: 'human', recorded: false, cnt: 1, latest: '2026-09-01T10:00:00Z' }], [], 1);
    const res = await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50 });

    expect(res.rows[0]!.actorType).toBe('human');
    expect(res.rows[0]!.actorProvenance).toBe('derived');
    expect(res.rows[0]!.actorCaveat).toMatch(/NOT PROVEN HUMAN/);
  });

  it('an mcp: stamp on a legacy row is derived agent — proven, but still not recorded', async () => {
    const legacy = { ...PAGE_ROW, actor_type: null, actor_token_jti: null };
    mockFourQueries([legacy], [{ bucket: 'agent', recorded: false, cnt: 1, latest: '2026-09-01T10:00:00Z' }], [], 1);
    const res = await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50 });

    expect(res.rows[0]!.actorType).toBe('agent');
    expect(res.rows[0]!.actorProvenance).toBe('derived');
  });

  it('reports recorded-vs-derived attribution over the whole set, not the page', async () => {
    mockFourQueries(
      [PAGE_ROW],
      [
        { bucket: 'agent', recorded: true, cnt: 12, latest: '2026-09-02T00:00:00Z' },
        { bucket: 'agent', recorded: false, cnt: 2287, latest: '2026-09-01T00:00:00Z' },
        { bucket: 'human', recorded: false, cnt: 2589, latest: '2026-08-31T00:00:00Z' },
      ],
      [], 4888,
    );
    const res = await queryAuditTrail(COMPANY, { from: '2026-01-01', to: '2026-12-31', limit: 50 });

    expect(res.attribution.recorded).toBe(12);
    expect(res.attribution.derived).toBe(4876);
    expect(res.attribution.byActorType.agent).toEqual({ recorded: 12, derived: 2287 });
    expect(res.attribution.byActorType.human).toEqual({ recorded: 0, derived: 2589 });
    expect(res.rowsTotal).toBe(4888);
    // posted_through is the MAX created_at of the rows consumed, never now().
    expect(res.postedThrough).toBe('2026-09-02T00:00:00.000Z');
  });

  it('puts a posting with no attribution at all in excludedRows, not in the totals', async () => {
    mockFourQueries(
      [],
      [{ bucket: 'human', recorded: false, cnt: 4, latest: '2026-09-01T00:00:00Z' }],
      [{ id: 'je-9', entry_number: 'JE-9', amount: 4200 }],
      5,
    );
    const res = await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50 });

    expect(res.rowsTotal).toBe(4);
    expect(res.excludedRows).toEqual([
      { id: 'je-9', reason: 'unattributed_posting', documentNumber: 'JE-9', amount: 4200,
        detail: 'Neither actor_type nor posting_agent is set — nothing records who made this posting.' },
    ]);
    expect(res.universeTotal).toBe(5);
    // The excluded set must actually be selected by "records nothing" —
    // mocking the rows alone would pass with any predicate at all.
    expect(texts().some((t) => /je\.actor_type IS NULL AND je\.posting_agent IS NULL/.test(t))).toBe(true);
  });

  it('withholds universeTotal when an actor filter makes the result a selection, not a census', async () => {
    mockFourQueries([], [{ bucket: 'agent', recorded: true, cnt: 3, latest: '2026-09-01T00:00:00Z' }], [], 3);
    const res = await queryAuditTrail(COMPANY, {
      from: '2026-09-01', to: '2026-09-30', limit: 50, actorType: 'agent',
    });
    expect(res.universeTotal).toBeUndefined();
  });

  it('an actor_type=agent filter matches BOTH the recorded column and the legacy mcp: stamp', async () => {
    mockFourQueries([], [], [], 0);
    await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50, actorType: 'agent' });
    expect(texts()[0]).toMatch(/actor_type\s*=\s*\?/);
    expect(texts()[0]).toContain("posting_agent LIKE 'mcp:%'");
  });

  it('casts the uuid side, never users.id — users.id is varchar(255)', async () => {
    mockFourQueries([], [], [], 0);
    await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50 });
    expect(texts()[0]).toContain('u.id::TEXT = je.created_by::TEXT');
    expect(texts()[0]).not.toMatch(/u\.id\s*=\s*\?::UUID/);
  });

  it('joins users with LEFT JOIN so a posting with no user row does not vanish', async () => {
    mockFourQueries([{ ...PAGE_ROW, created_by_name: null }], [], [], 1);
    const res = await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50 });
    expect(texts()[0]).toContain('LEFT JOIN users');
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.userName).toBeNull();
  });

  // "Which human" is TWO people, not one: created_by raised it, posted_by
  // committed it to the ledger. On production posted_by is set on 14,126 of
  // 15,647 journals and has five distinct values against created_by's eight —
  // reporting only the creator loses the person who actually posted.
  it('reports the poster as well as the creator', async () => {
    mockFourQueries([PAGE_ROW], [], [], 1);
    const res = await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50 });
    expect(res.rows[0]!.userId).toBe('u1');
    expect(res.rows[0]!.userName).toBe('Hein van Vuuren');
    expect(res.rows[0]!.postedByUserId).toBe('u2');
    expect(res.rows[0]!.postedByUserName).toBe('Willem Marneweck');
  });

  it('joins the poster with a SECOND left join, cast on the uuid side', async () => {
    mockFourQueries([], [], [], 0);
    await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50 });
    const t = texts()[0]!;
    // users.id is character varying(255); casting the param to ::UUID throws.
    expect(t).toContain('pu.id::TEXT = je.posted_by::TEXT');
    expect(t.match(/LEFT JOIN users/g)).toHaveLength(2);
    expect(t).not.toMatch(/(?:u|pu)\.id\s*=\s*\?::UUID/);
  });

  it('a draft that nobody has posted reports no poster rather than falling back to the creator', async () => {
    mockFourQueries([{ ...PAGE_ROW, status: 'draft', posted_at: null, posted_by: null, posted_by_name: null }], [], [], 1);
    const res = await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50 });
    expect(res.rows[0]!.action).toBe('draft');
    expect(res.rows[0]!.postedByUserId).toBeNull();
    expect(res.rows[0]!.postedByUserName).toBeNull();
    expect(res.rows[0]!.userId).toBe('u1');
  });

  it('emits a next_cursor only when a further page exists', async () => {
    const many = Array.from({ length: 3 }, (_, i) => ({ ...PAGE_ROW, id: `je-${i}`, entry_number: `JE-${i}` }));
    mockFourQueries(many, [], [], 3);
    const res = await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 2 });
    expect(res.rows).toHaveLength(2);
    expect(res.nextCursor).not.toBeNull();
  });
});

/**
 * The attribution census buckets rows in SQL (a CASE over posting_agent) while
 * each ROW is classified in TypeScript by resolveLegacyActorType. Two
 * implementations of one rule is exactly the duplication CONTRACTS.md §5 warns
 * about; it is unavoidable here because a COUNT cannot call a TS function. This
 * pins them together so a change to either shows up as a failure.
 */
/**
 * The fourth axis. NULL means UNKNOWN, never "same company" — the identical
 * discipline actor_type is under. Deriving it would make the trail assert
 * something nobody recorded.
 */
describe('acting_company_id — which firm the actor was acting for', () => {
  const FIRM = '99999999-9999-4999-8999-999999999999';

  it('reports a recorded firm as itself', async () => {
    mockFourQueries([{ ...PAGE_ROW, acting_company_id: FIRM }], [], [], 1);
    const res = await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50 });
    expect(res.rows[0]!.actingCompanyId).toBe(FIRM);
    expect(res.rows[0]!.actingCompanyKnown).toBe(true);
    expect(res.rows[0]!.crossCompany).toBe(true);
  });

  it('a NULL is UNKNOWN — never resolved to the company whose books these are', async () => {
    mockFourQueries([{ ...PAGE_ROW, acting_company_id: null }], [], [], 1);
    const res = await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50 });
    expect(res.rows[0]!.actingCompanyId).toBeNull();
    expect(res.rows[0]!.actingCompanyKnown).toBe(false);
    // NOT false — "we do not know" is a third answer, and collapsing it to
    // "no" is the same lie as reporting a derived human as a recorded one.
    expect(res.rows[0]!.crossCompany).toBeNull();
    expect(res.rows[0]!.actingCompanyCaveat).toMatch(/not recorded/i);
  });

  it('a firm equal to the company itself is in-house, not cross-company', async () => {
    mockFourQueries([{ ...PAGE_ROW, acting_company_id: COMPANY }], [], [], 1);
    const res = await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50 });
    expect(res.rows[0]!.crossCompany).toBe(false);
  });

  it('filters by a named firm', async () => {
    mockFourQueries([], [], [], 0);
    await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50, actingCompanyId: FIRM });
    // The COLUMN is cast, not the parameter: a malformed uuid then compares
    // false instead of throwing 22P02 inside a read that has no savepoint.
    expect(texts()[0]).toMatch(/je\.acting_company_id::TEXT\s*=\s*\?/);
    expect(texts()[0]).not.toMatch(/acting_company_id\s*=\s*\?::UUID/);
    expect(params()).toContain(FIRM);
  });

  it('answers "posted into this company by someone outside it" as its own filter', async () => {
    mockFourQueries([], [], [], 0);
    await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50, crossCompanyOnly: true });
    const t = texts()[0]!;
    // Must require a RECORDED firm that differs. A NULL is unknown, so it
    // cannot answer this question either way and must not be swept in.
    expect(t).toMatch(/je\.acting_company_id IS NOT NULL/);
    expect(t).toMatch(/je\.acting_company_id <> je\.company_id/);
  });

  it('a firm filter makes the result a selection — universeTotal is withheld', async () => {
    mockFourQueries([], [{ bucket: 'agent', recorded: true, cnt: 3, latest: '2026-09-01T00:00:00Z' }], [], 3);
    const byFirm = await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50, actingCompanyId: FIRM });
    expect(byFirm.universeTotal).toBeUndefined();
    vi.mocked(sql).mockReset();
    mockFourQueries([], [{ bucket: 'agent', recorded: true, cnt: 3, latest: '2026-09-01T00:00:00Z' }], [], 3);
    const cross = await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50, crossCompanyOnly: true });
    expect(cross.universeTotal).toBeUndefined();
  });
});

/** Blind-review MEDIUM 1: the excluded query ignored every caller filter. */
describe('excludedRows respects the caller\'s filters', () => {
  it('applies source, user, action and entity to the unattributed query too', async () => {
    mockFourQueries([], [], [], 0);
    await queryAuditTrail(COMPANY, {
      from: '2026-09-01', to: '2026-09-30', limit: 50,
      source: 'manual', userId: 'u1', action: 'posted',
      entityType: 'journal', entityId: 'je-1',
    });
    const excluded = texts().find((t) => /je\.actor_type IS NULL AND je\.posting_agent IS NULL/.test(t))!;
    expect(excluded).toMatch(/je\.source\s*=\s*\?/);
    expect(excluded).toMatch(/je\.created_by::TEXT\s*=\s*\?/);
    expect(excluded).toMatch(/reversed_at IS NULL AND je\.status = 'posted'/);
    expect(excluded).toMatch(/je\.id::TEXT\s*=\s*\?/);
  });

  it('does NOT apply the actor filters — an unattributed row has no actor to match', async () => {
    mockFourQueries([], [], [], 0);
    await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50, actorType: 'agent' });
    const excluded = texts().find((t) => /je\.actor_type IS NULL AND je\.posting_agent IS NULL/.test(t))!;
    expect(excluded).not.toMatch(/posting_agent LIKE 'mcp:%'/);
  });
});

/** Blind-review MEDIUM 2: the 200-row cap undercounted with nothing flagged. */
describe('a capped excludedRows sample states its own truncation', () => {
  it('counts every unattributed row, not just the sampled ones', async () => {
    vi.mocked(sql).mockReset();
    vi.mocked(sql)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ bucket: 'human', recorded: false, cnt: 10, latest: '2026-09-01T00:00:00Z' }] as never)
      .mockResolvedValueOnce(
        Array.from({ length: 200 }, (_, i) => ({ id: `je-${i}`, entry_number: `JE-${i}`, amount: 1 })) as never)
      .mockResolvedValueOnce([{ cnt: 812 }] as never)   // unattributed total
      .mockResolvedValueOnce([{ cnt: 822 }] as never);  // universe

    const res = await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50 });
    expect(res.excludedRows).toHaveLength(200);
    expect(res.excludedTotal).toBe(812);
    expect(res.excludedTruncated).toBe(true);
    // Withheld deliberately: buildEnvelope checks rowsTotal + excludedRows.LENGTH
    // against it, so a capped sample would raise a fault about paging rather
    // than about completeness — noise that erodes the signal it exists to give.
    // excludedTotal is reported instead, so nothing is silent.
    expect(res.universeTotal).toBeUndefined();
  });

  it('an uncapped sample still states its total and is not truncated', async () => {
    vi.mocked(sql).mockReset();
    vi.mocked(sql)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ bucket: 'human', recorded: false, cnt: 4, latest: '2026-09-01T00:00:00Z' }] as never)
      .mockResolvedValueOnce([{ id: 'je-9', entry_number: 'JE-9', amount: 4200 }] as never)
      .mockResolvedValueOnce([{ cnt: 1 }] as never)
      .mockResolvedValueOnce([{ cnt: 5 }] as never);

    const res = await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50 });
    expect(res.excludedTotal).toBe(1);
    expect(res.excludedTruncated).toBe(false);
    expect(res.universeTotal).toBe(5);
  });
});

describe('the SQL bucket and resolveLegacyActorType agree', () => {
  const SQL_RULE = (agent: string | null) =>
    agent === null ? null
      : agent.startsWith('mcp:') ? 'agent'
      : agent.startsWith('system:') ? 'system'
      : 'human';

  it.each([
    'mcp:create_draft_journal:v1',
    'system:bank-allocation:v1',
    'human:u1',
    'legacy:human',
    'import:sage',
    'ai:expense-claim',
    'rule:abc',
  ])('%s', async (agent) => {
    const { resolveLegacyActorType } = await import('@/lib/mcp/contracts/actor');
    expect(resolveLegacyActorType(agent).actorType).toBe(SQL_RULE(agent));
  });

  it('and the CASE the census actually runs is that same rule, not a copy that drifted', async () => {
    mockFourQueries([], [], [], 0);
    await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50 });
    const census = texts().find((t) => t.includes('AS bucket'))!;
    expect(census).toMatch(/WHEN je\.posting_agent LIKE 'mcp:%' THEN 'agent'/);
    expect(census).toMatch(/WHEN je\.posting_agent LIKE 'system:%' THEN 'system'/);
    expect(census).toMatch(/ELSE 'human'/);
    // COALESCE over the recorded column: a recorded actor always wins.
    expect(census).toMatch(/COALESCE\(je\.actor_type,/);
  });

  // Documented consequence, not an accident: an import, a VLM extraction and a
  // bank rule all land in the DERIVED HUMAN bucket, because the shared
  // resolver's rule is "not stamped as an agent". That overstates the human
  // count by 1,854 legacy: rows on production. Widening it is a change to the
  // shared contract (contracts/actor.ts), not to this service.
  it('buckets legacy:, import:, ai: and rule: stamps as DERIVED human', async () => {
    const { resolveLegacyActorType } = await import('@/lib/mcp/contracts/actor');
    for (const agent of ['legacy:human', 'import:sage', 'ai:x', 'rule:1']) {
      const r = resolveLegacyActorType(agent);
      expect(r.actorType).toBe('human');
      expect(r.provenance).toBe('derived');
      expect(r.caveat).toMatch(/NOT PROVEN HUMAN/);
    }
  });
});
