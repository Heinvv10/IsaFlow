/**
 * Retrying a failed or interrupted capture read. One guarded UPDATE re-arms the row (read_attempt + 1, reading, a fresh
 * heartbeat) and a second job starts after COMMIT for the new attempt. Allowed only when the read failed (or went
 * silent), the file is stored (and was not found missing), the document is still pending and not posted; refused with
 * 'being_read' while a read is alive, 'not_retryable' otherwise, and the in-flight cap and the AI limit apply as for an
 * upload. The effect of every condition is pinned against real PostgreSQL in tests/integration/capture-read-retry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sql: vi.fn(), runAfterCommit: vi.fn(), runCaptureRead: vi.fn(), charge: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: m.runAfterCommit }));
vi.mock('@/modules/accounting/services/capture/captureReadJob', () => ({ runCaptureRead: m.runCaptureRead }));

import { retryCaptureRead } from '@/modules/accounting/services/capture/captureReadRetry';
import { NOT_STORED_ERROR, STALE_AFTER_MINUTES } from '@/modules/accounting/services/capture/captureReadState';

const CO = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID = 'cccccccc-0000-4000-8000-000000000003';
const ago = (min: number) => new Date(Date.now() - min * 60_000);

const failedRow = (over: Record<string, unknown> = {}) => ({
  id: ID, company_id: CO, read_state: 'failed', read_error: 'Boom.', read_heartbeat_at: ago(10), created_at: ago(30),
  storage_path: `${CO}/${ID}`, posted_at: null, status: 'pending', read_attempt: 0, ...over,
});

interface Call { text: string; values: unknown[] }
let calls: Call[];
let db: { row: Record<string, unknown> | null; inFlight: number; updated: Record<string, unknown>[]; afterRace: Record<string, unknown> | null };
const squash = (t: string) => t.replace(/::\w+/g, '').replace(/\s+/g, ' ').trim();
const on = (needle: string) => calls.filter((c) => squash(c.text).includes(needle));

beforeEach(() => {
  vi.resetAllMocks();
  calls = [];
  db = { row: failedRow(), inFlight: 0, updated: [failedRow({ read_state: 'reading', read_error: null, read_attempt: 1 })], afterRace: null };
  m.charge.mockResolvedValue(true);
  let selects = 0;
  m.sql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const c = { text: strings.join('?'), values };
    calls.push(c);
    const t = squash(c.text);
    if (t.includes('COUNT(*)')) return [{ n: db.inFlight }];
    if (t.startsWith('UPDATE captured_documents')) return db.updated;
    if (t.startsWith('SELECT')) { selects += 1; const r = selects === 1 ? db.row : (db.afterRace ?? db.row); return r ? [r] : []; }
    return [];
  });
});

describe('retryCaptureRead: accepted', () => {
  it('re-arms a failed row with ONE guarded UPDATE and starts the job for the new attempt after COMMIT', async () => {
    const out = await retryCaptureRead(CO, ID, m.charge);
    expect(out).toMatchObject({ ok: true, attempt: 1 });
    const [upd] = on('UPDATE captured_documents');
    const t = squash(upd!.text);
    expect(t).toContain("read_state = 'reading'");
    expect(t).toContain('read_error = NULL');
    expect(t).toContain('read_heartbeat_at = NOW()');
    expect(t).toContain('read_attempt = read_attempt + 1');
    expect(t).toContain('RETURNING');
    expect(m.runAfterCommit).toHaveBeenCalledTimes(1);
    expect(m.runAfterCommit.mock.calls[0]![0]).toBe('capture-read');
    expect(m.runCaptureRead).not.toHaveBeenCalled();
    await (m.runAfterCommit.mock.calls[0]![1] as () => Promise<void>)();
    expect(m.runCaptureRead).toHaveBeenCalledWith(CO, ID, 1);
  });

  it('starts the job for the attempt the UPDATE returned, not a guess', async () => {
    db.updated = [failedRow({ read_state: 'reading', read_attempt: 7 })];
    await retryCaptureRead(CO, ID, m.charge);
    await (m.runAfterCommit.mock.calls[0]![1] as () => Promise<void>)();
    expect(m.runCaptureRead).toHaveBeenCalledWith(CO, ID, 7);
  });

  it('accepts a read gone silent (shown as interrupted)', async () => {
    db.row = failedRow({ read_state: 'reading', read_error: null, read_heartbeat_at: ago(STALE_AFTER_MINUTES + 1) });
    expect(await retryCaptureRead(CO, ID, m.charge)).toMatchObject({ ok: true });
  });

  it('the UPDATE only matches a retryable row: failed or silent, stored, not found missing, pending, unposted, this company', async () => {
    await retryCaptureRead(CO, ID, m.charge);
    const where = squash(on('UPDATE captured_documents')[0]!.text);
    const w = where.slice(where.indexOf('WHERE'));
    expect(w).toContain('id = ? AND company_id = ?');
    expect(w).toContain('posted_at IS NULL');
    expect(w).toContain("status = 'pending'");
    expect(w).toContain('storage_path IS NOT NULL');
    expect(w).toContain("storage_path <> ''");
    expect(w).toContain('read_error IS DISTINCT FROM ?');
    expect(w).toContain("read_state = 'failed'");
    expect(w).toContain("read_state = 'reading' AND COALESCE(read_heartbeat_at, created_at) < NOW() - make_interval(mins => ?)");
    const values = on('UPDATE captured_documents')[0]!.values;
    expect(values).toEqual(expect.arrayContaining([CO, ID, NOT_STORED_ERROR, STALE_AFTER_MINUTES]));
  });

  it('names the company in every statement', async () => {
    await retryCaptureRead(CO, ID, m.charge);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) {
      expect(squash(c.text)).toContain('company_id = ?');
      expect(c.values).toContain(CO);
    }
  });
});

describe('retryCaptureRead: refused, and nothing written or started', () => {
  const refusedAs = async (reason: string) => {
    expect(await retryCaptureRead(CO, ID, m.charge)).toEqual({ ok: false, reason });
    expect(on('UPDATE captured_documents')).toHaveLength(0);
    expect(m.runAfterCommit).not.toHaveBeenCalled();
    expect(m.charge).not.toHaveBeenCalled();
  };

  it('a read that is alive is being_read', async () => {
    db.row = failedRow({ read_state: 'reading', read_error: null, read_heartbeat_at: ago(1) });
    await refusedAs('being_read');
  });
  it('a finished read is not_retryable', async () => {
    db.row = failedRow({ read_state: 'done', read_error: null });
    await refusedAs('not_retryable');
  });
  it.each(['rejected', 'reviewed', 'matched'])('a %s document is not_retryable', async (status) => {
    db.row = failedRow({ status });
    await refusedAs('not_retryable');
  });
  it('a posted document is not_retryable', async () => {
    db.row = failedRow({ posted_at: ago(1) });
    await refusedAs('not_retryable');
  });
  it('a row with no stored file is not_retryable', async () => {
    db.row = failedRow({ storage_path: null });
    await refusedAs('not_retryable');
  });
  it('a row whose object was found missing is not_retryable', async () => {
    db.row = failedRow({ read_error: NOT_STORED_ERROR });
    await refusedAs('not_retryable');
  });
  it('another tenant\'s or unknown row is missing', async () => {
    db.row = null;
    await refusedAs('missing');
  });
});

describe('retryCaptureRead: load', () => {
  it('answers too_many when the company already has 5 reads in flight, counting only non-stale reading rows of this company, and does not charge', async () => {
    db.inFlight = 5;
    expect(await retryCaptureRead(CO, ID, m.charge)).toEqual({ ok: false, reason: 'too_many' });
    const count = squash(on('COUNT(*)')[0]!.text);
    expect(count).toContain('company_id = ?');
    expect(count).toContain("read_state = 'reading'");
    expect(count).toContain('COALESCE(read_heartbeat_at, created_at) > NOW() - make_interval(mins => ?)');
    expect(m.charge).not.toHaveBeenCalled();
    expect(on('UPDATE captured_documents')).toHaveLength(0);
    expect(m.runAfterCommit).not.toHaveBeenCalled();
  });

  it('accepts the 5th read in flight', async () => {
    db.inFlight = 4;
    expect(await retryCaptureRead(CO, ID, m.charge)).toMatchObject({ ok: true });
  });

  it('answers rate_limited when the AI unit is refused: nothing re-armed, nothing started', async () => {
    m.charge.mockResolvedValue(false);
    expect(await retryCaptureRead(CO, ID, m.charge)).toEqual({ ok: false, reason: 'rate_limited' });
    expect(on('UPDATE captured_documents')).toHaveLength(0);
    expect(m.runAfterCommit).not.toHaveBeenCalled();
  });

  it('charges after the eligibility and in-flight checks and before the UPDATE', async () => {
    const order: string[] = [];
    m.charge.mockImplementation(async () => { order.push('charge'); return true; });
    const inner = m.sql.getMockImplementation()!;
    m.sql.mockImplementation(async (s: TemplateStringsArray, ...v: unknown[]) => {
      const t = squash(s.join('?'));
      order.push(t.includes('COUNT(*)') ? 'count' : t.startsWith('UPDATE') ? 'update' : 'select');
      return inner(s, ...v);
    });
    await retryCaptureRead(CO, ID, m.charge);
    expect(order).toEqual(['select', 'count', 'charge', 'update']);
  });
});

describe('retryCaptureRead: a race the UPDATE loses', () => {
  beforeEach(() => { db.updated = []; });

  it('the row went back to reading meanwhile (another retry won): being_read, nothing started', async () => {
    db.afterRace = failedRow({ read_state: 'reading', read_error: null, read_heartbeat_at: ago(0) });
    expect(await retryCaptureRead(CO, ID, m.charge)).toEqual({ ok: false, reason: 'being_read' });
    expect(m.runAfterCommit).not.toHaveBeenCalled();
  });

  it('the row was settled meanwhile (posted, rejected): not_retryable, nothing started', async () => {
    db.afterRace = failedRow({ status: 'rejected' });
    expect(await retryCaptureRead(CO, ID, m.charge)).toEqual({ ok: false, reason: 'not_retryable' });
    expect(m.runAfterCommit).not.toHaveBeenCalled();
  });

  it('the row vanished meanwhile: missing', async () => {
    db.afterRace = null;
    let selects = 0;
    m.sql.mockImplementation(async (strings: TemplateStringsArray) => {
      const t = squash(strings.join('?'));
      if (t.includes('COUNT(*)')) return [{ n: 0 }];
      if (t.startsWith('UPDATE')) return [];
      selects += 1;
      return selects === 1 ? [failedRow()] : [];
    });
    expect(await retryCaptureRead(CO, ID, m.charge)).toEqual({ ok: false, reason: 'missing' });
  });
});
