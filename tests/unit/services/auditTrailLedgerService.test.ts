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
    .mockResolvedValueOnce([{ cnt: universe }] as never);
}

const PAGE_ROW = {
  id: 'je-1', entry_number: 'JE-1', entry_date: '2026-09-01', description: 'x',
  source: 'manual', status: 'posted', posting_agent: 'mcp:create_draft_journal:v1',
  actor_type: 'agent', actor_token_jti: 'tok-1', created_by: 'u1', created_by_name: 'Hein van Vuuren',
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

  it('emits a next_cursor only when a further page exists', async () => {
    const many = Array.from({ length: 3 }, (_, i) => ({ ...PAGE_ROW, id: `je-${i}`, entry_number: `JE-${i}` }));
    mockFourQueries(many, [], [], 3);
    const res = await queryAuditTrail(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 2 });
    expect(res.rows).toHaveLength(2);
    expect(res.nextCursor).not.toBeNull();
  });
});
