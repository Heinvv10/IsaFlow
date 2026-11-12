// @vitest-environment happy-dom
// #1285 follow-up: the Bank Feeds page is gone (it 308s to Statement Imports), and pairing with it.
// The connector popup's empty state now links straight to Statement Imports, where paired browser
// extensions are listed and revoked, and no longer offers to pair one.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'chrome-extension/bank-connector/popup/popup.js'), 'utf8');

beforeEach(() => {
  document.body.innerHTML = '<div id="connections"></div><div id="status"></div>';
  vi.stubGlobal('chrome', {
    runtime: { lastError: undefined, sendMessage: vi.fn((_m: unknown, cb: (r: unknown) => void) => cb({ ok: true, value: [] })) },
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

it('with no connections, links to Statement Imports and does not offer pairing', async () => {
  // eslint-disable-next-line no-new-func
  new Function('self', SRC)(globalThis);
  await vi.waitFor(() => expect(document.querySelector('.empty')).not.toBeNull());
  const link = document.querySelector('.empty a') as HTMLAnchorElement;
  expect(link.getAttribute('href')).toBe('https://app.isaflow.co.za/accounting/bank/statements');
  expect(link.textContent).toBe('ISAFlow → Statement Imports');
  const text = document.querySelector('.empty')?.textContent ?? '';
  expect(text).not.toMatch(/bank-feeds|Bank Feeds|to pair/i);
});
