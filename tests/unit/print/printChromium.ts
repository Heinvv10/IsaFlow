/**
 * THE CHROMIUM EVERY PACK PRINT TEST LAYS TEXT OUT IN: Playwright's, launched as production's Gotenberg sets glyphs.
 *
 * Production prints packs through Gotenberg (`src/lib/pdf/selectTransport.ts`), whose Chromium positions glyphs at
 * FRACTIONAL advances. Playwright's Chromium, launched with no flags, rounds each advance to a whole pixel: the KPI
 * figure "(133 500 000)" is 187.00px in it and 191.94px in Gotenberg, and a fit model measured in it passes rows that
 * overflow in production. With `--font-render-hinting=none` it sets glyphs at Gotenberg's advances;
 * `tests/unit/printParity/packEngineParity.test.ts` holds the two to the same layout, pack by pack.
 *
 * NOT ITS LINE BREAKING. This is Playwright's Chromium 145; production's is 151 (Gotenberg 8), and the two break text
 * differently: after a word-opening hyphen (print breaks, production holds), beside U+2800, and before more (#1235's
 * fourth-round adversary found 1,088 of 19,188 hyphen strings apart). Where line breaking is concerned the print tests
 * are a fast first check; the parity of line breaks with production rests on the velo-only image tests
 * (`printParity/packBreakPairsImage.test.ts`, `printParity/packNumericHoldImage.test.ts`), which ask production's own.
 */
import { chromium, type Browser } from 'playwright';
import { PRINT_CHROMIUM_ARGS } from '@/lib/pdf/printChromiumArgs';
import { withUnhintedControl } from './support/printChromiumGuard';

export { PRINT_CHROMIUM_ARGS };

export function launchPrintChromium(): Promise<Browser> {
  return chromium.launch({ args: [...PRINT_CHROMIUM_ARGS] });
}

/**
 * The CONTROL browser: Chromium with full hinting, every glyph advance rounded to a whole pixel, the setting production
 * does not use. Only a test that proves the difference launches it, and only through here (the run-time guard knows
 * this name and no other way past it).
 */
export function launchUnhintedControlChromium(): Promise<Browser> {
  return withUnhintedControl(() => chromium.launch({ args: ['--font-render-hinting=full'] }));
}
