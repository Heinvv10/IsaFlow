/**
 * THE CHROMIUM EVERY PACK PRINT TEST LAYS TEXT OUT IN: Playwright's, launched as production's Gotenberg sets glyphs.
 *
 * Production prints packs through Gotenberg (`src/lib/pdf/selectTransport.ts`), whose Chromium positions glyphs at
 * FRACTIONAL advances. Playwright's Chromium, launched with no flags, rounds each advance to a whole pixel: the KPI
 * figure "(133 500 000)" is 187.00px in it and 191.94px in Gotenberg, and a fit model measured in it passes rows that
 * overflow in production. With `--font-render-hinting=none` it sets text exactly as Gotenberg does;
 * `tests/unit/printParity/packEngineParity.test.ts` holds the two to the same layout, pack by pack.
 */
import { chromium, type Browser } from 'playwright';

export const PRINT_CHROMIUM_ARGS: readonly string[] = ['--font-render-hinting=none'];

export function launchPrintChromium(): Promise<Browser> {
  return chromium.launch({ args: [...PRINT_CHROMIUM_ARGS] });
}
