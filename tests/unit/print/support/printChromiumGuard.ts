/**
 * EVERY BROWSER A PRINT TEST LAUNCHES SETS GLYPHS AS PRODUCTION DOES, CHECKED AT RUN TIME (a `setupFiles` entry of
 * `vitest.print.config.ts`). The pack is printed in production by a Chromium that positions glyphs at fractional
 * advances; a test whose browser does not would measure another document (`printChromium.ts`).
 *
 * The check sits on Playwright's BrowserType PROTOTYPE, so every way to a launch passes it: `chromium.launch`, an
 * aliased import, `chromium['launch']`, a destructured `launch`, `Object.getPrototypeOf(chromium).launch`,
 * `launchServer`, `launchPersistentContext`. It refuses any Firefox or WebKit, and any Chromium whose LAST
 * `--font-render-hinting=` flag is not `=none` (so `[none, full]` is refused too). The one exception is the control
 * browser a test compares production's setting against, launched only through `launchUnhintedControlChromium`
 * (`withUnhintedControl`). `connectOverCDP` (the parity tests' Gotenberg) is not a launch.
 */
import { chromium, type BrowserType } from 'playwright';

const METHODS = ['launch', 'launchServer', 'launchPersistentContext'] as const;
const GUARDED = Symbol.for('isaflow.printChromiumGuard');

let controlDepth = 0;

/** Runs `launch` as the named control launch: the only way past the guard without `--font-render-hinting=none`. */
export function withUnhintedControl<T>(launch: () => T): T {
  controlDepth += 1;
  try {
    return launch();
  } finally {
    controlDepth -= 1;
  }
}

function optionsOf(method: (typeof METHODS)[number], args: unknown[]): { args?: unknown } | undefined {
  return (method === 'launchPersistentContext' ? args[1] : args[0]) as { args?: unknown } | undefined;
}

/** Why `this` launch is refused, or null. */
export function refusal(browserName: string, method: string, launchArgs: unknown): string | null {
  if (browserName !== 'chromium') return `a print test may launch only Chromium (${browserName}.${method})`;
  if (controlDepth > 0) return null;
  const flags = Array.isArray(launchArgs) ? launchArgs.filter((f): f is string => typeof f === 'string') : [];
  const hinting = flags.filter((f) => f.startsWith('--font-render-hinting'));
  if (hinting[hinting.length - 1] !== '--font-render-hinting=none') {
    return `a print test launched Chromium (${method}) without --font-render-hinting=none as its last hinting flag: use launchPrintChromium()`;
  }
  // Any other flag about fonts (--disable-font-subpixel-positioning, ...) is a text layout production does not have.
  const other = flags.filter((f) => /font/i.test(f) && !f.startsWith('--font-render-hinting'));
  if (other.length > 0) return `a print test launched Chromium (${method}) with ${other.join(' ')}: production passes no font flag but --font-render-hinting=none`;
  return null;
}

const proto = Object.getPrototypeOf(chromium) as BrowserType & Record<symbol, boolean>;
if (proto[GUARDED] !== true) {
  for (const method of METHODS) {
    const original = proto[method] as (this: BrowserType, ...a: unknown[]) => Promise<unknown>;
    (proto as unknown as Record<string, unknown>)[method] = function guarded(this: BrowserType, ...args: unknown[]): Promise<unknown> {
      const why = refusal(this.name(), method, optionsOf(method, args)?.args);
      return why === null ? original.apply(this, args) : Promise.reject(new Error(why));
    };
  }
  proto[GUARDED] = true;
}
