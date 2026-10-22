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
  markReplayed, pendingSpooled, quarantineEntry, spoolAnswer, spooledAcceptedAnswer, spoolDir, sweepStaleTemps, type AnswerRecord,
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

const entries = (d = spoolDir()) => fs.readdirSync(d).filter((f) => f.endsWith('.jsonl') && !f.startsWith('.'));

describe('spoolAnswer', () => {
  it('appends ONE complete JSON line with the whole answer, in a 0700 directory, file 0600', async () => {
    expect(await spoolAnswer(record())).toBe(true);
    const files = entries();
    expect(fs.readdirSync(spoolDir()).filter((f) => f.endsWith('.tmp'))).toEqual([]); // the temp was renamed away
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

describe('a file is complete or absent (written to a temp name, fsynced, renamed)', () => {
  it('a write that dies half way leaves NO final-named file (nothing torn masquerading as an entry, nothing replayed); its temp stays and fails closed', async () => {
    const handle = await fs.promises.open(path.join(dir, 'probe'), 'w');
    const proto = Object.getPrototypeOf(handle) as { write: (...a: unknown[]) => Promise<unknown> };
    await handle.close();
    const realWrite = proto.write;
    vi.spyOn(proto, 'write').mockImplementation(async function (this: unknown, data: unknown) {
      await realWrite.call(this, String(data).slice(0, 20)); // half the line reaches the disk...
      throw new Error('ENOSPC: no space left on device'); // ...then the disk fills
    });
    expect(await spoolAnswer(record())).toBe(false);
    expect(entries()).toEqual([]);
    expect(await pendingSpooled()).toEqual([]);
    expect(fs.readdirSync(spoolDir()).filter((f) => f.endsWith('.tmp'))).toHaveLength(1);
    expect(await spooledAcceptedAnswer(COMPANY, SUBMISSION)).not.toBeNull(); // the answer may have been accepted: not freed on a guess
  });

  it('a temp for this submission blocks (fail closed: its write may be in flight or never reached the rename), is never replayed, and unrelated temps do not block', async () => {
    fs.mkdirSync(spoolDir(), { recursive: true, mode: 0o700 });
    const tempOf = (sub: string, rand: string) => path.join(spoolDir(), `.${COMPANY}.${sub}.${TOKEN}.jsonl.${rand}.tmp`);
    fs.writeFileSync(tempOf('55555555-5555-4555-8555-555555555555', 'aaaa'), '{"v":1,"companyId":');
    expect(await spooledAcceptedAnswer(COMPANY, SUBMISSION)).toBeNull(); // another submission's temp
    fs.writeFileSync(tempOf(SUBMISSION, 'bbbb'), '{"v":1,"companyId":'); // torn: cannot be judged
    expect(await spooledAcceptedAnswer(COMPANY, SUBMISSION)).not.toBeNull();
    expect(await pendingSpooled()).toEqual([]); // a temp is never an entry to replay
  });

  it('a COMPLETE temp is judged by what it says: an acceptance blocks, an unknown answer does not', async () => {
    fs.mkdirSync(spoolDir(), { recursive: true, mode: 0o700 });
    const line = (status: string) => `${JSON.stringify({ v: 1, ...record({ status, outcome: status === 'submitted' ? 'accepted' : 'unknown' }), spooledAt: 'x' })}\n`;
    const temp = path.join(spoolDir(), `.${COMPANY}.${SUBMISSION}.${TOKEN}.jsonl.cccc.tmp`);
    fs.writeFileSync(temp, line('unknown'));
    expect(await spooledAcceptedAnswer(COMPANY, SUBMISSION)).toBeNull();
    fs.writeFileSync(temp, line('submitted'));
    expect(await spooledAcceptedAnswer(COMPANY, SUBMISSION)).toEqual({ outcome: 'accepted', batchReference: 'NC-SPOOL' });
  });

  it('a COMPLETE stale temp (crash after fsync, before the rename) is promoted to a final entry - listed for replay, still blocking; an unparseable one goes to quarantine/ and keeps blocking', async () => {
    fs.mkdirSync(spoolDir(), { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify({ v: 1, ...record(), spooledAt: 'x' })}\n`;
    const stale = path.join(spoolDir(), `.${COMPANY}.${SUBMISSION}.${TOKEN}.jsonl.aaaa.tmp`);
    const fresh = path.join(spoolDir(), `.${COMPANY}.55555555-5555-4555-8555-555555555555.${TOKEN}.jsonl.bbbb.tmp`);
    fs.writeFileSync(stale, line); fs.writeFileSync(fresh, '{"v":1,"companyId":');
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(stale, old, old);
    await sweepStaleTemps();
    expect({ staleGone: !fs.existsSync(stale), freshStays: fs.existsSync(fresh), final: entries(), quarantine: fs.existsSync(path.join(spoolDir(), 'quarantine')) })
      .toEqual({ staleGone: true, freshStays: true, final: [`${COMPANY}.${SUBMISSION}.${TOKEN}.jsonl`], quarantine: false });
    expect((await pendingSpooled()).map((e) => e.entry.submissionId)).toEqual([SUBMISSION]); // replayed like any final entry
    expect(await spooledAcceptedAnswer(COMPANY, SUBMISSION)).toEqual({ outcome: 'accepted', batchReference: 'NC-SPOOL' });
    // an unparseable one swept the same way is quarantined under a final-style name and stays fail-closed
    fs.rmSync(path.join(spoolDir(), `${COMPANY}.${SUBMISSION}.${TOKEN}.jsonl`));
    const torn = path.join(spoolDir(), `.${COMPANY}.${SUBMISSION}.${TOKEN}.jsonl.dddd.tmp`);
    fs.writeFileSync(torn, '{"v":1,');
    fs.utimesSync(torn, old, old);
    await sweepStaleTemps();
    const quarantined = fs.readdirSync(path.join(spoolDir(), 'quarantine'));
    expect({ n: quarantined.length, finalStyle: quarantined.every((n) => n.endsWith('.jsonl') && !n.startsWith('.')) }).toEqual({ n: 1, finalStyle: true });
    expect(await spooledAcceptedAnswer(COMPANY, SUBMISSION)).not.toBeNull();
    expect(await pendingSpooled()).toEqual([]);
  });

  it('a FINAL-named entry that cannot be read stays fail-closed, with log.error', async () => {
    fs.mkdirSync(spoolDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(spoolDir(), `${COMPANY}.${SUBMISSION}.${TOKEN}.jsonl`), '{"v":1,"companyId":');
    expect(await spooledAcceptedAnswer(COMPANY, SUBMISSION)).not.toBeNull();
    expect(logged.error).toHaveBeenCalled();
  });
});

describe('pendingSpooled reads only what the caller will use', () => {
  it('stops reading once max entries are read, and reads nothing past the deadline', async () => {
    for (let i = 0; i < 5; i++) {
      const rec = record({ submissionId: `0000000${i}-5555-4555-8555-555555555555` });
      rec.metadata.settleToken = `0000000${i}-4444-4444-8444-444444444444`;
      expect(await spoolAnswer(rec)).toBe(true);
    }
    const reads = vi.spyOn(fs.promises, 'readFile');
    expect((await pendingSpooled({ max: 2 })).length).toBe(2);
    expect(reads.mock.calls.length).toBe(2);
    reads.mockClear();
    expect(await pendingSpooled({ deadline: Date.now() - 1 })).toEqual([]);
    expect(reads.mock.calls.length).toBe(0);
    reads.mockClear();
    expect((await pendingSpooled()).length).toBe(5);
  });
});

describe('an unreadable entry is reported once per process, not on every replay', () => {
  it('pendingSpooled (every submit) and the resolve lookup log.error a torn final-named file ONCE; a second bad file is its own report', async () => {
    fs.mkdirSync(spoolDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(spoolDir(), `${COMPANY}.${SUBMISSION}.${TOKEN}.jsonl`), '{"v":1,"companyId":');
    for (let i = 0; i < 4; i++) await pendingSpooled();
    await spooledAcceptedAnswer(COMPANY, SUBMISSION);
    expect(logged.error).toHaveBeenCalledTimes(1);
    fs.writeFileSync(path.join(spoolDir(), `${COMPANY}.55555555-5555-4555-8555-555555555555.${TOKEN}.jsonl`), 'not json');
    for (let i = 0; i < 3; i++) await pendingSpooled();
    expect(logged.error).toHaveBeenCalledTimes(2);
  });
});

describe('the directory', () => {
  it('an existing group/world-accessible directory is narrowed to 0700', async () => {
    fs.mkdirSync(spoolDir(), { recursive: true, mode: 0o755 });
    fs.chmodSync(spoolDir(), 0o755);
    expect(await spoolAnswer(record())).toBe(true);
    expect(fs.statSync(spoolDir()).mode & 0o777).toBe(0o700);
  });

  it('probeSpoolWritable log.errors ONCE per process when the directory is not writable, and is silent when it is', async () => {
    vi.resetModules();
    const fresh = await import('@/modules/accounting/services/ap/netcashAnswerSpool');
    const blocker = path.join(dir, 'a-file');
    fs.writeFileSync(blocker, 'x');
    process.env.NETCASH_ANSWER_SPOOL_DIR = path.join(blocker, 'spool');
    const first = await fresh.probeSpoolWritable();
    const second = await fresh.probeSpoolWritable();
    expect({ first, second, errors: logged.error.mock.calls.filter(([m]) => /NOT writable/.test(String(m))).length }).toEqual({ first: false, second: true, errors: 1 });

    vi.resetModules();
    logged.error.mockReset();
    process.env.NETCASH_ANSWER_SPOOL_DIR = path.join(dir, 'ok-spool');
    const ok = await (await import('@/modules/accounting/services/ap/netcashAnswerSpool')).probeSpoolWritable();
    expect({ ok, errors: logged.error.mock.calls.length, probeLeft: fs.readdirSync(path.join(dir, 'ok-spool')) }).toEqual({ ok: true, errors: 0, probeLeft: [] });
  });
});

describe('pendingSpooled / markReplayed / quarantineEntry', () => {
  it('lists unreplayed entries; a replayed one moves to replayed/ (kept, never deleted), is no longer listed or blocking; a repeat is not an error', async () => {
    await spoolAnswer(record());
    const [entry] = await pendingSpooled();
    expect(entry?.entry).toMatchObject({ companyId: COMPANY, submissionId: SUBMISSION, metadata: { settleToken: TOKEN } });
    await markReplayed(entry!.file);
    await expect(markReplayed(entry!.file)).resolves.toBeUndefined(); // a peer got there first
    expect(await pendingSpooled()).toEqual([]);
    expect(fs.readdirSync(path.join(spoolDir(), 'replayed'))).toHaveLength(1);
    expect(entries()).toEqual([]);
    expect(await spooledAcceptedAnswer(COMPANY, SUBMISSION)).toBeNull();
  });

  it('a QUARANTINED acceptance still blocks (the lookup reads quarantine/), and is not listed for replay', async () => {
    await spoolAnswer(record());
    const [entry] = await pendingSpooled();
    await quarantineEntry(entry!.file);
    expect(await pendingSpooled()).toEqual([]);
    expect(fs.readdirSync(path.join(spoolDir(), 'quarantine'))).toHaveLength(1);
    expect(await spooledAcceptedAnswer(COMPANY, SUBMISSION)).toEqual({ outcome: 'accepted', batchReference: 'NC-SPOOL' });
  });
});
