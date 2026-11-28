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
  writeNow: (fd, text) => { nowWrites.push([fd, text]); return Buffer.byteLength(text); }, exit: (code) => { exits.push(code); }, onExit: () => undefined, ...over });
const got: Record<number, string> = { 1: '', 2: '' };
function rig(take: (fd: number) => Step) {
  let clock = 0;
  const timers: Array<() => void> = [];
  const c = new Console({
    write: (fd, buf, offset, length) => {
      const step = take(fd);
      if (typeof step === 'string') throw Object.assign(new Error(step), { code: step });
      const n = Math.min(step, length);
      got[fd] += buf.subarray(offset, offset + n).toString('utf8');
      return n;
    },
    now: () => clock,
    later: (fn) => { timers.push(fn); },
  });
  return { c, tick: (ms: number) => { clock += ms; for (const fn of timers.splice(0)) fn(); } };
}
const VIEW = { path: '/tmp/r.json', finalWord: () => 'THE FINAL WORD' };
const finals = () => nowWrites.filter(([, t]) => t.includes('THE FINAL WORD'));
afterEach(() => { vi.useRealTimers(); nowWrites.length = 0; exits.length = 0; got[1] = ''; got[2] = ''; });

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
  it('both given up at the ceiling: one try, on a line of its own; the other fd only when it is another file (R36-4)', async () => {
    vi.useFakeTimers();
    for (const shared of [false, true]) {
      nowWrites.length = 0;
      const r = rig(() => 'EAGAIN');
      const tries: number[] = [];
      const api = consoleApi(r.c, sys({ sameFile: () => shared, writeNow: (fd, text) => { nowWrites.push([fd, text]); if (!text.includes('FINAL')) return Buffer.byteLength(text); tries.push(fd); return tries.length > 1 ? Buffer.byteLength(text) : 0; } }));
      api.prepareConsole(() => VIEW);
      api.say('stop');
      api.out('summary');
      const done = api.exitAfterConsole(4);
      await vi.advanceTimersByTimeAsync(CONSOLE_EXIT_CEILING_MS);
      await done;
      // split: stderr refused, then stdout; 2>&1: one pipe, so the refusal stands for both fds
      expect(finals()).toEqual(shared ? [[2, '\nTHE FINAL WORD\n']] : [[2, '\nTHE FINAL WORD\n'], [1, '\nTHE FINAL WORD\n']]);
    }
  });
});

describe('B36-2: a short write of the final word', () => {
  for (const shared of [false, true]) {
    it(`${shared ? '2>&1' : 'split'}: part of it taken is said: its fragment is ended with a newline, and nothing is said after it`, () => {
      const r = rig(() => 1000);
      const api = consoleApi(r.c, sys({ sameFile: () => shared, writeNow: (fd, text) => { nowWrites.push([fd, text]); return text.includes('FINAL') ? 7 : Buffer.byteLength(text); } }));
      api.prepareConsole(() => VIEW);
      api.exitNow(4);
      expect(nowWrites).toEqual([[2, 'THE FINAL WORD\n'], [2, '\n']]); // the fragment "THE FIN" ends its line; stdout never gets a second copy
    });
  }
});

