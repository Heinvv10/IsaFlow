import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/gl/auditTrailLedgerService', () => ({
  queryAuditTrail: vi.fn(),
  AUDIT_ENTITY_TYPES: ['journal', 'source_record', 'source_document'],
  AUDIT_ACTIONS: ['draft', 'posted', 'reversed'],
}));

import { queryAuditTrail } from '@/modules/accounting/services/gl/auditTrailLedgerService';
import { auditTrailTool } from '@/lib/mcp/tools/auditTrail';
import { assertEnvelopeSound, buildEnvelope } from '@/lib/mcp/contracts';

const ctx = {
  companyId: '11111111-1111-4111-8111-111111111111',
  userId: 'u1', scopes: ['read:reports'], tokenJti: 't', oauthAppId: null,
} as never;

const PAGE = {
  rows: [{
    journalEntryId: 'je-1', entryNumber: 'JE-1', entryDate: '2026-09-01', description: 'x',
    source: 'manual', status: 'posted', action: 'posted', amount: 100,
    actorType: 'human', actorProvenance: 'derived',
    actorCaveat: 'NOT PROVEN HUMAN. …', actorTokenJti: null,
    postingAgent: 'human:u1', userId: 'u1', userName: 'Hein van Vuuren',
    postedByUserId: 'u2', postedByUserName: 'Willem Marneweck',
    actingCompanyId: null, actingCompanyKnown: false, crossCompany: null,
    actingCompanyCaveat: 'The acting company was not recorded on this row.',
    createdAt: '2026-09-01T10:00:00.000Z', postedAt: null, reversedAt: null,
    reversalOfId: null, sourceRecordId: null,
  }],
  rowsTotal: 1, universeTotal: 1, excludedRows: [], excludedTotal: 0, nextCursor: null,
  postedThrough: '2026-09-01T10:00:00.000Z',
  attribution: {
    recorded: 0, derived: 1,
    byActorType: { human: { recorded: 0, derived: 1 }, agent: { recorded: 0, derived: 0 }, system: { recorded: 0, derived: 0 } },
  },
};

function payload(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => vi.clearAllMocks());

