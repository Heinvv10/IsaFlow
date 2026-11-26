/**
 * For the CLI tests that capture the console with spies on process.stdout.write / process.stderr.write: runConsole's one console, its
 * synchronous writes (fs.writeSync to fd 1 / 2, R27-2) sent to those methods instead, so the spies see every line. Used as
 * `vi.mock('../../../../scripts/sage-migration/runConsole', async (orig) => (await import('./sageCliConsoleSpy')).spied(await orig()))`.
 * The real writer is tested on its own (sageCliConsole.test.ts), through a real pipe. `cliConsole.through` lists what went through the
 * console (by fd), so a test can tell a line the console wrote from one written to the stream directly (R27-2: never).
 */
type ConsoleModule = typeof import('../../../../scripts/sage-migration/runConsole');

export function spied(real: ConsoleModule): ConsoleModule {
  const through: Array<{ fd: number; text: string }> = [];
  const cliConsole = Object.assign(new real.Console({
    write: (fd, buf, offset, length) => {
      const text = buf.subarray(offset, offset + length).toString('utf8');
      through.push({ fd, text });
      (fd === 1 ? process.stdout : process.stderr).write(text);
      return length;
    },
    pause: () => undefined,
  }), { through });
  return { ...real, cliConsole, say: (s: string) => { cliConsole.write('stderr', `${s}\n`); } };
}
