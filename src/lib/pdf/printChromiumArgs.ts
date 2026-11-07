/**
 * How a Chromium that prints a pack must set glyphs: at fractional advances, as production's Gotenberg does. Launched
 * without this flag, Playwright's Chromium rounds every glyph advance to a whole pixel and lays a pack out narrower or
 * wider than production prints it (the KPI figure "(133 500 000)" is 187.00px against Gotenberg's 191.94). The
 * Playwright transport (the PDF_TRANSPORT=playwright fallback) and every pack print test launch with it;
 * `tests/unit/printParity/packEngineParity.test.ts` holds the result to the production image, on velo.
 */
export const PRINT_CHROMIUM_ARGS: readonly string[] = ['--font-render-hinting=none'];
