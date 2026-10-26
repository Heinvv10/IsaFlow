/**
 * The one predicate that decides which companies a session may be scoped to.
 *
 * Incident 2026-10-16: an admin soft-deleted a user's DEFAULT company
 * (`companies.status = 'deleted'`, `is_active` left true). Login read the
 * default straight out of `company_users`, wrote it into the
 * `active_company_id` cookie, and from then on `withAuth`'s
 * `getCompanyMembership` — which excludes deleted/suspended companies —
 * refused every company-scoped request with 403.
 *
 * The `sql` fake below is NOT a text matcher. It reads which filters the query
 * actually carries and then applies those filters to a fixture, so deleting a
 * predicate from the real query changes what these tests see. An explanatory
 * SQL comment naming `status` cannot keep them green.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface CompanyRow {
  id: string;
  name: string;
  is_active: boolean;
  status: string;
  suspended_at: Date | null;
  is_demo?: boolean;
}
interface MembershipRow {
  user_id: string;
  company_id: string;
  role: string;
  is_default: boolean;
  created_at: Date;
}

let companies: CompanyRow[] = [];
let memberships: MembershipRow[] = [];

/** Apply exactly the filters the query text carries — nothing more. */
function applyFilters(text: string, rows: CompanyRow[]): CompanyRow[] {
  let out = rows;
  if (/is_active\s*=\s*true/i.test(text)) out = out.filter((c) => c.is_active);
  if (/status IS DISTINCT FROM 'deleted'/i.test(text)) out = out.filter((c) => c.status !== 'deleted');
  if (/status IS DISTINCT FROM 'suspended'/i.test(text)) out = out.filter((c) => c.status !== 'suspended');
  if (/suspended_at IS NULL/i.test(text)) out = out.filter((c) => c.suspended_at === null);
  return out;
}

const sqlMock = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join(' ? ');
  const userId = String(values[0]);
  const live = applyFilters(text, companies);
  let rows = memberships
    .filter((m) => m.user_id === userId)
    .filter((m) => live.some((c) => c.id === m.company_id));

  // isLiveCompanyForUser: second parameter narrows to one company.
  if (values.length > 1) {
    const companyId = String(values[1]);
    rows = rows.filter((m) => m.company_id === companyId);
    return rows.length > 0 ? [{ ok: 1 }] : [];
  }

  rows = [...rows].sort(
    (a, b) =>
      Number(b.is_default) - Number(a.is_default) ||
      a.created_at.getTime() - b.created_at.getTime(),
  );
  return rows.map((m) => ({
    company_id: m.company_id,
    company_name: live.find((c) => c.id === m.company_id)!.name,
    role: m.role,
    is_default: m.is_default,
    is_demo: live.find((c) => c.id === m.company_id)!.is_demo ?? false,
  }));
});

