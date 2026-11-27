/**
 * The console's exit (runConsole.ts consoleApi) with fake system calls and a fake clock (R29-2, R29-4, B29-4, B29-2, R30-2, R30-3, R30-5):
 *   - the exit is asked once: a second ask keeps the first code and waits; exitNow (a second signal) says the cut and exits at once;
 *   - a total ceiling: a reader that trickles cannot hold the exit; past it only the stalled streams are given up, and that is said on
 *     the other stream (one try) before the exit; both stalled: one notice for both, best effort; a natural end gets the same ceiling,
 *     armed once (a later exit waits only what is left of it);
 *   - the exit always happens with its code, whatever a restore does. (Split from sageCliConsoleWriter.test.ts.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONSOLE_EXIT_CEILING_MS, CONSOLE_WAIT_MS, Console, consoleApi } from '../../../../scripts/sage-migration/runConsole';

type Step = number | 'EAGAIN' | 'EPIPE';
type Sys = NonNullable<Parameters<typeof consoleApi>[1]>;
/** The console's system side, faked: nothing of vitest's own fd 1 / 2 is touched; exits are recorded. */
const exits: Array<number | undefined> = [];
const nowWrites: Array<[number, string]> = [];
const sys = (over: Partial<Sys> = {}): Sys => ({ sameFile: () => false, blockingFds: () => [], capture: () => () => undefined, saveFlags: () => () => undefined,
  writeNow: (fd, text) => { nowWrites.push([fd, text]); return true; }, exit: (code) => { exits.push(code); }, onExit: () => undefined, ...over });
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