describe('R35-2 / R35-4: the "\\n" prefix counts what is queued on the stream\'s lane', () => {
  it('split: a live stream with bytes queued gets the word on a line of its own; one with none, plainly', () => {
    const r = rig((fd) => (fd === 2 ? 'EAGAIN' : 1000));
    const api = consoleApi(r.c, sys({ writeNow: (fd, text) => { nowWrites.push([fd, text]); return fd === 2 ? Buffer.byteLength(text) : 0; } })); // stdout refuses the word
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

describe('B37-3 / R37-5: the final word within PIPE_BUF; a try that took only the prefix said nothing', () => {
  it('a path that would make the line longer than PIPE_BUF is shortened in it: the claim is whole, the line at most 4094 bytes', async () => {
    const path = `/tmp/${'d'.repeat(5000)}/r.json`;
    const r = rig(() => 1000);
    const api = consoleApi(r.c, sys());
    api.prepareConsole(() => ({ path, finalWord: () => `--report ${path} holds the run's report` }));
    await api.exitAfterConsole(4);
    const [[, text]] = nowWrites.filter(([, t]) => t.includes("holds the run's report"));
    expect(Buffer.byteLength(text!)).toBeLessThanOrEqual(4096);
    expect(text).toMatch(/^--report \.\.\.d+\/r\.json \(its path shortened: 5012 bytes\) holds the run's report\n$/);
  });
  it('a line within PIPE_BUF is left as it is', async () => {
    const r = rig(() => 1000);
    const api = consoleApi(r.c, sys());
    api.prepareConsole(() => VIEW);
    await api.exitAfterConsole(4);
    expect(finals()).toEqual([[2, 'THE FINAL WORD\n']]); // stderr, whole
  });
  it('only the "\\n" prefix taken: nothing of the word was said, so no fragment is ended (nothing claims it was said)', async () => {
    const r = rig((fd) => (fd === 2 ? 'EAGAIN' : 1000));
    const api = consoleApi(r.c, sys({ writeNow: (fd, text) => { nowWrites.push([fd, text]); return fd === 1 ? 0 : text.startsWith('\n') ? 1 : Buffer.byteLength(text); } }));
    api.prepareConsole(() => VIEW);
    api.say('x');
    r.tick(CONSOLE_WAIT_MS); // stderr given up for a stall: tried after stdout, on a line of its own
    await api.exitAfterConsole(4);
    expect(nowWrites.filter(([, t]) => t.includes('FINAL') || t === '\n')).toEqual([[1, 'THE FINAL WORD\n'], [2, '\nTHE FINAL WORD\n']]); // no "\n" after it
  });
});

describe('R36-6: why a stream was given up is the reason passed in, never parsed back from the words', () => {
  it('a stream that FAILED with an error whose words look like a stall is closed: said so, and never tried for the final word', async () => {
    const r = rig(() => 1000);
    const api = consoleApi(r.c, sys());
    api.prepareConsole(() => VIEW);
    r.c.markGone('stderr', 'no reader within 30 s'); // an error event's message (runEnd's stream handler): the reason is 'error'
    expect(r.c.goneFor.stderr).toBe('error');
    expect(got[1]).toBe("stderr is closed (no reader within 30 s): what it was given is not printed there; --report /tmp/r.json is where the run's report is written\n");
    await api.exitAfterConsole(4);
    expect(finals()).toEqual([[1, 'THE FINAL WORD\n']]); // stdout only
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

describe('B38-3 / R38-1: the PIPE_BUF fit cuts by index, on a character, and fits the "could not be told" line too', () => {
  const said = async (view: { path: string; finalWord: () => string }): Promise<string> => {
    const r = rig(() => 1000);
    const api = consoleApi(r.c, sys());
    api.prepareConsole(() => view);
    await api.exitAfterConsole(4);
    const [[, text]] = nowWrites.filter(([fd]) => fd === 2);
    return text!;
  };
  for (const pattern of ['$&', "$'", '$`', '$$']) {
    it(`a path holding ${pattern}: no replacement pattern is applied; the claim whole, the tail the path's own`, async () => {
      const path = `/k/${'s/'.repeat(2000)}q${pattern}${'p'.repeat(245)}/r.json`;
      const text = await said({ path, finalWord: () => `--report ${path} holds the run's report` });
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
      const m = /^--report \.\.\.(.*) \(its path shortened: (\d+) bytes\) holds the run's report\n$/s.exec(text);
      expect(m).not.toBeNull();
      expect(path.endsWith(m![1]!)).toBe(true);
      expect(m![1]).toContain(`q${pattern}p`);
      expect(Number(m![2])).toBe(Buffer.byteLength(path));
    });
  }
  it('a multi-byte path: cut on a character (no U+FFFD), the shown tail is the path\'s own, the line within PIPE_BUF', async () => {
    for (const end of ['/r.json', '/rr.json', '/rrr.json']) { // the claim's length moves the cut onto each byte of a character
      const p = `/k/${'é'.repeat(1500)}${'€'.repeat(1000)}${end}`;
      const text = await said({ path: p, finalWord: () => `--report ${p} holds the run's report` });
      nowWrites.length = 0;
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
      expect(text).not.toContain('�');
      const tail = /^--report \.\.\.(.*) \(its path shortened/s.exec(text)![1]!;
      expect(p.endsWith(tail)).toBe(true);
      expect(Buffer.byteLength(text)).toBeGreaterThan(4090); // the room is used, not left by a fixed margin
    }
  });
  it('no room left for any of the path (keep <= 0): none of it shown, never the whole path; the line within PIPE_BUF', async () => {
    const path = `/k/${'d'.repeat(5000)}/r.json`;
    const text = await said({ path, finalWord: () => `--report ${path} ${'w'.repeat(4100)}` });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
    expect(text.slice(0, 60)).toBe('--report ... (its path shortened: 5010 bytes) wwwwwwwwwwwwww');
    expect(text.endsWith('\n')).toBe(true);
    for (const lead of ['', 'a', 'ab']) { // a multi-byte claim cut on each byte of a character: never a U+FFFD, never past PIPE_BUF
      nowWrites.length = 0;
      const cut = await said({ path, finalWord: () => `--report ${path} ${lead}${'€'.repeat(1400)}` });
      expect(cut).not.toContain('\uFFFD');
      expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(4096);
    }
  });
  it('a "could not be told" line with a long error text: its text shortened, its claim whole', async () => {
    const text = await said({ path: '/k/r.json', finalWord: () => { throw new Error(`€${'x'.repeat(5000)}END`); } });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
    expect(text).toMatch(/^--report: what it holds could not be told \(\.\.\.x+END \(its text shortened: 5006 bytes\)\): check the books\n$/);
  });
});
