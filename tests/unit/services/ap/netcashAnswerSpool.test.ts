/**
 * AP-01 residual 3a: Netcash's answer when neither the settle nor the audit_log insert could record it. The third
 * durable store is a spool on local disk: one JSON line per answer (the metadata the audit record carries), appended
 * and fsynced, outside the deploy directory (deploy.sh rsyncs --delete over /home/velo/isaflow). It must never throw into
 * the request, must be bounded, and resolve reads it by company and submission.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const logged = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: logged }));

import {
  markReplayed, pendingSpooled, spoolAnswer, spooledAcceptedAnswer, spoolDir, type AnswerRecord,
} from '@/modules/accounting/services/ap/netcashAnswerSpool';
import { ANSWER_SPOOL_TIMEOUT_MS } from '@/modules/accounting/services/ap/netcashTimeouts';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER_COMPANY = '22222222-2222-4222-8222-222222222222';
const SUBMISSION = '33333333-3333-4333-8333-333333333333';
const TOKEN = '44444444-4444-4444-8444-444444444444';

const record = (over: Partial<AnswerRecord> & { status?: string; outcome?: string } = {}): AnswerRecord => ({
  companyId: over.companyId ?? COMPANY, userId: 'user-1', sub: 'user-1', submissionId: over.submissionId ?? SUBMISSION, entityRef: 'NC-SPOOL',
  metadata: { status: over.status ?? 'submitted', outcome: over.outcome ?? 'accepted', batchReference: 'NC-SPOOL', settleToken: TOKEN, answer: '{"outcome":"accepted"}' },
});

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-unit-'));
  process.env.NETCASH_ANSWER_SPOOL_DIR = path.join(dir, 'spool');
  Object.values(logged).forEach((f) => f.mockReset());
});
afterEach(() => {
  delete process.env.NETCASH_ANSWER_SPOOL_DIR;
  vi.useRealTimers(); vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('spoolAnswer', () => {
  it('appends ONE complete JSON line with the whole answer, in a 0700 directory, file 0600', async () => {
    expect(await spoolAnswer(record())).toBe(true);
    const files = fs.readdirSync(spoolDir());
    expect(files).toHaveLength(1);
    const text = fs.readFileSync(path.join(spoolDir(), files[0]!), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(text)).toMatchObject({
      v: 1, companyId: COMPANY, userId: 'user-1', submissionId: SUBMISSION, entityRef: 'NC-SPOOL',
      metadata: { status: 'submitted', outcome: 'accepted', batchReference: 'NC-SPOOL', settleToken: TOKEN, answer: '{"outcome":"accepted"}' },
    });
    expect(fs.statSync(spoolDir()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(spoolDir(), files[0]!)).mode & 0o777).toBe(0o600);
  });

  it('fsyncs the file after the write and before it counts as spooled (and the directory entry too)', async () => {
    const order: string[] = [];
    const handle = await fs.promises.open(path.join(dir, 'probe'), 'w');
    const proto = Object.getPrototypeOf(handle) as { write: unknown; sync: unknown };
    await handle.close();
    const realWrite = (proto.write as (...a: unknown[]) => Promise<unknown>);
    const realSync = (proto.sync as (...a: unknown[]) => Promise<unknown>);
    vi.spyOn(proto as { write: (...a: unknown[]) => Promise<unknown> }, 'write').mockImplementation(function (this: unknown, ...a: unknown[]) { order.push('write'); return realWrite.apply(this, a); });
    vi.spyOn(proto as { sync: (...a: unknown[]) => Promise<unknown> }, 'sync').mockImplementation(function (this: unknown) { order.push('sync'); return realSync.apply(this); });
    expect(await spoolAnswer(record())).toBe(true);
    expect(order.slice(0, 2)).toEqual(['write', 'sync']);
    expect(order.filter((o) => o === 'sync').length).toBeGreaterThanOrEqual(2); // the file, then its directory
  });

  it('an unwritable spool directory: false, log.error, never a throw', async () => {
    const blocker = path.join(dir, 'a-file');
    fs.writeFileSync(blocker, 'x');
    process.env.NETCASH_ANSWER_SPOOL_DIR = path.join(blocker, 'spool'); // a directory cannot be made below a file
    await expect(spoolAnswer(record())).resolves.toBe(false);
    expect(logged.error).toHaveBeenCalled();
  });

  it('a write that hangs is given up on after ANSWER_SPOOL_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    vi.spyOn(fs.promises, 'open').mockImplementation(() => new Promise(() => {}));
    const pending = spoolAnswer(record());
    await vi.advanceTimersByTimeAsync(ANSWER_SPOOL_TIMEOUT_MS + 1);
    await expect(pending).resolves.toBe(false);
    expect(logged.error).toHaveBeenCalled();
  });

  it('refuses ids that are not UUIDs (they become part of a file name)', async () => {
    expect(await spoolAnswer(record({ submissionId: '../../etc/passwd' }))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'spool'))).toBe(false);
  });

  it('NETCASH_ANSWER_SPOOL_DIR wins; otherwise a systemd STATE_DIRECTORY; the default is outside the deploy directory', () => {
    expect(spoolDir()).toBe(path.join(dir, 'spool'));
    delete process.env.NETCASH_ANSWER_SPOOL_DIR;
    process.env.STATE_DIRECTORY = '/var/lib/isaflow:/other';
    expect(spoolDir()).toBe('/var/lib/isaflow/netcash-spool');
    delete process.env.STATE_DIRECTORY;
    expect(spoolDir()).not.toContain('/home/velo/isaflow/');
  });
});

describe('spooledAcceptedAnswer (what resolve asks)', () => {
  it('finds an ACCEPTANCE for this company and submission, in any case of the id', async () => {
    await spoolAnswer(record());
    expect(await spooledAcceptedAnswer(COMPANY, SUBMISSION)).toEqual({ outcome: 'accepted', batchReference: 'NC-SPOOL' });
    expect(await spooledAcceptedAnswer(COMPANY.toUpperCase(), SUBMISSION.toUpperCase())).toEqual({ outcome: 'accepted', batchReference: 'NC-SPOOL' });
  });

  it("is company-scoped: another company's spooled answer naming this submission does not count", async () => {
    await spoolAnswer(record({ companyId: OTHER_COMPANY }));
    expect(await spooledAcceptedAnswer(COMPANY, SUBMISSION)).toBeNull();
  });

  it('only an acceptance blocks: an unknown or rejected answer, another submission, no spool at all, do not', async () => {
    expect(await spooledAcceptedAnswer(COMPANY, SUBMISSION)).toBeNull(); // no directory yet
    await spoolAnswer(record({ status: 'unknown', outcome: 'unknown' }));
    expect(await spooledAcceptedAnswer(COMPANY, SUBMISSION)).toBeNull();
    await spoolAnswer(record({ submissionId: '55555555-5555-4555-8555-555555555555' }));
    expect(await spooledAcceptedAnswer(COMPANY, SUBMISSION)).toBeNull();
  });

  it('a spool entry that cannot be read is treated as an acceptance (fail closed), never skipped', async () => {
    fs.mkdirSync(spoolDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(spoolDir(), `${COMPANY}.${SUBMISSION}.${TOKEN}.jsonl`), '{"v":1,"companyId":');
    expect(await spooledAcceptedAnswer(COMPANY, SUBMISSION)).not.toBeNull();
  });
});

describe('pendingSpooled / markReplayed', () => {
  it('lists unreplayed entries; a replayed one is renamed, kept (never deleted) and no longer listed or blocking', async () => {
    await spoolAnswer(record());
    const [entry] = await pendingSpooled();
    expect(entry?.entry).toMatchObject({ companyId: COMPANY, submissionId: SUBMISSION, metadata: { settleToken: TOKEN } });
    await markReplayed(entry!.file);
    expect(await pendingSpooled()).toEqual([]);
    expect(fs.readdirSync(spoolDir()).filter((f) => f.endsWith('.replayed'))).toHaveLength(1);
    expect(await spooledAcceptedAnswer(COMPANY, SUBMISSION)).toBeNull();
  });
});
