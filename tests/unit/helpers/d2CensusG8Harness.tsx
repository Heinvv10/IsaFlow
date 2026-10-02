/**
 * Group 8 of the D2 census: each case is one `apiFetch(...)` + `res.json()` site that now checks the response.
 * Per case: (1) a 400 with the real error envelope shows the server's message, (2) a 500 with an EMPTY body shows a
 * plain sentence and never the browser's JSON parse error, (3) a 200 envelope renders the data.
 * The real apiFetch helpers run (apiJsonOverMock); only `apiFetch` itself is scripted.
 */
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';

export const SAYS_NO = 'D2 server says no: ';
export const envelope = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refusal = (message: string) =>
  new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message } }), { status: 400 });

type Hit = (url: string, init?: RequestInit) => boolean;
export interface SiteCase {
  name: string;
  ui: () => ReactElement;
  hit: Hit;
  okData: unknown;
  /** `data` for every other request the page makes on mount (a valid empty success envelope by default). */
  other?: (url: string, init?: RequestInit) => unknown;
  /** User action that makes the site fire (the page's mount request needs none). */
  act?: () => Promise<unknown> | unknown;
  okCheck: () => Promise<unknown>;
  plain: RegExp;
  /** How the failure is surfaced when it is not plain text in the document (e.g. a toast spy). */
  see?: (text: RegExp) => Promise<unknown>;
}

function script(c: SiteCase, answer: () => Response) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) =>
    c.hit(String(url), init) ? answer() : envelope(c.other ? c.other(String(url), init) : {}));
}

export function runSiteCases(cases: SiteCase[]) {
  afterEach(() => { cleanup(); });
  describe.each(cases)('$name', (c) => {
    const see = c.see ?? ((t: RegExp) => screen.findByText(t));
    const drive = async () => { render(c.ui()); await c.act?.(); };

    it('a 400 with the real error envelope shows the server message', async () => {
      script(c, () => refusal(SAYS_NO + c.name));
      await drive();
      await see(new RegExp(SAYS_NO + c.name));
    });

    it('a 500 with an empty body shows a plain sentence, not the JSON parse error', async () => {
      script(c, () => new Response('', { status: 500 }));
      await drive();
      await see(c.plain);
      expect(document.body.textContent).not.toMatch(/JSON|Unexpected end/);
    });

    it('a 200 envelope renders the data', async () => {
      script(c, () => envelope(c.okData));
      await drive();
      await c.okCheck();
    });
  });
}