describe('audit_trail', () => {
  // The house rule, stated to the agent in its own language: nothing writes
  // actor_type 'human' by default, so a recorded human means a caller asserted
  // one — and the absence of an agent stamp is not proof of a person.
  it('tells the caller what a RECORDED human does and does not prove', () => {
    const d = auditTrailTool.description;
    expect(d).toMatch(/recorded[\s\S]*human[\s\S]*asserted/i);
    expect(d).toMatch(/absence of an agent stamp is not proof/i);
  });

  it('is a read tool on read:reports — reviewing the ledger must never need write scope', () => {
    expect(auditTrailTool.write).toBe(false);
    expect(auditTrailTool.requiresPost).toBeUndefined();
    expect(auditTrailTool.scope).toBe('read:reports');
  });

  it('passes the tenant from ctx and never from args', async () => {
    vi.mocked(queryAuditTrail).mockResolvedValue(PAGE as never);
    await auditTrailTool.handler({ from: '2026-09-01', to: '2026-09-30' }, ctx);
    expect(vi.mocked(queryAuditTrail).mock.calls[0]![0]).toBe(ctx.companyId);
    expect(auditTrailTool.inputSchema.properties).not.toHaveProperty('company_id');
  });

  it('returns a sound ReportEnvelope with the completeness fields filled in', async () => {
    vi.mocked(queryAuditTrail).mockResolvedValue(PAGE as never);
    const env = payload(await auditTrailTool.handler({ from: '2026-09-01', to: '2026-09-30' }, ctx) as never);
    assertEnvelopeSound(env as never);
    expect(env.rowsTotal).toBe(1);
    expect(env.rowsReturned).toBe(1);
    expect(env.as_at).toBe('2026-09-30');
    expect(env.posted_through).toBe('2026-09-01T10:00:00.000Z');
    expect(env.excludedRows).toEqual([]);
  });

  it('surfaces provenance on every row — a derived human must never read as a recorded one', async () => {
    vi.mocked(queryAuditTrail).mockResolvedValue(PAGE as never);
    const env = payload(await auditTrailTool.handler({ from: '2026-09-01', to: '2026-09-30' }, ctx) as never);
    const row = (env.rows as Record<string, unknown>[])[0]!;
    expect(row.actor_provenance).toBe('derived');
    expect(row.actor_caveat).toMatch(/NOT PROVEN HUMAN/);
  });

  // The auditor's line is four-part: whose books, which human, agent-or-human
  // and which token, and which firm. Three are answerable today.
  it('names the books the entries belong to — the axis the row shape leaves implicit', async () => {
    vi.mocked(queryAuditTrail).mockResolvedValue(PAGE as never);
    const env = payload(await auditTrailTool.handler({ from: '2026-09-01', to: '2026-09-30' }, ctx) as never);
    expect(env.company_id).toBe(ctx.companyId);
  });

  it('carries both humans on the row: who raised it and who posted it', async () => {
    vi.mocked(queryAuditTrail).mockResolvedValue(PAGE as never);
    const env = payload(await auditTrailTool.handler({ from: '2026-09-01', to: '2026-09-30' }, ctx) as never);
    const row = (env.rows as Record<string, unknown>[])[0]!;
    expect(row.user_id).toBe('u1');
    expect(row.user_name).toBe('Hein van Vuuren');
    expect(row.posted_by_user_id).toBe('u2');
    expect(row.posted_by_user_name).toBe('Willem Marneweck');
  });

  it('reports the recorded-vs-derived split so a reader can size the gap', async () => {
    vi.mocked(queryAuditTrail).mockResolvedValue(PAGE as never);
    const env = payload(await auditTrailTool.handler({ from: '2026-09-01', to: '2026-09-30' }, ctx) as never);
    expect(env.attribution).toEqual(PAGE.attribution);
  });

  it('drops rows on detail=summary but keeps the attribution census', async () => {
    vi.mocked(queryAuditTrail).mockResolvedValue(PAGE as never);
    const env = payload(await auditTrailTool.handler(
      { from: '2026-09-01', to: '2026-09-30', detail: 'summary' }, ctx) as never);
    assertEnvelopeSound(env as never);
    expect(env.rows).toEqual([]);
    expect(env.rowsTotal).toBe(1);
    expect(env.attribution).toEqual(PAGE.attribution);
  });

  it('surfaces the firm axis, and an unrecorded firm as UNKNOWN not "in-house"', async () => {
    vi.mocked(queryAuditTrail).mockResolvedValue(PAGE as never);
    const env = payload(await auditTrailTool.handler({ from: '2026-09-01', to: '2026-09-30' }, ctx) as never);
    const row = (env.rows as Record<string, unknown>[])[0]!;
    expect(row.acting_company_id).toBeNull();
    expect(row.acting_company_known).toBe(false);
    expect(row.cross_company).toBeNull();
    expect(row.acting_company_caveat).toMatch(/not recorded/i);
  });

  it('passes the cross-company filter through — the client auditor\'s first question', async () => {
    vi.mocked(queryAuditTrail).mockResolvedValue(PAGE as never);
    await auditTrailTool.handler(
      { from: '2026-09-01', to: '2026-09-30', posted_from_outside_this_company: true }, ctx);
    expect(vi.mocked(queryAuditTrail).mock.calls[0]![1].crossCompanyOnly).toBe(true);
  });

  it('passes a named firm through and refuses one that is not a uuid', async () => {
    vi.mocked(queryAuditTrail).mockResolvedValue(PAGE as never);
    await auditTrailTool.handler(
      { from: '2026-09-01', to: '2026-09-30', acting_company_id: '99999999-9999-4999-8999-999999999999' }, ctx);
    expect(vi.mocked(queryAuditTrail).mock.calls[0]![1].actingCompanyId)
      .toBe('99999999-9999-4999-8999-999999999999');

    vi.clearAllMocks();
    const res = await auditTrailTool.handler(
      { from: '2026-09-01', to: '2026-09-30', acting_company_id: 'nope' }, ctx);
    expect(res.isError).toBe(true);
    expect(queryAuditTrail).not.toHaveBeenCalled();
  });

  it('hands the envelope the excluded COUNT, not the sample, so a capped list still foots', async () => {
    const excludedRows = Array.from({ length: 200 }, (_, i) => ({ id: `je-${i}`, reason: 'unattributed_posting' }));
    vi.mocked(queryAuditTrail).mockResolvedValue({
      ...PAGE, rowsTotal: 10, universeTotal: 822, excludedRows, excludedTotal: 812,
    } as never);
    const env = payload(await auditTrailTool.handler({ from: '2026-09-01', to: '2026-09-30' }, ctx) as never);
    // 10 + 812 === 822. Passing the 200-row sample instead would have made the
    // envelope claim 190 rows were unaccounted for — a fault about paging.
    assertEnvelopeSound(env as never);
    expect(env.excludedTotal).toBe(812);
    expect(env.truncatedExcludedRows).toBe(true);
  });

  it('a capped sample without the count WOULD fault — proving the count is load-bearing', () => {
    const excludedRows = Array.from({ length: 200 }, (_, i) => ({ id: `je-${i}`, reason: 'unattributed_posting' }));
    const bad = buildEnvelope({
      rows: [], rowsTotal: 10, universeTotal: 822, excludedRows,
      detail: 'standard', as_at: '2026-09-30', posted_through: '2026-09-01T00:00:00.000Z',
    });
    expect(bad.completenessFault).toMatch(/unaccounted/);
  });

  it('states the segregation-of-duties finding in the description', () => {
    expect(auditTrailTool.description).toMatch(/segregation of duties/i);
  });

  it('refuses an unparseable date before it reaches a ::DATE cast in a savepoint-free read', async () => {
    const res = await auditTrailTool.handler({ from: '2026-02-31', to: '2026-09-30' }, ctx);
    expect(res.isError).toBe(true);
    expect(queryAuditTrail).not.toHaveBeenCalled();
  });

  it('refuses a missing range rather than scanning the whole ledger', async () => {
    const res = await auditTrailTool.handler({ from: '2026-09-01' }, ctx);
    expect(res.isError).toBe(true);
    expect(queryAuditTrail).not.toHaveBeenCalled();
  });

  it('refuses an entity_id with no entity_type — it would match nothing and look empty', async () => {
    const res = await auditTrailTool.handler(
      { from: '2026-09-01', to: '2026-09-30', entity_id: 'x' }, ctx);
    expect(res.isError).toBe(true);
    expect(queryAuditTrail).not.toHaveBeenCalled();
  });

  it('refuses an invalid cursor rather than throwing inside the read transaction', async () => {
    const res = await auditTrailTool.handler(
      { from: '2026-09-01', to: '2026-09-30', cursor: 'not-a-cursor' }, ctx);
    expect(res.isError).toBe(true);
    expect(queryAuditTrail).not.toHaveBeenCalled();
  });

  it('clamps the limit — an unbounded audit trail blows the agent context window', async () => {
    vi.mocked(queryAuditTrail).mockResolvedValue(PAGE as never);
    await auditTrailTool.handler({ from: '2026-09-01', to: '2026-09-30', limit: 9999 }, ctx);
    expect(vi.mocked(queryAuditTrail).mock.calls[0]![1].limit).toBe(200);
  });
});
