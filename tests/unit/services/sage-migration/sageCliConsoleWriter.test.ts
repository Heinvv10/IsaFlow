/**
 * The console's writer (runConsole.ts Console) with fake system calls and a fake clock (R27-2, R28-1, R28-6, R28-7):
 *   - partial writes are looped, in order, to fd 2 for stderr and fd 1 for stdout;
 *   - a full pipe (EAGAIN) is retried on a timer, never by blocking the thread; nothing is lost;
 *   - each stream has its own budget of NO PROGRESS (Date.now): a byte taken starts it over; a stalled stdout never costs stderr its time;
 *   - past the budget, or on EPIPE, the stream is given up (said through onGiveUp, once), never written again, and nothing is thrown;
 *   - drained() resolves only once both streams are written or given up.
 */
import { describe, expect, it } from 'vitest';
import { CONSOLE_WAIT_MS, Console } from '../../../../scripts/sage-migration/runConsole';

type Step = number | 'EAGAIN' | 'EPIPE';
/** A console whose fd `fd` takes what `take(fd)` says each call (bytes, EAGAIN or EPIPE); time moves only by `tick`. */
function rig(take: (fd: number) => Step) {
  let clock = 0;
  const timers: Array<() => void> = [];
  const got: Record<number, string> = { 1: '', 2: '' };
  const all = { text: '' }; // both fds, in the order written
  const givenUp: Array<[string, string]> = [];
  const c = new Console({
    write: (fd, buf, offset, length) => {
      const step = take(fd);
      if (typeof step === 'string') throw Object.assign(new Error(step), { code: step });
      const n = Math.min(step, length);
      got[fd] += buf.subarray(offset, offset + n).toString('utf8');
      all.text += buf.subarray(offset, offset + n).toString('utf8');
      return n;
    },
    now: () => clock,
    later: (fn) => { timers.push(fn); },
  });
  c.onGiveUp = (stream, why) => { givenUp.push([stream, why]); };
  /** Moves the clock by `ms` and runs the retries that were due. */
  const tick = (ms: number) => { clock += ms; for (const fn of timers.splice(0)) fn(); };
  return { c, got, all, givenUp, tick, pending: () => timers.length };
}

describe('R27-2 / R28-7: writing', () => {
  it('loops on partial writes, in order, to fd 2 for stderr and fd 1 for stdout', () => {
    const r = rig(() => 3);
    r.c.write('stderr', 'abcdefghij\n');
    r.c.write('stdout', 'out\n');
    expect(r.got).toEqual({ 1: 'out\n', 2: 'abcdefghij\n' });
    expect(r.c.idle()).toBe(true);
  });
  it('a full pipe is retried on a timer (the thread is never held); what follows is kept in order', async () => {
    let full = true;
    const r = rig(() => (full ? 'EAGAIN' : 1000));
    r.c.write('stderr', 'committed: batch 881\n');
    r.c.write('stderr', 'committed: batch 882\n');
    expect(r.got[2]).toBe('');
    expect(r.pending()).toBe(1);
    let drained = false;
    void r.c.drained().then(() => { drained = true; });
    r.tick(5);
    await Promise.resolve();
    expect(drained).toBe(false);
    full = false;
    r.tick(5);
    await Promise.resolve();
    expect(r.got[2]).toBe('committed: batch 881\ncommitted: batch 882\n');
    expect(drained).toBe(true);
  });
});

describe('R28-1 / R28-6: a budget per stream, of no progress, on the clock', () => {
  it('a stalled stdout never costs stderr its time: stderr is written while stdout waits, and stdout alone is given up at the budget', () => {
    const r = rig((fd) => (fd === 1 ? 'EAGAIN' : 1000));
    r.c.write('stdout', 'SUMMARY\n');
    r.tick(CONSOLE_WAIT_MS - 1);
    r.c.write('stderr', 'the stop message\n');
    expect(r.got[2]).toBe('the stop message\n');
    expect(r.c.gone).toEqual({ stdout: false, stderr: false });
    r.tick(1);
    expect(r.c.gone).toEqual({ stdout: true, stderr: false });
    expect(r.givenUp).toEqual([['stdout', `no reader within ${CONSOLE_WAIT_MS / 1000} s`]]);
    r.c.write('stderr', 'closing line\n');
    expect(r.got[2]).toBe('the stop message\nclosing line\n');
  });
  it('each byte taken starts the budget over: a reader that pauses 20 s twice gets everything', () => {
    let open = 0;
    const r = rig(() => (open > 0 ? (open--, 1) : 'EAGAIN'));
    r.c.write('stderr', 'abc\n');
    r.tick(20_000);
    open = 1;
    r.tick(5); // one byte taken at 20 s
    r.tick(20_000); // 40 s since the start, 20 s since the last byte
    open = 10;
    r.tick(5);
    expect(r.got[2]).toBe('abc\n');
    expect(r.givenUp).toEqual([]);
  });
  it('given up: not written again, said once, nothing thrown; drained() resolves', async () => {
    const r = rig(() => 'EAGAIN');
    r.c.write('stderr', 'x\n');
    const drained = r.c.drained();
    r.tick(CONSOLE_WAIT_MS);
    await drained;
    r.c.write('stderr', 'y\n');
    expect(r.got[2]).toBe('');
    expect(r.givenUp).toHaveLength(1);
    expect(r.pending()).toBe(0);
  });
  it('EPIPE gives the stream up at once, no wait; the other stream is still written', () => {
    const r = rig((fd) => (fd === 1 ? 'EPIPE' : 1000));
    r.c.write('stdout', 'summary\n');
    expect(r.givenUp).toEqual([['stdout', 'EPIPE']]);
    expect(r.pending()).toBe(0);
    r.c.write('stderr', 'note\n');
    expect(r.got[2]).toBe('note\n');
  });
  it('a stream another writer found closed (markGone) is said once, and not written', () => {
    const r = rig(() => 1000);
    r.c.markGone('stdout', 'EPIPE');
    r.c.markGone('stdout', 'EPIPE');
    r.c.write('stdout', 'x\n');
    expect([r.givenUp, r.got[1]]).toEqual([[['stdout', 'EPIPE']], '']);
  });
});

describe('2>&1: one file, one queue (R28-1)', () => {
  it('lines of the two streams keep the order they were said in, never interleaved inside a line; the pipe\'s progress is both budgets', () => {
    let room = 0;
    const r = rig(() => (room > 0 ? (room -= 4, 4) : 'EAGAIN'));
    r.c.shared = true;
    r.c.write('stdout', 'SUMMARY LINE\n');
    r.c.write('stderr', 'the stop message\n');
    r.tick(20_000);
    room = 8;
    r.tick(5);
    r.tick(20_000); // 40 s in all, 20 s since the last byte: neither given up
    room = 1000;
    r.tick(5);
    expect(r.all.text).toBe('SUMMARY LINE\nthe stop message\n');
    expect(r.givenUp).toEqual([]);
  });
  it('no progress for the budget: both streams are given up (they are the one file)', () => {
    const r = rig(() => 'EAGAIN');
    r.c.shared = true;
    r.c.write('stdout', 'a\n');
    r.c.write('stderr', 'b\n');
    r.tick(CONSOLE_WAIT_MS);
    expect(r.c.gone).toEqual({ stdout: true, stderr: true });
    expect(r.c.idle()).toBe(true);
  });
});
