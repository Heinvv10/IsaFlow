import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn() }),
}));
vi.mock('@/lib/neon', () => ({ sql: sqlMock, withTransaction: vi.fn(), transaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/capture/provisionalPostingService', () => ({
  postProvisional: vi.fn(),
}));

import {
  evaluate,
  getAutoPostSettings,
  updateAutoPostSettings,
  sweep,
  autoPostRunSnapshot,
  type AutoPostSettings,
  type GateTx,
} from '@/modules/accounting/services/bank/autoPostGateService';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { postProvisional } from '@/modules/accounting/services/capture/provisionalPostingService';

const ON: AutoPostSettings = { enabled: true, minConfidence: 0.9, amountCap: 10000, llmEnabled: false, llmMinConfidence: 0.95, llmAmountCap: 2000 };
const tx = (over: Partial<GateTx> = {}): GateTx => ({
  status: 'imported', amount: -500, suggestedGlAccountId: 'gl-1', ...over,
});

describe('evaluate — decision ladder', () => {
  it('skips when disabled', () => {
    expect(evaluate(tx(), 0.99, { ...ON, enabled: false }, null)).toEqual({ outcome: 'skip', reason: 'disabled' });
  });

  it('skips when tx not imported', () => {
    // NOTE: with the reordered ladder (status check before feature-flag), a non-imported tx
    // now returns 'not eligible' regardless of the enabled flag.
    expect(evaluate(tx({ status: 'allocated' }), 0.99, ON, null)).toEqual({ outcome: 'skip', reason: 'not eligible' });
  });

  it('skips when confidence below threshold', () => {
    expect(evaluate(tx(), 0.89, ON, null)).toEqual({ outcome: 'skip', reason: 'confidence too low' });
  });

  it('posts when confidence is exactly at threshold', () => {
    expect(evaluate(tx(), 0.9, ON, null)).toEqual({ outcome: 'post' });
  });

  it('skips when amount over cap', () => {
    expect(evaluate(tx({ amount: -10000.01 }), 0.99, ON, null)).toEqual({ outcome: 'skip', reason: 'over amount cap' });
  });

  it('posts when amount is exactly at the cap', () => {
    expect(evaluate(tx({ amount: -10000 }), 0.99, ON, null)).toEqual({ outcome: 'post' });
  });

  it('treats cap of 0 as uncapped', () => {
    expect(evaluate(tx({ amount: -999999 }), 0.99, { ...ON, amountCap: 0 }, null)).toEqual({ outcome: 'post' });
  });

  it('skips suggestion-path tx with no target', () => {
    expect(evaluate(tx({ suggestedGlAccountId: null }), 0.99, ON, null)).toEqual({ outcome: 'skip', reason: 'no target' });
  });

  it('defers confidence + no-target rungs when confidence is null (provisional path)', () => {
    expect(evaluate(tx({ suggestedGlAccountId: null }), null, ON, null)).toEqual({ outcome: 'post' });
  });

  it('enforces status on the provisional path (null confidence)', () => {
    expect(evaluate(tx({ status: 'allocated' }), null, ON, null)).toEqual({ outcome: 'skip', reason: 'not eligible' });
  });

  it('still enforces enabled/status/cap on the provisional path', () => {
    expect(evaluate(tx({ amount: -20000, suggestedGlAccountId: null }), null, ON, null))
      .toEqual({ outcome: 'skip', reason: 'over amount cap' });
  });
});

describe('getAutoPostSettings', () => {
  beforeEach(() => sqlMock.mockReset());

  it('returns disabled defaults when no row exists', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const s = await getAutoPostSettings('co-1');
    expect(s).toEqual({ enabled: false, minConfidence: 0.9, amountCap: 10000, llmEnabled: false, llmMinConfidence: 0.95, llmAmountCap: 2000 });
  });

  it('maps an existing row', async () => {
    sqlMock.mockResolvedValueOnce([{ enabled: true, min_confidence: '0.85', amount_cap: '5000', llm_enabled: false, llm_min_confidence: '0.95', llm_amount_cap: '2000' }]);
    const s = await getAutoPostSettings('co-1');
    expect(s).toEqual({ enabled: true, minConfidence: 0.85, amountCap: 5000, llmEnabled: false, llmMinConfidence: 0.95, llmAmountCap: 2000 });
  });
});

