/**
 * Every page must get the app's typeface, and a print render must NOT.
 *
 * The font used to be instantiated inside AppLayout, so a page rendering
 * without it — the OAuth consent screen, reset-password — never saw
 * `--font-dm-sans`. Tailwind's sans stack is `var(--font-dm-sans), ...`, and an
 * undefined var() invalidates the WHOLE declaration rather than falling through
 * to the entries after it, so those pages rendered in the browser's default
 * serif. The variable now goes on at the _app root.
 *
 * `font-sans` has to be on the same element as the variable: preflight declares
 * font-family on <html>, above this div, so defining the variable lower changes
 * nothing on its own. These assert the class list, which is what jsdom can see;
 * that the classes then RESOLVE to DM Sans is a CSS-cascade fact and is checked
 * in a browser, not here.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

async function renderApp(pathname: string, query: Record<string, string> = {}) {
  vi.resetModules();
  vi.doMock('next/router', () => ({
    useRouter: () => ({ pathname, query, isReady: true, events: { on: () => {}, off: () => {} } }),
  }));
  const { default: App } = await import('../../../pages/_app');
  return renderToStaticMarkup(
    React.createElement(App, {
      Component: () => React.createElement('main', null, 'page'),
      pageProps: {},
      router: {} as never,
    } as never),
  );
}

// The first import of pages/_app is slow under a loaded machine; the 5 s default failed pre-push gates. Timing only.
const LOAD_TIMEOUT = 60_000;

describe('pages/_app.tsx — the font wrapper', () => {
  it('puts the font variable AND font-sans on the same element for an ordinary page', async () => {
    const html = await renderApp('/oauth/authorize');
    expect(html).toContain('__variable_test');
    // same element, not merely both present somewhere in the tree
    expect(html).toMatch(/class="[^"]*__variable_test[^"]*font-sans[^"]*"/);
  }, LOAD_TIMEOUT);

  // packPrint.css pins the pack's own face on `html.print-mode body`, and this
  // div is a descendant of body. Declaring font-sans here would override it and
  // re-render every PDF in a different face, shifting text metrics on layouts
  // tuned to IBM Plex. Measured in a browser: a font-sans div inside such a
  // body wins over it.
  it('withholds font-sans from a print render so the pack keeps its own face', async () => {
    const html = await renderApp('/accounting/reports/report-packs', { print: '1' });
    expect(html).toContain('__variable_test');
    expect(html).not.toMatch(/class="[^"]*font-sans[^"]*"/);
  }, LOAD_TIMEOUT);
});
