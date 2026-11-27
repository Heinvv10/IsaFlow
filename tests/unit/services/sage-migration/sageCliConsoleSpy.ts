/**
 * For the CLI tests that capture the console with spies on process.stdout.write / process.stderr.write: runConsole's one console, its
 * writes (fs.writeSync to fd 1 / 2, R27-2, R28-1) sent to those methods instead, so the spies see every line. Used as
 * `vi.mock('../../../../scripts/sage-migration/runConsole', async (orig) => (await import('./sageCliConsoleSpy')).spied(await orig()))`.
 * The real writer is tested on its own (sageCliConsole.test.ts), through a real pipe. `cliConsole.through` lists what went through the
 * console (by fd), so a test can tell a line the console wrote from one written to the stream directly (R27-2: never). A test can stall a
 * stream (EAGAIN, or EPIPE: gone) through globalThis.__sageConsoleStall; its 'exit' listeners are kept for the test (exitListeners).
 */
type ConsoleModule = typeof import('../../../../scripts/sage-migration/runConsole');

type Stall = Partial<Record<'stdout' | 'stderr', boolean | 'EPIPE' | 'room'>> & { shared?: boolean };
const stallOf = (fd: number) => (globalThis as { __sageConsoleStall?: Stall }).__sageConsoleStall?.[fd === 1 ? 'stdout' : 'stderr'];
/** What a console write to `fd` meets now: EAGAIN (stalled, or 'room': stalled for the queue), EPIPE (gone) or nothing. */
const stalled = (fd: number): 'EAGAIN' | 'EPIPE' | null => {
  const v = stallOf(fd);
  return v === 'EPIPE' ? 'EPIPE' : v ? 'EAGAIN' : null;
};
/** A one try (writeNow): refused by a stalled or gone stream, taken by one stalled with 'room' (a pipe that still takes a short line). */
const refusesOneTry = (fd: number): boolean => stallOf(fd) !== 'room' && stalled(fd) !== null;
/** The 'exit' listeners the console registered (a natural end's final word and restores): a test runs them with `atExit()`. */
export const exitListeners = (): Array<() => void> => ((globalThis as { __sageAtExit?: Array<() => void> }).__sageAtExit ??= []);

export function spied(real: ConsoleModule): ConsoleModule {
  const make = () => {
    const through: Array<{ fd: number; text: string }> = [];
    const c = Object.assign(new real.Console({
      write: (fd, buf, offset, length) => {
        // A test stalls a stream (a reader that does not read): globalThis.__sageConsoleStall = { stderr: true } (sageCliEnd.test.ts);
        // { stderr: 'EPIPE' }: its reader is gone.
        const code = stalled(fd);
        if (code) throw Object.assign(new Error(code), { code });
        const text = buf.subarray(offset, offset + length).toString('utf8');
        through.push({ fd, text });
        (fd === 1 ? process.stdout : process.stderr).write(text);
        return length;
      },
      now: () => Date.now(),
      later: (fn, ms) => { setTimeout(fn, ms); },
    }), { through });
    // vitest's own fd 1 / 2 say nothing about the CLI's: the streams count as two files, none blocking.
    // the spies stay on the streams; fd 1 / 2 are vitest's, so their flags are left alone; the exit is process.exit (which tests mock)
    return real.consoleApi(c, { sameFile: () => (globalThis as { __sageConsoleStall?: Stall }).__sageConsoleStall?.shared === true, blockingFds: () => [], capture: () => () => undefined, saveFlags: () => () => undefined,
      writeNow: (fd, text) => { if (refusesOneTry(fd)) return false; (fd === 1 ? process.stdout : process.stderr).write(text); return true; },
      exit: (code) => (code === undefined ? process.exit() : process.exit(code)), onExit: (fn) => { exitListeners().push(fn); } });
  };
  // vitest keeps a mocked module across vi.resetModules: each run (runCli calls prepareConsole first) gets a fresh console and exit state.
  let api = make();
  const mocked = { ...real } as Record<string, unknown>;
  for (const k of Object.keys(api) as Array<keyof typeof api>) {
    if (k === 'cliConsole') Object.defineProperty(mocked, k, { get: () => api.cliConsole, enumerable: true });
    else if (k === 'prepareConsole') mocked[k] = (...a: Parameters<typeof api.prepareConsole>) => { api = make(); exitListeners().length = 0; return api.prepareConsole(a[0]); };
    else mocked[k] = (...a: unknown[]) => (api[k] as (...x: unknown[]) => unknown)(...a);
  }
  return mocked as ConsoleModule;
}