describe('updateAutoPostSettings', () => {
  beforeEach(() => sqlMock.mockReset());

  it('rejects a min_confidence outside (0,1]', async () => {
    await expect(updateAutoPostSettings('co-1', { minConfidence: 1.5 }, 'u-1'))
      .rejects.toThrow(/min_confidence/);
  });

  it('rejects a negative amount cap', async () => {
    await expect(updateAutoPostSettings('co-1', { amountCap: -1 }, 'u-1'))
      .rejects.toThrow(/amount_cap/);
  });

  it('upserts and returns the merged settings', async () => {
    sqlMock.mockResolvedValueOnce([{ enabled: true, min_confidence: '0.9', amount_cap: '10000', llm_enabled: false, llm_min_confidence: '0.95', llm_amount_cap: '2000' }]);
    const s = await updateAutoPostSettings('co-1', { enabled: true }, 'u-1');
    expect(s.enabled).toBe(true);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('persists enabled:false without dropping it', async () => {
    sqlMock.mockResolvedValueOnce([{ enabled: false, min_confidence: '0.9', amount_cap: '10000', llm_enabled: false, llm_min_confidence: '0.95', llm_amount_cap: '2000' }]);
    const s = await updateAutoPostSettings('co-1', { enabled: false }, 'u-1');
    expect(s.enabled).toBe(false);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('accepts amountCap 0 (uncapped) and forwards it', async () => {
    sqlMock.mockResolvedValueOnce([{ enabled: true, min_confidence: '0.9', amount_cap: '0', llm_enabled: false, llm_min_confidence: '0.95', llm_amount_cap: '2000' }]);
    const s = await updateAutoPostSettings('co-1', { amountCap: 0 }, 'u-1');
    expect(s.amountCap).toBe(0);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});

describe('updateAutoPostSettings — LLM field validation', () => {
  it('rejects llmMinConfidence outside (0,1]', async () => {
    await expect(updateAutoPostSettings('c', { llmMinConfidence: 0 }, 'u')).rejects.toThrow(/llm_min_confidence/);
    await expect(updateAutoPostSettings('c', { llmMinConfidence: 1.5 }, 'u')).rejects.toThrow(/llm_min_confidence/);
  });
  it('rejects negative llmAmountCap', async () => {
    await expect(updateAutoPostSettings('c', { llmAmountCap: -1 }, 'u')).rejects.toThrow(/llm_amount_cap/);
  });
});

// Route sqlMock responses by query text so order-independence holds.
function routeSql(handlers: Array<{ match: RegExp; rows: unknown[] }>) {
  sqlMock.mockImplementation((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    const h = handlers.find((x) => x.match.test(text));
    if (!h) throw new Error(`routeSql: unhandled query:\n${text}`);
    return Promise.resolve(h.rows);
  });
}

describe('sweep', () => {
  beforeEach(() => {
    sqlMock.mockReset();
    (allocateTransaction as ReturnType<typeof vi.fn>).mockReset();
    (postProvisional as ReturnType<typeof vi.fn>).mockReset();
  });

  it('early-outs with no run row when disabled', async () => {
    routeSql([{ match: /FROM bank_auto_post_settings/, rows: [] }]); // no row → disabled
    const r = await sweep('co-1', ['t1', 't2'], 'categorization', 'u-1');
    expect(r).toEqual({ runId: null, posted: 0, skipped: [] });
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('lazily creates the run row on the first post and tags the tx (suggestion path)', async () => {
    routeSql([
      { match: /FROM bank_auto_post_settings/, rows: [{ enabled: true, min_confidence: '0.9', amount_cap: '10000', llm_enabled: false, llm_min_confidence: '0.95', llm_amount_cap: '2000' }] },
      { match: /FROM bank_transactions\s+WHERE id = ANY/, rows: [
        { id: 't1', status: 'imported', amount: -500, suggested_gl_account_id: 'gl-1', suggested_confidence: '0.95', suggested_vat_code: null, description: 'Coffee' },
      ] },
      { match: /INSERT INTO bank_auto_post_runs/, rows: [{ id: 'run-1' }] },
      { match: /UPDATE bank_transactions SET auto_post_run_id/, rows: [] },
      { match: /UPDATE bank_auto_post_runs/, rows: [] },
    ]);
    (allocateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({ journalEntryId: 'je-1' });

    const r = await sweep('co-1', ['t1'], 'categorization', 'u-1');

    expect(r.posted).toBe(1);
    expect(r.runId).toBe('run-1');
    expect(allocateTransaction).toHaveBeenCalledWith(
      'co-1', 't1', 'gl-1', 'u-1', 'Coffee', 'account', undefined, undefined,
      undefined, undefined, undefined, undefined, { postingAgent: 'ai:auto-post:v1' },
    );
    // Prove the stats UPDATE fired with posted_count = 1.
    const statsCall = sqlMock.mock.calls.find(
      (c) => (c[0] as TemplateStringsArray).join('?').includes('SET posted_count'),
    );
    expect(statsCall).toBeDefined();
    expect(statsCall![1]).toBe(1);
  });

  it('records a skip and never creates a run when nothing qualifies', async () => {
    routeSql([
      { match: /FROM bank_auto_post_settings/, rows: [{ enabled: true, min_confidence: '0.9', amount_cap: '10000', llm_enabled: false, llm_min_confidence: '0.95', llm_amount_cap: '2000' }] },
      { match: /FROM bank_transactions\s+WHERE id = ANY/, rows: [
        { id: 't1', status: 'imported', amount: -500, suggested_gl_account_id: 'gl-1', suggested_confidence: '0.5', suggested_vat_code: null, description: 'x' },
      ] },
    ]);
    const r = await sweep('co-1', ['t1'], 'categorization', 'u-1');
    expect(r.posted).toBe(0);
    expect(r.runId).toBeNull();
    expect(r.skipped).toEqual([{ txId: 't1', reason: 'confidence too low' }]);
  });

  it('isolates a per-tx failure and keeps sweeping', async () => {
    routeSql([
      { match: /FROM bank_auto_post_settings/, rows: [{ enabled: true, min_confidence: '0.9', amount_cap: '10000', llm_enabled: false, llm_min_confidence: '0.95', llm_amount_cap: '2000' }] },
      { match: /FROM bank_transactions\s+WHERE id = ANY/, rows: [
        { id: 't1', status: 'imported', amount: -100, suggested_gl_account_id: 'gl-1', suggested_confidence: '0.95', suggested_vat_code: null, description: 'a' },
        { id: 't2', status: 'imported', amount: -200, suggested_gl_account_id: 'gl-2', suggested_confidence: '0.95', suggested_vat_code: null, description: 'b' },
      ] },
      { match: /INSERT INTO bank_auto_post_runs/, rows: [{ id: 'run-1' }] },
      { match: /UPDATE bank_transactions SET auto_post_run_id/, rows: [] },
      { match: /UPDATE bank_auto_post_runs/, rows: [] },
    ]);
    (allocateTransaction as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ journalEntryId: 'je-2' });

    const r = await sweep('co-1', ['t1', 't2'], 'categorization', 'u-1');
    expect(r.posted).toBe(1);
    expect(r.skipped).toContainEqual({ txId: 't1', reason: 'boom' });
  });

  it('uses the provisional path for the import source', async () => {
    routeSql([
      { match: /FROM bank_auto_post_settings/, rows: [{ enabled: true, min_confidence: '0.9', amount_cap: '10000', llm_enabled: false, llm_min_confidence: '0.95', llm_amount_cap: '2000' }] },
      { match: /FROM bank_transactions\s+WHERE id = ANY/, rows: [
        { id: 't1', status: 'imported', amount: -300, suggested_gl_account_id: null, suggested_confidence: null, suggested_vat_code: null, description: 'EFT' },
      ] },
      { match: /INSERT INTO bank_auto_post_runs/, rows: [{ id: 'run-9' }] },
      { match: /UPDATE bank_transactions SET auto_post_run_id/, rows: [] },
      { match: /UPDATE bank_auto_post_runs/, rows: [] },
    ]);
    (postProvisional as ReturnType<typeof vi.fn>).mockResolvedValue({ journalEntryId: 'je-9', prediction: {} });

    const r = await sweep('co-1', ['t1'], 'import', 'u-1');
    expect(postProvisional).toHaveBeenCalledWith('co-1', 't1', 'u-1', { minConfidence: 0.9 });
    expect(r.posted).toBe(1);
  });
});

// ── autoPostRunSnapshot ──────────────────────────────────────────────────────

describe('autoPostRunSnapshot', () => {
  const s: AutoPostSettings = { enabled: true, minConfidence: 0.9, amountCap: 10000, llmEnabled: true, llmMinConfidence: 0.95, llmAmountCap: 2000 };
  it('records the LLM pair for an llm post', () => {
    expect(autoPostRunSnapshot('llm', s)).toEqual({ minConfidence: 0.95, amountCap: 2000 });
  });
  it('records the standard pair for rule/pattern/historical/null', () => {
    expect(autoPostRunSnapshot('rule', s)).toEqual({ minConfidence: 0.9, amountCap: 10000 });
    expect(autoPostRunSnapshot(null, s)).toEqual({ minConfidence: 0.9, amountCap: 10000 });
  });
});

// ── LLM tier quarantine tests ────────────────────────────────────────────────

const S = (o: Partial<AutoPostSettings> = {}): AutoPostSettings => ({
  enabled: true, minConfidence: 0.9, amountCap: 10000,
  llmEnabled: false, llmMinConfidence: 0.95, llmAmountCap: 2000, ...o,
});
const TX = { status: 'imported', amount: -500, suggestedGlAccountId: 'gl' };

describe('evaluate — LLM tier quarantine', () => {
  it('standard strategy with high confidence still posts (unchanged)', () => {
    expect(evaluate(TX, 0.96, S(), 'rule')).toEqual({ outcome: 'post' });
  });
  it('LLM suggestion is NOT posted by the standard gate even when standard thresholds pass', () => {
    expect(evaluate(TX, 0.96, S({ llmEnabled: false }), 'llm')).toEqual({ outcome: 'skip', reason: 'llm disabled' });
  });
  it('LLM suggestion posts only under the LLM gate when enabled + above llm threshold + within llm cap', () => {
    expect(evaluate(TX, 0.96, S({ llmEnabled: true }), 'llm')).toEqual({ outcome: 'post' });
  });
  it('LLM suggestion below llm_min_confidence is skipped', () => {
    expect(evaluate(TX, 0.93, S({ llmEnabled: true }), 'llm')).toEqual({ outcome: 'skip', reason: 'llm confidence too low' });
  });
  it('LLM suggestion over llm_amount_cap is skipped', () => {
    expect(evaluate({ ...TX, amount: -2500 }, 0.99, S({ llmEnabled: true }), 'llm')).toEqual({ outcome: 'skip', reason: 'llm over amount cap' });
  });
  it('LLM tier ignores the standard enabled flag (standard off, llm on → posts)', () => {
    expect(evaluate(TX, 0.96, S({ enabled: false, llmEnabled: true }), 'llm')).toEqual({ outcome: 'post' });
  });
  it('provisional import path (confidence null, no strategy) unchanged', () => {
    expect(evaluate(TX, null, S(), null)).toEqual({ outcome: 'post' });
  });
});
