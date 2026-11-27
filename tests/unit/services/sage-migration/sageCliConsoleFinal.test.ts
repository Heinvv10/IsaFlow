/**
 * Round 35: where the console's final word about --report goes (runConsole.ts sayFinalWord), with fake system calls:
 *   - B35-1: a stream given up for a STALL (no reader within 30 s, or the ceiling) still gets one try, after the live ones, on a line of
 *     its own; one that FAILED (EPIPE, ENOSPC) is never tried;
 *   - R35-2: with 2>&1 (one lane) the "\n" prefix counts the lane's bytes, whichever stream queued them;
 *   - R35-4: a live stream with bytes queued gets the word on a line of its own;
 *   - R35-3: told() never throws, whatever the value (an Error whose message is a hostile object, a hostile non-Error).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONSOLE_EXIT_CEILING_MS, CONSOLE_WAIT_MS, Console, consoleApi, told } from '../../../../scripts/sage-migration/runConsole';

type Step = number | 'EAGAIN' | 'EPIPE';
type Sys = NonNullable<Parameters<typeof consoleApi>[1]>;
const nowWrites: Array<[number, string]> = [];
const exits: Array<number | undefined> = [];
const sys = (over: Partial<Sys> = {}): Sys => ({ sameFile: () => false, blockingFds: () => [], capture: () => () => undefined, saveFlags: () => () => undefined,
  writeNow: (fd, text) => { nowWrites.push([fd, text]); return true; }, exit: (code) => { exits.push(code); }, onExit: () => undefined, ...over });
function rig(take: (fd: number) => Step) {
  let clock = 0;
  const timers: Array<() => void> = [];
  const c = new Console({
    write: (fd, _buf, _offset, length) => { const step = take(fd); if (typeof step === 'string') throw Object.assign(new Error(step), { code: step }); return Math.min(step, length); },
    now: () => clock,
    later: (fn) => { timers.push(fn); },
  });
  return { c, tick: (ms: number) => { clock += ms; for (const fn of timers.splice(0)) fn(); } };
}
const VIEW = { path: '/tmp/r.json', finalWord: () => 'THE FINAL WORD' };
const finals = () => nowWrites.filter(([, t]) => t.includes('THE FINAL WORD'));
afterEach(() => { vi.useRealTimers(); nowWrites.length = 0; exits.length = 0; });

describe('B35-1: a stream given up for a stall still gets one try for the final word', () => {
  it('stdout failed (ENOSPC), stderr given up for no reader: the word is tried on stderr, on a line of its own', async () => {
    const r = rig((fd) => (fd === 1 ? 'EPIPE' : 'EAGAIN'));
    const api = consoleApi(r.c, sys());
    api.prepareConsole(() => VIEW);
    api.out('summary'); // stdout fails at once
    api.say('the stop message');
    r.tick(CONSOLE_WAIT_MS); // stderr: no reader within 30 s
    await api.exitAfterConsole(4);
    expect(finals()).toEqual([[2, '\nTHE FINAL WORD\n']]);
  });
  it('a stream that failed is never tried; a live one comes before a stalled one', async () => {
    const r = rig((fd) => (fd === 2 ? 'EAGAIN' : 1000));
    const api = consoleApi(r.c, sys());
    api.prepareConsole(() => VIEW);
    api.say('x');
    r.tick(CONSOLE_WAIT_MS); // stderr given up (stall); stdout live
    await api.exitAfterConsole(4);
    expect(finals()).toEqual([[1, 'THE FINAL WORD\n']]);
    nowWrites.length = 0;
    const f = rig(() => 'EPIPE'); // both failed
    const apiF = consoleApi(f.c, sys());
    apiF.prepareConsole(() => VIEW);
    apiF.out('summary');
    apiF.say('stop');
    await apiF.exitAfterConsole(4);
    expect(finals()).toEqual([]);
  });
  it('both given up at the ceiling (2>&1 too): one try, on a line of its own; the second only when the first is refused', async () => {
    vi.useFakeTimers();
    for (const shared of [false, true]) {
      nowWrites.length = 0;
      const r = rig(() => 'EAGAIN');
      const tries: number[] = [];
      const api = consoleApi(r.c, sys({ sameFile: () => shared, writeNow: (fd, text) => { nowWrites.push([fd, text]); if (!text.includes('FINAL')) return true; tries.push(fd); return tries.length > 1; } }));
      api.prepareConsole(() => VIEW);
      api.say('stop');
      api.out('summary');
      const done = api.exitAfterConsole(4);
      await vi.advanceTimersByTimeAsync(CONSOLE_EXIT_CEILING_MS);
      await done;
      expect(finals()).toEqual([[2, '\nTHE FINAL WORD\n'], [1, '\nTHE FINAL WORD\n']]); // stderr refused, then stdout
    }
  });
});

describe('R35-2 / R35-4: the "\\n" prefix counts what is queued on the stream\'s lane', () => {
  it('split: a live stream with bytes queued gets the word on a line of its own; one with none, plainly', () => {
    const r = rig((fd) => (fd === 2 ? 'EAGAIN' : 1000));
    const api = consoleApi(r.c, sys({ writeNow: (fd, text) => { nowWrites.push([fd, text]); return fd === 2; } })); // stdout refuses the word
    api.prepareConsole(() => VIEW);
    api.say('a stop message still queued');
    api.exitNow(4);
    expect(finals()).toEqual([[1, 'THE FINAL WORD\n'], [2, '\nTHE FINAL WORD\n']]); // nothing queued first; then the one with bytes
  });
  it('2>&1: bytes queued by stdout count for stderr too (one lane)', () => {
    const r = rig(() => 'EAGAIN');
    const api = consoleApi(r.c, sys({ sameFile: () => true }));
    api.prepareConsole(() => VIEW);
    api.out('the summary, queued on the shared lane');
    api.exitNow(4);
    expect(finals()).toEqual([[2, '\nTHE FINAL WORD\n']]);
  });
});

describe('R35-2: 2>&1, one stream of the lane cut at the ceiling', () => {
  it('the other (not given up, nothing queued) still gets the word on a line of its own: the pipe may end in a cut line', async () => {
    vi.useFakeTimers();
    const r = rig(() => 'EAGAIN');
    const api = consoleApi(r.c, sys({ sameFile: () => true }));
    api.prepareConsole(() => VIEW);
    api.say('the stop message, cut'); // only stderr has bytes queued: only it is given up at the ceiling
    const done = api.exitAfterConsole(4);
    await vi.advanceTimersByTimeAsync(CONSOLE_EXIT_CEILING_MS);
    await done;
    expect(r.c.gone).toEqual({ stdout: false, stderr: true });
    expect(finals()).toEqual([[1, '\nTHE FINAL WORD\n']]);
  });
});

describe('R35-3: told() never throws', () => {
  it('an Error whose message is a hostile object; a hostile non-Error; plain values', () => {
    const hostile = { toString: () => { throw new Error('hostile'); } };
    const e = new Error('x');
    Object.defineProperty(e, 'message', { value: hostile });
    expect(told(e)).toBe('an error whose message cannot be read');
    expect(told(hostile)).toBe('an error whose message cannot be read');
    const getter = new Error('y');
    Object.defineProperty(getter, 'message', { get: () => { throw new Error('getter'); } });
    expect(told(getter)).toBe('an error whose message cannot be read');
    expect(told(new Error('plain'))).toBe('plain');
    expect(told(42)).toBe('42');
  });
});
