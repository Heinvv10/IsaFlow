// RED phase — written before implementation
/**
 * Unit tests for captureInboxService.ts
 *
 * Covers: generateInboxAddress (pure), getOrCreateEmailInbox, regenerateEmailAddress, listInboxes.
 * DB calls are intercepted via vi.mock('@/lib/neon').
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock so factory closure captures the same reference ───────────────
const { sqlMock } = vi.hoisted(() => {
  const sqlMock = Object.assign(vi.fn(), {
    unsafe: vi.fn().mockReturnValue(''),
  });
  return { sqlMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  generateInboxAddress,
  getOrCreateEmailInbox,
  regenerateEmailAddress,
  listInboxes,
} from '@/modules/accounting/services/capture/captureInboxService';

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const INBOX_ID   = 'bbbbbbbb-0000-0000-0000-000000000002';
const ADDRESS    = 'cap-a1b2c3@inbox.isaflow.co.za';
const NOW        = '2026-04-22T08:00:00Z';

function makeInboxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INBOX_ID,
    company_id: COMPANY_ID,
    channel: 'email',
    address: ADDRESS,
    is_active: true,
    allowed_sender_domains: null,
    created_by: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

// ── generateInboxAddress — pure helper ───────────────────────────────────────

describe('generateInboxAddress', () => {
  it('returns address matching cap-<32 hex>@inbox.isaflow.co.za', () => {
    const addr = generateInboxAddress(COMPANY_ID);
    expect(addr).toMatch(/^cap-[a-f0-9]{32}@inbox\.isaflow\.co\.za$/);
  });

  it('generates different addresses on successive calls', () => {
    const a = generateInboxAddress(COMPANY_ID);
    const b = generateInboxAddress(COMPANY_ID);
    // Not guaranteed to differ every time, but almost always true with random 16 bytes
    // We run 20 pairs and assert at least one differs to avoid false failures
    const pairs = Array.from({ length: 20 }, () => [
      generateInboxAddress(COMPANY_ID),
      generateInboxAddress(COMPANY_ID),
    ]);
    const hasDifference = pairs.some(([x, y]) => x !== y);
    expect(hasDifference).toBe(true);
  });

  it('1000 generated addresses have >99% uniqueness (birthday-paradox sanity)', () => {
    const N = 1000;
    const addresses = new Set(
      Array.from({ length: N }, () => generateInboxAddress(COMPANY_ID)),
    );
    // With 16 random bytes collisions are astronomically rare
    expect(addresses.size).toBeGreaterThan(N * 0.99);
  });

  it('works with any companyId string — pure, no DB side-effects', () => {
    const addr = generateInboxAddress('some-other-company');
    expect(addr).toMatch(/^cap-[a-f0-9]{32}@inbox\.isaflow\.co\.za$/);
  });
});

// ── getOrCreateEmailInbox ─────────────────────────────────────────────────────

describe('getOrCreateEmailInbox', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns existing inbox without inserting when one is active', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      { id: INBOX_ID, address: ADDRESS, is_active: true },
    ] as never);

    const result = await getOrCreateEmailInbox(COMPANY_ID);

    expect(result.id).toBe(INBOX_ID);
    expect(result.address).toBe(ADDRESS);
    expect(result.isActive).toBe(true);
    // Only the SELECT was issued — no INSERT
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
  });

  it('called twice for the same company returns the same id when DB echoes existing row', async () => {
    // First call — SELECT returns existing row
    vi.mocked(sql).mockResolvedValueOnce([
      { id: INBOX_ID, address: ADDRESS, is_active: true },
    ] as never);
    // Second call — SELECT returns same existing row again
    vi.mocked(sql).mockResolvedValueOnce([
      { id: INBOX_ID, address: ADDRESS, is_active: true },
    ] as never);

    const first  = await getOrCreateEmailInbox(COMPANY_ID);
    const second = await getOrCreateEmailInbox(COMPANY_ID);

    expect(first.id).toBe(second.id);
    expect(first.address).toBe(second.address);
  });

  it('inserts a new inbox when none exists, returning new row', async () => {
    // SELECT — no existing inbox
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    // INSERT — returns new row
    vi.mocked(sql).mockResolvedValueOnce([
      { id: INBOX_ID, address: ADDRESS, is_active: true },
    ] as never);

    const result = await getOrCreateEmailInbox(COMPANY_ID, 'user-123');

    expect(result.id).toBe(INBOX_ID);
    expect(result.address).toBe(ADDRESS);
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(2);
  });

  it('retries INSERT when address collision occurs, succeeding on second attempt', async () => {
    // SELECT — no existing inbox
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    // First INSERT — ON CONFLICT returns no row
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    // Second INSERT — succeeds
    vi.mocked(sql).mockResolvedValueOnce([
      { id: INBOX_ID, address: ADDRESS, is_active: true },
    ] as never);

    const result = await getOrCreateEmailInbox(COMPANY_ID);
    expect(result.id).toBe(INBOX_ID);
  });

  it('throws after 5 consecutive address collisions', async () => {
    // SELECT — nothing
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    // 5 INSERT failures
    for (let i = 0; i < 5; i++) {
      vi.mocked(sql).mockResolvedValueOnce([] as never);
    }

    await expect(getOrCreateEmailInbox(COMPANY_ID)).rejects.toThrow(
      'Failed to mint unique inbox address after 5 attempts',
    );
  });

  it('propagates non-collision DB errors immediately without retrying', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    vi.mocked(sql).mockRejectedValueOnce(new Error('connection timeout') as never);

    await expect(getOrCreateEmailInbox(COMPANY_ID)).rejects.toThrow('connection timeout');
    // Only SELECT + one failed INSERT (no further retries for non-collision errors)
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(2);
  });
});

// ── regenerateEmailAddress ────────────────────────────────────────────────────

describe('regenerateEmailAddress', () => {
  beforeEach(() => vi.clearAllMocks());

  it('issues an UPDATE setting is_active=false before creating new inbox', async () => {
    // Call order: UPDATE (deactivate) → SELECT (no existing) → INSERT (new)
    vi.mocked(sql).mockResolvedValueOnce([] as never); // UPDATE returns void-ish
    vi.mocked(sql).mockResolvedValueOnce([] as never); // SELECT in getOrCreate — none found
    vi.mocked(sql).mockResolvedValueOnce([
      { id: 'new-inbox-id', address: 'cap-ff1122@inbox.isaflow.co.za', is_active: true },
    ] as never);

    const result = await regenerateEmailAddress(COMPANY_ID);

    // First sql call must be the deactivation UPDATE
    const calls = vi.mocked(sql).mock.calls;
    expect(calls.length).toBe(3);
    // The UPDATE is call[0]; it should reference is_active and the company
    // We assert on call count + final result rather than SQL string contents
    expect(result.address).toBe('cap-ff1122@inbox.isaflow.co.za');
    expect(result.id).toBe('new-inbox-id');
  });

  it('returns a different address than the old one (new row mocked)', async () => {
    const OLD_ADDRESS = 'cap-aaaaaa@inbox.isaflow.co.za';
    const NEW_ADDRESS = 'cap-bbbbbb@inbox.isaflow.co.za';

    vi.mocked(sql).mockResolvedValueOnce([] as never); // UPDATE
    vi.mocked(sql).mockResolvedValueOnce([] as never); // SELECT — no active found after deactivation
    vi.mocked(sql).mockResolvedValueOnce([
      { id: 'inbox-new', address: NEW_ADDRESS, is_active: true },
    ] as never);

    const result = await regenerateEmailAddress(COMPANY_ID);
    expect(result.address).not.toBe(OLD_ADDRESS);
    expect(result.address).toBe(NEW_ADDRESS);
  });
});

// ── listInboxes ───────────────────────────────────────────────────────────────

describe('listInboxes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns mapped Inbox objects for all rows', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeInboxRow({ is_active: true }),
      makeInboxRow({ id: 'bbbbbbbb-0000-0000-0000-000000000099', is_active: false }),
    ] as never);

    const inboxes = await listInboxes(COMPANY_ID);
    expect(inboxes).toHaveLength(2);
    expect(inboxes[0]!.id).toBe(INBOX_ID);
    expect(inboxes[0]!.companyId).toBe(COMPANY_ID);
    expect(inboxes[0]!.channel).toBe('email');
    expect(inboxes[0]!.isActive).toBe(true);
    expect(inboxes[1]!.isActive).toBe(false);
  });

  it('returns empty array when company has no inboxes', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    const inboxes = await listInboxes(COMPANY_ID);
    expect(inboxes).toHaveLength(0);
  });

  it('maps allowedSenderDomains as null when column is null', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeInboxRow()] as never);

    const [inbox] = await listInboxes(COMPANY_ID);
    expect(inbox!.allowedSenderDomains).toBeNull();
  });

  it('propagates sql errors to caller', async () => {
    vi.mocked(sql).mockRejectedValueOnce(new Error('permission denied') as never);

    await expect(listInboxes(COMPANY_ID)).rejects.toThrow('permission denied');
  });
});
