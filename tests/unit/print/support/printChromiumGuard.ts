/**
 * EVERY BROWSER A PRINT TEST LAUNCHES STATES HOW IT SETS GLYPHS, CHECKED AT RUN TIME (a `setupFiles` entry of
 * `vitest.print.config.ts`). The pack is printed in production by a Chromium that positions glyphs at fractional
 * advances; a test whose browser does not would measure another document (`printChromium.ts`). Whatever the spelling
 * (`chromium.launch`, an aliased import, `chromium['launch']`, a destructured `launch`, `launchServer`,
 * `launchPersistentContext`), the call reaches these methods, and each refuses a Chromium launched without a
 * `--font-render-hinting=` flag and any Firefox or WebKit. `connectOverCDP` (the parity tests' Gotenberg) is untouched.
 */
import { chromium, firefox, webkit, type BrowserType } from 'playwright';

const METHODS = ['launch', 'launchServer', 'launchPersistentContext'] as const;

function optionsOf(method: (typeof METHODS)[number], args: unknown[]): { args?: string[] } | undefined {
  return (method === 'launchPersistentContext' ? args[1] : args[0]) as { args?: string[] } | undefined;
}

function guard(type: BrowserType, isChromium: boolean): void {
  for (const method of METHODS) {
    const original = (type[method] as (...a: unknown[]) => Promise<unknown>).bind(type);
    (type as unknown as Record<string, unknown>)[method] = (...args: unknown[]): Promise<unknown> => {
      const flags = optionsOf(method, args)?.args ?? [];
      if (!isChromium) return Promise.reject(new Error(`a print test may launch only Chromium (${method})`));
      if (!flags.some((f) => f.startsWith('--font-render-hinting='))) {
        return Promise.reject(new Error(`a print test launched Chromium (${method}) without --font-render-hinting: use launchPrintChromium()`));
      }
      return original(...args);
    };
  }
}

guard(chromium, true);
guard(firefox, false);
guard(webkit, false);