describe('R29-2 / R29-4 / B29-4 / B29-2: the exit', () => {
  afterEach(() => { vi.useRealTimers(); exits.length = 0; nowWrites.length = 0; });
  const stalledErr = () => rig((fd) => (fd === 2 ? 'EAGAIN' : 1000));
  it('asked once: a second ask (main\'s catch, the pool timeout, a stray error) keeps the first code and waits; nothing is cut', async () => {
    let open = false;
    const r = rig((fd) => (fd === 2 && !open ? 'EAGAIN' : 1000));
    const restored: string[] = [];
    const api = consoleApi(r.c, sys({ saveFlags: () => () => { restored.push('flags'); }, capture: () => () => { restored.push('writers'); } }));
    api.prepareConsole(() => null);
    api.say('THE STOP MESSAGE');
    const first = api.exitAfterConsole(4);
    const second = api.exitAfterConsole(2);
    expect(second).toBe(first);
    r.tick(5);
    expect(exits).toEqual([]); // still waiting for the reader
    open = true;
    r.tick(5);
    await first;
    expect(exits).toEqual([4]); // the first code, once
    expect(r.got[2]).toBe('THE STOP MESSAGE\n');
    expect(restored.sort()).toEqual(['flags', 'writers']); // B29-2, R29-8: the process put back as found
  });
  it('exitNow (a second signal): at once, the decided code; the cut is said on the other stream, with its size', () => {
    const r = stalledErr();
    const api = consoleApi(r.c, sys());
    api.prepareConsole(() => ({ path: '/tmp/r.json', finalWord: () => 'FINAL WORD' }));
    api.say('x'.repeat(99));
    void api.exitAfterConsole(4);
    api.exitNow();
    expect(exits).toEqual([4]);
    expect(nowWrites).toEqual([[1, "stderr: 100 bytes of what it was given were not written: a second signal ended the run at once; --report /tmp/r.json is where the run's report is written\n"],
      [1, 'FINAL WORD\n']]); // then the final word, on the stream with nothing queued
  });
  it(`a reader that keeps taking a byte now and then cannot hold the exit past ${CONSOLE_EXIT_CEILING_MS / 1000} s; the code is unchanged`, async () => {
    vi.useFakeTimers();
    let trickle = 0;
    const r = rig((fd) => (fd === 2 && trickle > 0 ? (trickle--, 1) : fd === 2 ? 'EAGAIN' : 1000));
    const api = consoleApi(r.c, sys());
    api.prepareConsole(() => null);
    api.say('y'.repeat(10_000));
    const done = api.exitAfterConsole(4);
    for (let t = 0; t < CONSOLE_EXIT_CEILING_MS - 20_000; t += 20_000) { trickle = 1; r.tick(20_000); } // a byte every 20 s: never 30 s without
    expect(exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(CONSOLE_EXIT_CEILING_MS);
    await done;
    expect(exits).toEqual([4]);
  });
});

describe('R30-2 / R30-3 / R30-5: the ceiling says what it cut; a natural end gets it too; the exit always happens', () => {
  afterEach(() => { vi.useRealTimers(); exits.length = 0; nowWrites.length = 0; });
  it('stderr stalled, stdout healthy: only stderr is given up at the ceiling, and that is said on stdout (one try) before the exit', async () => {
    vi.useFakeTimers();
    const r = rig((fd) => (fd === 2 ? 'EAGAIN' : 1000));
    const api = consoleApi(r.c, sys());
    api.prepareConsole(() => ({ path: '/tmp/r.json', finalWord: () => 'FINAL WORD' }));
    api.say('THE STOP MESSAGE');
    api.out('summary');
    const done = api.exitAfterConsole(4);
    await vi.advanceTimersByTimeAsync(CONSOLE_EXIT_CEILING_MS);
    await done;
    expect(r.c.gone).toEqual({ stdout: false, stderr: true });
    expect(nowWrites).toEqual([[1, `stderr: the exit waited ${CONSOLE_EXIT_CEILING_MS / 1000} s for its reader: the rest of what it was given (the stop message or the summary among it) was dropped; --report /tmp/r.json is where the run's report is written\n`],
      [1, 'FINAL WORD\n']]);
    expect(exits).toEqual([4]);
  });
  it('both stalled: ONE notice for both, on stderr, best effort (L2: never one per stream into a stalled, half-written queue)', async () => {
    vi.useFakeTimers();
    const r = rig(() => 'EAGAIN');
    const api = consoleApi(r.c, sys());
    api.prepareConsole(() => null);
    api.say('stop');
    api.out('summary');
    const done = api.exitAfterConsole(4);
    await vi.advanceTimersByTimeAsync(CONSOLE_EXIT_CEILING_MS);
    await done;
    expect(nowWrites).toEqual([[2, `\nstdout and stderr: the exit waited ${CONSOLE_EXIT_CEILING_MS / 1000} s for its reader: the rest of what they were given was dropped; give --report <path>: a pipe holds only a few KiB, and a large run says more\n`]]);
    expect(exits).toEqual([4]);
  });
  it('B32-2: 2>&1 (one file), both stalled: no notice at all (it would go into the very pipe just given up)', async () => {
    vi.useFakeTimers();
    const r = rig(() => 'EAGAIN');
    const api = consoleApi(r.c, sys({ sameFile: () => true }));
    api.prepareConsole(() => null);
    api.say('stop');
    api.out('summary');
    const done = api.exitAfterConsole(4);
    await vi.advanceTimersByTimeAsync(CONSOLE_EXIT_CEILING_MS);
    await done;
    expect(nowWrites).toEqual([]);
    expect(exits).toEqual([4]);
  });
  it('armed once: an exit asked after a natural end waits only what is left of the ceiling (an uncaught error at +100 s exits at +120 s)', async () => {
    vi.useFakeTimers();
    const r = rig((fd) => (fd === 2 ? 'EAGAIN' : 1000));
    const api = consoleApi(r.c, sys());
    api.prepareConsole(() => null);
    api.say('the closing line');
    api.endConsole();
    await vi.advanceTimersByTimeAsync(100_000);
    api.say('an uncaught error: the run had finished; its report and exit code stand');
    const done = api.exitAfterConsole(4);
    await vi.advanceTimersByTimeAsync(20_000);
    await done;
    expect(exits).toEqual([4]);
  });
  it('armed once: once it has passed, a later exit waits for no stalled stream at all', async () => {
    vi.useFakeTimers();
    let outStalled = false;
    const r = rig((fd) => (fd === 2 || outStalled ? 'EAGAIN' : 1000));
    const api = consoleApi(r.c, sys());
    api.prepareConsole(() => null);
    api.say('the closing line');
    api.endConsole();
    await vi.advanceTimersByTimeAsync(CONSOLE_EXIT_CEILING_MS);
    expect(r.c.gone).toEqual({ stdout: false, stderr: true });
    outStalled = true;
    api.out('a late line');
    await api.exitAfterConsole(4); // at once: no timer is advanced
    expect(r.c.gone.stdout).toBe(true);
    expect(exits).toEqual([4]);
  });
  it('R30-3: a run that ends by itself (endConsole) gets the same ceiling, and no exit is forced', async () => {
    vi.useFakeTimers();
    const r = rig((fd) => (fd === 2 ? 'EAGAIN' : 1000));
    const api = consoleApi(r.c, sys());
    api.prepareConsole(() => null);
    api.say('the closing line');
    api.endConsole();
    await vi.advanceTimersByTimeAsync(CONSOLE_EXIT_CEILING_MS);
    expect(r.c.gone.stderr).toBe(true);
    expect(r.c.idle()).toBe(true); // nothing left to hold the process
    expect(exits).toEqual([]);
  });
  it('R30-5: a restore that throws never skips the exit, nor its code', () => {
    const r = rig(() => 1000);
    const api = consoleApi(r.c, sys({ saveFlags: () => () => { throw new Error('fcntl failed'); } }));
    api.prepareConsole(() => null);
    void api.exitAfterConsole(4);
    expect(exits).toEqual([4]);
    expect(nowWrites).toEqual([[2, 'could not put the console back as found: fcntl failed\n']]); // through the one try (B31-1), said once
  });
  it('B32-3: a restore that fails is said BEFORE the flags are put back, so its one try cannot leave fd 2 non-blocking', () => {
    const order: string[] = [];
    const r = rig(() => 1000);
    const api = consoleApi(r.c, sys({ saveFlags: () => () => { order.push('flags put back'); }, capture: () => () => { throw new Error('writers'); },
      writeNow: (_fd, text) => { order.push(text.trim()); return true; } }));
    api.prepareConsole(() => null);
    void api.exitAfterConsole(4);
    expect(order).toEqual(['could not put the console back as found: writers', 'flags put back']);
    expect(exits).toEqual([4]);
  });
});

describe('B33-1 / B33-2: what every notice says of --report, and the natural end\'s restores', () => {
  afterEach(() => { vi.useRealTimers(); exits.length = 0; nowWrites.length = 0; });
  const VIEW = { path: '/tmp/r.json', finalWord: () => 'THE FINAL WORD' };
  const LINE = "--report /tmp/r.json is where the run's report is written";
  it('every notice names where --report is, never what it holds: no reader, closed, the ceiling (one stream, both), the cut', async () => {
    vi.useFakeTimers();
    const notices: string[] = [];
    let step: (fd: number) => Step = (fd) => (fd === 2 ? 'EAGAIN' : 1000);
    const r = rig((fd) => step(fd));
    const api = consoleApi(r.c, sys({ writeNow: (_fd, text) => { notices.push(text); return true; } }));
    api.prepareConsole(() => VIEW);
    api.say('x');
    r.tick(CONSOLE_WAIT_MS); // stderr: no reader
    const closed = rig((fd) => (fd === 1 ? 'EPIPE' : 1000));
    const apiC = consoleApi(closed.c, sys());
    apiC.prepareConsole(() => VIEW);
    apiC.out('SUMMARY'); // stdout closed
    const one = rig((fd) => (fd === 2 ? 'EAGAIN' : 1000));
    const api1 = consoleApi(one.c, sys({ writeNow: (_fd, text) => { notices.push(text); return true; } }));
    api1.prepareConsole(() => VIEW);
    api1.say('stop');
    void api1.exitAfterConsole(4);
    await vi.advanceTimersByTimeAsync(CONSOLE_EXIT_CEILING_MS); // the ceiling, one stream
    const both = rig(() => 'EAGAIN');
    const api2 = consoleApi(both.c, sys({ writeNow: (_fd, text) => { notices.push(text); return true; } }));
    api2.prepareConsole(() => VIEW);
    api2.say('stop');
    api2.out('summary');
    void api2.exitAfterConsole(4);
    await vi.advanceTimersByTimeAsync(CONSOLE_EXIT_CEILING_MS); // the ceiling, both
    const cut = rig((fd) => (fd === 2 ? 'EAGAIN' : 1000));
    const api3 = consoleApi(cut.c, sys({ writeNow: (_fd, text) => { notices.push(text); return true; } }));
    api3.prepareConsole(() => VIEW);
    api3.say('stop');
    api3.exitNow(4); // the second signal's cut
    step = () => 1000;
    const all = [r.got[1], closed.got[2], ...notices.filter((t) => !t.includes('THE FINAL WORD'))];
    expect(all).toHaveLength(5);
    for (const text of all) expect(text).toContain(`; ${LINE}\n`);
    expect(notices.filter((t) => t.includes('THE FINAL WORD'))).toEqual(['THE FINAL WORD\n', 'THE FINAL WORD\n']); // the ceiling (one stream) and the cut; both gone: none
  });
  it('B33-2: the natural end puts each back on its own (a throwing restore is said, the flags still last) and never throws', () => {
    const order: string[] = [];
    let atExit: () => void = () => undefined;
    const r = rig(() => 1000);
    const api = consoleApi(r.c, sys({ saveFlags: () => () => { order.push('flags put back'); }, capture: () => () => { throw new Error('writers'); },
      writeNow: (_fd, text) => { order.push(text.trim()); return true; }, onExit: (fn) => { atExit = fn; } }));
    api.prepareConsole(() => null);
    expect(() => atExit()).not.toThrow(); // a throw in the 'exit' listener would turn the exit code to 1
    expect(order).toEqual(['could not put the console back as found: writers', 'flags put back']);
    expect(exits).toEqual([]); // the natural end forces no exit
  });
  it('B34-2 / R34-5: a restore that throws a hostile value (and a flags restore that throws) never escapes; the final word comes first', () => {
    const order: string[] = [];
    let atExit: () => void = () => undefined;
    const hostile = { toString: () => { throw new Error('hostile toString'); } };
    const r = rig(() => 1000);
    const api = consoleApi(r.c, sys({ saveFlags: () => () => { order.push('flags'); throw new Error('fcntl failed'); }, capture: () => () => { throw hostile; },
      writeNow: (_fd, text) => { order.push(text.trim()); return true; }, onExit: (fn) => { atExit = fn; } }));
    api.prepareConsole(() => ({ path: '/tmp/r.json', finalWord: () => 'THE FINAL WORD' }));
    expect(() => atExit()).not.toThrow();
    expect(order).toEqual(['THE FINAL WORD', 'could not put the console back as found: an error whose message cannot be read', 'flags',
      'could not put the console back as found: fcntl failed']);
    expect(exits).toEqual([]);
  });
  it('round 34: a stream given up is not alive, even if a write to it would be taken now: the final word goes to the other', async () => {
    let errStalled = true;
    const r = rig((fd) => (fd === 2 && errStalled ? 'EAGAIN' : 1000));
    const api = consoleApi(r.c, sys());
    api.prepareConsole(() => ({ path: '/tmp/r.json', finalWord: () => 'THE FINAL WORD' }));
    api.say('x');
    r.tick(CONSOLE_WAIT_MS); // stderr given up: no reader within 30 s
    errStalled = false; // its reader is back: still given up
    await api.exitAfterConsole(4);
    expect(nowWrites.filter(([, t]) => t.includes('THE FINAL WORD'))).toEqual([[1, 'THE FINAL WORD\n']]);
  });
});