vi.mock('@/lib/neon', () => ({
  sql: (...a: unknown[]) => sqlMock(...(a as [TemplateStringsArray, ...unknown[]])),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  listLiveCompanyMemberships,
  pickInitialCompanyId,
  isLiveCompanyForUser,
} from '@/lib/auth/liveCompanies';
import { getUserCompanies } from '@/modules/accounting/services/core/companyService';

const USER = 'user-1';
const OLD = new Date('2024-01-01');
const NEW = new Date('2025-01-01');

function company(id: string, patch: Partial<CompanyRow> = {}): CompanyRow {
  return { id, name: `Co ${id}`, is_active: true, status: 'active', suspended_at: null, ...patch };
}
function membership(companyId: string, patch: Partial<MembershipRow> = {}): MembershipRow {
  return { user_id: USER, company_id: companyId, role: 'owner', is_default: false, created_at: OLD, ...patch };
}

beforeEach(() => {
  vi.clearAllMocks();
  companies = [];
  memberships = [];
});

describe('liveCompanies — which companies a session may be scoped to', () => {
  it('skips a soft-deleted DEFAULT company and falls back to the next live membership', async () => {
    companies = [company('dead', { status: 'deleted' }), company('live')];
    memberships = [
      membership('dead', { is_default: true, created_at: OLD }),
      membership('live', { created_at: NEW }),
    ];

    expect(await pickInitialCompanyId(USER)).toBe('live');
    expect((await listLiveCompanyMemberships(USER)).map((m) => m.companyId)).toEqual(['live']);
  });

  it('prefers the default company when it is still live', async () => {
    companies = [company('a'), company('b')];
    memberships = [
      membership('a', { created_at: OLD }),
      membership('b', { is_default: true, created_at: NEW }),
    ];
    expect(await pickInitialCompanyId(USER)).toBe('b');
  });

  it('falls back to the OLDEST live membership when no default survives', async () => {
    companies = [company('dead', { status: 'deleted' }), company('older'), company('newer')];
    memberships = [
      membership('dead', { is_default: true }),
      membership('newer', { created_at: NEW }),
      membership('older', { created_at: OLD }),
    ];
    expect(await pickInitialCompanyId(USER)).toBe('older');
  });

  for (const [label, patch] of [
    ['status = deleted', { status: 'deleted' }],
    ['status = suspended', { status: 'suspended' }],
    ['suspended_at set', { suspended_at: new Date('2026-01-01') }],
  ] as Array<[string, Partial<CompanyRow>]>) {
    it(`excludes a company with ${label} — the same test withAuth applies`, async () => {
      companies = [company('only', patch)];
      memberships = [membership('only', { is_default: true })];

      expect(await listLiveCompanyMemberships(USER)).toEqual([]);
      expect(await pickInitialCompanyId(USER)).toBeNull();
      expect(await isLiveCompanyForUser(USER, 'only')).toBe(false);
    });
  }

  it('returns null rather than a doomed company when every membership is dead', async () => {
    companies = [company('d1', { status: 'deleted' }), company('d2', { status: 'suspended' })];
    memberships = [membership('d1', { is_default: true }), membership('d2')];
    expect(await pickInitialCompanyId(USER)).toBeNull();
  });

  it('isLiveCompanyForUser accepts a live company the user belongs to', async () => {
    companies = [company('live')];
    memberships = [membership('live')];
    expect(await isLiveCompanyForUser(USER, 'live')).toBe(true);
    expect(await isLiveCompanyForUser('someone-else', 'live')).toBe(false);
  });
});

describe('getUserCompanies — the switcher / landing list', () => {
  it('excludes a soft-deleted company, which /api/auth/landing used to count as live', async () => {
    companies = [company('dead', { status: 'deleted' }), company('live')];
    memberships = [membership('dead', { is_default: true }), membership('live')];

    const list = await getUserCompanies(USER);
    expect(list.map((c) => c.companyId)).toEqual(['live']);
  });

  it('returns an empty list — not a dead company — when the only membership was deleted', async () => {
    companies = [company('dead', { status: 'deleted' })];
    memberships = [membership('dead', { is_default: true })];
    expect(await getUserCompanies(USER)).toEqual([]);
  });

  it('keeps the shape its callers map over', async () => {
    companies = [company('live')];
    memberships = [membership('live', { is_default: true, role: 'admin' })];
    expect(await getUserCompanies(USER)).toEqual([
      { companyId: 'live', companyName: 'Co live', role: 'admin', isDefault: true, isDemo: false },
    ]);
  });

  it('carries companies.is_demo so the UI never finds the demo tenant by its name', async () => {
    companies = [company('demo', { name: 'Acme Plumbing', is_demo: true }), company('live', { name: 'Demo Plumbing' })];
    memberships = [membership('demo'), membership('live', { is_default: true })];
    const list = await getUserCompanies(USER);
    expect(list.map((c) => [c.companyId, c.isDemo])).toEqual([['live', false], ['demo', true]]);
  });
});
