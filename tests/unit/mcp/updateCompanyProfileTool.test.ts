/**
 * update_company_profile: the tool's own half. Role gate first, argument refusals before the service, the company is
 * the token's, a dry run answers wroteNothing, and the reply carries before/after/undo. Format, state and period rules
 * are tests/unit/services/core/companyVatProfile{,Service}.test.ts; the real database is
 * tests/integration/company-profile-mcp.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/accounting/services/core/companyVatProfileService', () => ({ changeCompanyVatProfile: vi.fn() }));

import { changeCompanyVatProfile } from '@/modules/accounting/services/core/companyVatProfileService';
import { updateCompanyProfileTool as tool } from '@/lib/mcp/tools/writeCompanyProfile';
import { flowOperationFor } from '@/lib/mcp/flowMetering';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { toolAnnotationsFor } from '@/lib/mcp/toolAnnotations';

const ctx = (role: string | null) => ({ companyId: 'company-1', userId: 'user-1', tokenJti: 'jti', oauthAppId: null, companyRole: role }) as never;
const OWNER = ctx('owner');
const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;
const base = { dry_run: true, idempotency_key: 'k1' };
const VIEW_A = { vat_number: '4123456789', income_tax_number: null, vat_category: 'A', vat_alignment: 'odd' };
const VIEW_B = { ...VIEW_A, vat_category: 'B', vat_alignment: 'even' };
const IMPACT = {
  as_of: '2026-11-13', changes_periods: true,
  current: { old: { from: '2026-10-01', to: '2026-11-30' }, new: { from: '2026-11-01', to: '2026-12-31' } },
  next: { old: { from: '2026-12-01', to: '2027-01-31' }, new: { from: '2027-01-01', to: '2027-02-28' } },
};
const FOOT = { total: 0, records: [], truncated: false };
const changed = (over: Record<string, unknown> = {}) => ({
  before: VIEW_A, after: VIEW_B, changed: ['vat_category'], nothingChanged: false, periodImpact: IMPACT, footprint: FOOT,
  undoArguments: { vat_category: 'A' }, undoLimitations: [], ...over,
});

beforeEach(() => { vi.clearAllMocks(); });

describe('role gate', () => {
  it.each(['manager', 'viewer', 'accountant', '', null])('refuses %s before anything else', async (role) => {
    const r = await tool.handler({ ...base, vat_category: 'B' }, ctx(role as string | null));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Only an owner or admin');
    expect(changeCompanyVatProfile).not.toHaveBeenCalled();
  });
  it.each(['owner', 'admin'])('lets %s through', async (role) => {
    vi.mocked(changeCompanyVatProfile).mockResolvedValue(changed() as never);
    const r = await tool.handler({ ...base, vat_category: 'B' }, ctx(role));
    expect(r.isError).toBeUndefined();
  });
});

describe('argument refusals (service never called)', () => {
  it.each([
    ['dry_run missing', { idempotency_key: 'k', vat_category: 'B' }, 'dry_run is required'],
    ['dry_run not boolean', { idempotency_key: 'k', dry_run: 'yes', vat_category: 'B' }, 'dry_run is required'],
    ['nothing to change', { ...base }, 'at least one'],
    ['category D', { ...base, vat_category: 'D' }, 'not supported'],
    ['category E', { ...base, vat_category: 'e' }, 'not supported'],
    ['category junk', { ...base, vat_category: 'Z' }, 'one of: A, B, C'],
    ['alignment junk', { ...base, vat_alignment: 'both' }, 'one of: odd, even'],
    ['empty vat number', { ...base, vat_number: '  ' }, 'clearing'],
    ['non-string tax number', { ...base, income_tax_number: 9123456789 }, 'income_tax_number must be'],
    ['non-boolean acknowledgement', { ...base, vat_category: 'B', acknowledge_period_change: 'true' }, 'acknowledge_period_change must be'],
    ['NUL byte', { ...base, vat_number: '41\u00002345678' }, 'NUL'],
  ])('%s', async (_n, args, msg) => {
    const r = await tool.handler(args, OWNER);
    expect(r.isError).toBe(true);
    expect(text(r).toLowerCase()).toContain(msg.toLowerCase());
    expect(changeCompanyVatProfile).not.toHaveBeenCalled();
  });
});

describe('the call', () => {
  it('acts on the token company, never an id from the arguments, and normalises the request', async () => {
    vi.mocked(changeCompanyVatProfile).mockResolvedValue(changed() as never);
    await tool.handler({ ...base, company_id: 'other-company', vat_number: ' 4123 456789 ', vat_category: 'b', vat_alignment: 'EVEN', acknowledge_period_change: true }, OWNER);
    expect(changeCompanyVatProfile).toHaveBeenCalledWith(
      'company-1',
      { vatNumber: '4123456789', category: 'B', alignment: 'even' },
      expect.objectContaining({ dryRun: true, acknowledgePeriodChange: true }),
    );
  });

  it('a service refusal is a tool error', async () => {
    vi.mocked(changeCompanyVatProfile).mockResolvedValue({ refused: 'Refused: this changes the VAT period boundaries' });
    const r = await tool.handler({ ...base, dry_run: false, vat_category: 'B' }, OWNER);
    expect(r).toMatchObject({ isError: true });
    expect(text(r)).toContain('boundaries');
    expect(r.wroteNothing).toBeUndefined();
  });

  it('a dry run answers wroteNothing so the key stays free, with before, after and the period impact', async () => {
    vi.mocked(changeCompanyVatProfile).mockResolvedValue(changed() as never);
    const r = await tool.handler({ ...base, vat_category: 'B' }, OWNER);
    expect(r.wroteNothing).toBe(true);
    expect(r.billable).toBe(false);
    const body = JSON.parse(text(r));
    expect(body).toMatchObject({ dry_run: true, before: VIEW_A, after: VIEW_B, period_impact: IMPACT, undo_arguments: { vat_category: 'A' } });
  });

  it('a live change is stored under the key (no wroteNothing) and the undo carries the acknowledgement when returns exist', async () => {
    vi.mocked(changeCompanyVatProfile).mockResolvedValue(changed({
      footprint: { total: 2, records: [], truncated: false },
    }) as never);
    const r = await tool.handler({ ...base, dry_run: false, vat_category: 'B', acknowledge_period_change: true }, OWNER);
    expect(r.wroteNothing).toBeUndefined();
    const body = JSON.parse(text(r));
    expect(body.undo_arguments).toEqual({ vat_category: 'A', acknowledge_period_change: true });
    expect(body.warnings).toHaveLength(1);
  });

  it('passes the acting user and token to the service and returns undo_limitations', async () => {
    vi.mocked(changeCompanyVatProfile).mockResolvedValue(changed({ undoLimitations: ['vat_number was empty before'] }) as never);
    const r = await tool.handler({ ...base, dry_run: false, vat_category: 'B' }, OWNER);
    expect(changeCompanyVatProfile).toHaveBeenCalledWith('company-1', expect.anything(), expect.objectContaining({ userId: 'user-1', tokenJti: 'jti' }));
    expect(JSON.parse(text(r)).undo_limitations).toEqual(['vat_number was empty before']);
  });

  it('a request that changes nothing frees the key', async () => {
    vi.mocked(changeCompanyVatProfile).mockResolvedValue(changed({
      after: VIEW_A, changed: [], nothingChanged: true, undoArguments: {}, periodImpact: { ...IMPACT, changes_periods: false },
    }) as never);
    const r = await tool.handler({ ...base, dry_run: false, vat_category: 'A' }, OWNER);
    expect(r.wroteNothing).toBe(true);
    expect(JSON.parse(text(r))).toMatchObject({ nothing_changed: true });
  });

  it('rethrows a failure of the write itself (the registry savepoint rolls it back)', async () => {
    vi.mocked(changeCompanyVatProfile).mockRejectedValue(new Error('db down'));
    await expect(tool.handler({ ...base, dry_run: false, vat_category: 'B' }, OWNER)).rejects.toThrow('db down');
  });
});

describe('registration', () => {
  it('is a write tool on write:company, in the manifest, the client list, free of Flow charges, and classified', () => {
    expect(MCP_TOOLS.some((t) => t.name === 'update_company_profile')).toBe(true);
    expect(CLIENT_MCP_TOOL_NAMES).toContain('update_company_profile');
    expect(flowOperationFor('update_company_profile')).toBeNull();
    expect(tool).toMatchObject({ write: true, scope: 'read:vat', requiresScope: 'write:company' });
    expect(tool.requiresPost).toBeUndefined();
    expect(toolAnnotationsFor(tool).destructiveHint).toBe(true);
  });
  it('takes no company id and requires dry_run and a key', () => {
    const props = Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>);
    expect(props).not.toContain('company_id');
    expect(tool.inputSchema.required).toEqual(['dry_run', 'idempotency_key']);
  });
});

// The allowed case (read:vat + write:company reaches the handler) runs in the integration suite on a real registry.
describe('the write:company scope, through the registry fence', () => {
  const callWith = async (scopes: string[]) => {
    const { McpRegistry } = await import('@/lib/mcp/registry');
    const reg = new McpRegistry();
    reg.register(tool);
    return reg.call('update_company_profile', { ...base, dry_run: false, vat_category: 'B' },
      { companyId: 'company-1', userId: 'user-1', tokenJti: null, oauthAppId: null, companyRole: 'owner', scopes } as never);
  };

  it.each([[['read:vat']], [['read:vat', 'write:vat']], [['read:vat', 'write:vat', 'write:post']]])(
    'refuses a token holding %j before the handler', async (scopes) => {
      const r = await callWith(scopes);
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('write:company');
      expect(changeCompanyVatProfile).not.toHaveBeenCalled();
    });
});
