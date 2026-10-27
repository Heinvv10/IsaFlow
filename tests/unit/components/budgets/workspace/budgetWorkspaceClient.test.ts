/**
 * The workspace's fetchers (spec §7, PR-B contract): typed results for every refusal (apiFetch
 * resolves on 4xx, so nothing may throw or pass one off as data), and the CHAINED commit:
 * at most MAX_SAVE_CELLS a request, clears first, each chunk sent with the token the previous
 * save returned, stopping at a 409 with the failed chunk's index. Fetch is mocked at the boundary.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MAX_SAVE_CELLS, fetchGridModel, previewImport, saveCells, saveChained, setVersionStatus, templateUrl,
} from '@/components/accounting/budgets/workspace/budgetWorkspaceClient';
import type { SaveCell } from '@/modules/accounting/services/budgets/gridSaveValidate';
import { gridModel, ID, TOKEN } from './gridFixture';

interface Sent { url: string; method: string; body: unknown }
let sent: Sent[];
let replies: Array<(body: unknown) => Response>;

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const fail = (status: number, message: string, details?: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ success: false, error: { code: 'X', message, details } }), { status, headers });

beforeEach(() => {
  sent = [];
  replies = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    sent.push({ url, method: init?.method ?? 'GET', body });
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected request ${url}`);
    return reply(body);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const upsert = (i: number): SaveCell => ({
  glAccountId: ID.rev1, cc1Id: null, cc2Id: null, buId: null, month: `${2000 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, amount: i,
});
const clear = (i: number): SaveCell => ({ ...upsert(i), glAccountId: ID.rev2, amount: null, clear: true });
const bodyOf = (s: Sent) => s.body as { versionId: string; expectedUpdatedAt: string; cells: SaveCell[] };

describe('saveChained', () => {
  it('sends one request when the batch fits, with the token as given', async () => {
    replies.push(() => ok({ updatedAt: 'T1', saved: 2, deleted: 1 }));
    const r = await saveChained(ID.version, [upsert(0), clear(1), upsert(2)], TOKEN);
    expect(r).toEqual({ ok: true, updatedAt: 'T1', saved: 2, deleted: 1, chunks: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: '/api/accounting/budget-grid/save', method: 'POST' });
    expect(bodyOf(sent[0]!)).toMatchObject({ versionId: ID.version, expectedUpdatedAt: TOKEN });
    // Clears first.
    expect(bodyOf(sent[0]!).cells.map(c => c.clear === true)).toEqual([true, false, false]);
  });

  it('chunks at MAX_SAVE_CELLS, clears first, chaining each response token into the next request', async () => {
    expect(MAX_SAVE_CELLS).toBe(20_000);
    const cells = [...Array.from({ length: MAX_SAVE_CELLS + 5 }, (_, i) => upsert(i)), ...Array.from({ length: 3 }, (_, i) => clear(i))];
    replies.push(() => ok({ updatedAt: 'T1', saved: 19_997, deleted: 3 }), () => ok({ updatedAt: 'T2', saved: 8, deleted: 0 }));
    const r = await saveChained(ID.version, cells, TOKEN);
    expect(r).toEqual({ ok: true, updatedAt: 'T2', saved: 20_005, deleted: 3, chunks: 2 });
    expect(sent.map(s => bodyOf(s).cells.length)).toEqual([MAX_SAVE_CELLS, 8]);
    expect(sent.map(s => bodyOf(s).expectedUpdatedAt)).toEqual([TOKEN, 'T1']);
    expect(bodyOf(sent[0]!).cells.slice(0, 3).every(c => c.clear === true && c.amount === null)).toBe(true);
    expect(bodyOf(sent[0]!).cells.slice(3).some(c => c.clear)).toBe(false);
  });

  it('stops on a 409 mid-chain: names the failed chunk, the cells already committed and the last good token', async () => {
    const cells = Array.from({ length: MAX_SAVE_CELLS * 2 + 1 }, (_, i) => upsert(i));
    replies.push(
      () => ok({ updatedAt: 'T1', saved: MAX_SAVE_CELLS, deleted: 0 }),
      () => fail(409, 'This budget changed since you opened it', { code: 'BUDGET_VERSION_STALE', currentUpdatedAt: 'T9', status: 'approved' }),
    );
    const r = await saveChained(ID.version, cells, TOKEN);
    expect(sent).toHaveLength(2); // the third chunk is never sent
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r).toMatchObject({ failedChunk: 1, chunks: 3, updatedAt: 'T1', saved: MAX_SAVE_CELLS, deleted: 0 });
    expect(r.committed).toHaveLength(MAX_SAVE_CELLS);
    expect(r.failure).toEqual({ ok: false, kind: 'stale', message: 'This budget changed since you opened it', currentUpdatedAt: 'T9', versionStatus: 'approved' });
  });

  it('an empty batch sends nothing', async () => {
    expect(await saveChained(ID.version, [], TOKEN)).toEqual({ ok: true, updatedAt: TOKEN, saved: 0, deleted: 0, chunks: 0 });
    expect(sent).toHaveLength(0);
  });
});

describe('typed failures', () => {
  it.each([
    [fail(409, 'Locked', { code: 'BUDGET_VERSION_LOCKED' }), { kind: 'locked', message: 'Locked' }],
    [fail(409, 'Wrong state', { code: 'BUDGET_VERSION_STATE' }), { kind: 'conflict', code: 'BUDGET_VERSION_STATE' }],
    [fail(429, 'Too many budget saves', undefined, { 'Retry-After': '60' }), { kind: 'rateLimited', retryAfter: 60 }],
    [fail(503, 'Busy', undefined, { 'Retry-After': '5' }), { kind: 'busy', retryAfter: 5, message: 'Busy' }],
    [fail(400, 'Account 1000: header', { code: 'BUDGET_VERSION_INPUT' }), { kind: 'invalid', message: 'Account 1000: header', code: 'BUDGET_VERSION_INPUT' }],
    [fail(403, 'No'), { kind: 'forbidden' }],
    [fail(404, 'Gone'), { kind: 'notFound' }],
    [new Response('<html>bad gateway</html>', { status: 502 }), { kind: 'failed', status: 502, message: 'Could not save the budget.' }],
    [new Response('<html>proxy</html>', { status: 200 }), { kind: 'failed', status: 200 }],
  ])('maps %#', async (response, expected) => {
    replies.push(() => response);
    expect(await saveCells(ID.version, TOKEN, [upsert(0)])).toMatchObject({ ok: false, ...expected });
  });

  it('a network failure is a result, not a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await saveCells(ID.version, TOKEN, [upsert(0)])).toEqual({ ok: false, kind: 'network', message: 'Could not save the budget.' });
  });
});

describe('other fetchers', () => {
  it('reads the model by version id or by year and refuses a cells-only answer as a model', async () => {
    replies.push(() => ok(gridModel()), () => ok({ versionId: null, updatedAt: null, cells: [] }));
    const byVersion = await fetchGridModel({ versionId: ID.version });
    expect(byVersion.ok && byVersion.data.accounts.length).toBe(9);
    expect(sent[0]!.url).toBe(`/api/accounting/budget-grid?version_id=${ID.version}`);
    expect((await fetchGridModel({ fiscalYear: 2027 })).ok).toBe(false);
    expect(sent[1]!.url).toBe('/api/accounting/budget-grid?fiscal_year=2027');
  });

  it('posts a status move with the token', async () => {
    replies.push(() => ok({ ...gridModel().version, status: 'approved' }));
    const r = await setVersionStatus(ID.version, 'approve', { expectedUpdatedAt: TOKEN });
    expect(r.ok && r.data.status).toBe('approved');
    expect(sent[0]).toMatchObject({ url: `/api/accounting/budget-versions/${ID.version}/status`, method: 'POST', body: { action: 'approve', expectedUpdatedAt: TOKEN } });
  });

  it('builds the template URL', () => {
    expect(templateUrl(ID.version, 'company')).toBe(`/api/accounting/budget-grid/template?version_id=${ID.version}&grain=company`);
    expect(templateUrl(ID.version, 'cc1', [ID.m1, ID.m2])).toBe(`/api/accounting/budget-grid/template?version_id=${ID.version}&grain=cc1&members=${ID.m1}%2C${ID.m2}`);
  });

  it('sends the import file as base64 without the data: prefix', async () => {
    replies.push(() => ok({ updatedAt: TOKEN, changes: [], cells: [] }));
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff])], 'budget.xlsx');
    await previewImport(ID.version, file);
    expect(sent[0]).toMatchObject({ url: '/api/accounting/budget-grid/import-preview', method: 'POST' });
    expect(sent[0]!.body).toEqual({ versionId: ID.version, fileName: 'budget.xlsx', fileData: 'UEsDBP8=' });
  });
});
