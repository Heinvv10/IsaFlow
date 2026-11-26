/**
 * For the CLI tests that capture the console with spies on process.stdout.write / process.stderr.write: runConsole's one console, its
 * writes (fs.writeSync to fd 1 / 2, R27-2, R28-1) sent to those methods instead, so the spies see every line. Used as
 * `vi.mock('../../../../scripts/sage-migration/runConsole', async (orig) => (await import('./sageCliConsoleSpy')).spied(await orig()))`.
 * The real writer is tested on its own (sageCliConsole.test.ts), through a real pipe. `cliConsole.through` lists what went through the
 * console (by fd), so a test can tell a line the console wrote from one written to the stream directly (R27-2: never).
 */
type ConsoleModule = typeof import('../../../../scripts/sage-migration/runConsole');

export function spied(real: ConsoleModule): ConsoleModule {
  const make = () => {
    const through: Array<{ fd: number; text: string }> = [];
    const c = Object.assign(new real.Console({
      write: (fd, buf, offset, length) => {
        const text = buf.subarray(offset, offset + length).toString('utf8');
        through.push({ fd, text });
        (fd === 1 ? process.stdout : process.stderr).write(text);
        return length;
      },
      now: () => Date.now(),
      later: (fn, ms) => { setTimeout(fn, ms); },
    }), { through });
    // vitest's own fd 1 / 2 say nothing about the CLI's: the streams count as two files, none blocking.
    return real.consoleApi(c, { sameFile: () => false, blockingFds: () => [] });
  };
  // vitest keeps a mocked module across vi.resetModules: each run (runCli calls prepareConsole first) gets a fresh console and exit state.
  let api = make();
  const mocked = { ...real } as Record<string, unknown>;
  for (const k of Object.keys(api) as Array<keyof typeof api>) {
    if (k === 'cliConsole') Object.defineProperty(mocked, k, { get: () => api.cliConsole, enumerable: true });
    else if (k === 'prepareConsole') mocked[k] = (report: () => string | null) => { api = make(); return api.prepareConsole(report); };
    else mocked[k] = (...a: unknown[]) => (api[k] as (...x: unknown[]) => unknown)(...a);
  }
  return mocked as ConsoleModule;
}
