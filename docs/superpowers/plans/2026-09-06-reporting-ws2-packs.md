# Reporting WS2: Packs and Exports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The board / management / monthly pack becomes the React page the user saw — rendered to PDF through a swappable headless-Chromium transport (Playwright locally, Gotenberg in Docker in production) and to PowerPoint with native editable charts — with every figure copied from a service, never recomputed.

**Architecture:** One pack model (`PackDocument`) is built from `ReportPack` by pure mappers and is the single source for three surfaces: the on-screen page, the print page the PDF renderer photographs, and the PPTX deck. `renderPagePdf` grows a transport seam (`PdfTransport`) so the same print-token URL is rendered either by a local Playwright Chromium or by a Gotenberg container; the print token grows from one authorised API path to a set, because the pack page fetches two. AFS keeps WeasyPrint and gains a server-side ECharts SVG seam so a statement page can carry a chart.

**Tech Stack:** Next.js 14 Pages Router · React 18 · TypeScript strict · Vitest (node + happy-dom via `vitest.components.config.ts`) · Playwright 1.58.2 (already a dependency) · Gotenberg 8 (Docker sidecar, no npm dependency) · ECharts 6 (already a dependency, SSR mode for AFS) · `pptxgenjs` (THE ONE new dependency).

**Spec:** `docs/superpowers/plans/2026-09-05-reporting-programme.md`. Its Global Constraints bind every task here. Read `docs/superpowers/plans/2026-09-05-reporting-phase1-foundation.md` for the `StatementRow` / `StatementGrid` / `formatMoney` contracts this plan consumes.

## Global Constraints

- **No new dependency except `pptxgenjs`,** pinned to an exact version (no `^`). Gotenberg is a container, not a package. ECharts, exceljs, playwright and jspdf are already installed.
- **Every figure in the PDF and the PPTX is a service figure.** `buildPackDocument` and `buildPackDeck` copy from `ReportPack.sections[].data`; neither adds, subtracts or derives. Task 6 enforces this with a "no new numbers" test.
- **Statement names follow IFRS for SMEs in the pack**: Statement of Financial Position, Statement of Comprehensive Income, Statement of Cash Flows. The on-screen page keeps its plain-English labels.
- **IBCS notation** in pack charts: actual solid ink, prior period light grey, favourable/unfavourable green/red only.
- **`withAuth.ts` may be touched only for the multi-path print token** (Task 1). That task's diff is exactly the four lines shown and is marked for an adversarial security review before merge.
- **Repo rules**: `company_id` on every query · `withAuth(withErrorHandler(...))` on every route · `apiResponse` helpers · `log` from `@/lib/logger`, never `console` · no empty catch · no `any` outside the Next.js `handler as any` pattern · max 300 lines per file · migrations not required by this workstream.
- **Branch**: `feat/reporting-ws2-packs`, its own worktree. Stage by explicit path. No `git stash`. Commit after every task. `bun run type-check` before each commit; `bun run ci` before the PR.
- **File ownership**: `src/modules/accounting/services/packs/**`, `src/components/accounting/packs/**`, `src/lib/pdf/**`, `pages/api/accounting/packs/**`, `pages/accounting/reports/report-packs.tsx`, `styles/print.css`, `scripts/pdf/**`, `src/modules/accounting/services/afs/pdfExportService.ts` (additive seam only), and this workstream's tests. Anything else is a request to its owner — see "Requests to other owners" at the end.

---

## File Structure

```
src/lib/pdf/
  printAuth.ts                      MODIFY  token binds paths: string[] (was path: string)
  renderPagePdf.ts                  MODIFY  query support, apiPaths, delegates to a transport
  pdfTransport.ts                   CREATE  PdfTransport interface + shared PDF options
  transports/playwrightTransport.ts CREATE  local Chromium, stubs every non-authorised /api/*
  transports/gotenbergTransport.ts  CREATE  posts the URL to a Gotenberg container
  transports/gotenbergForm.ts       CREATE  pure field builder (testable without a container)
  selectTransport.ts                CREATE  chooseTransport(env) → 'gotenberg' | 'playwright'

src/modules/accounting/services/packs/
  packSections.ts                   CREATE  IFRS titles, section order, landscape flags, API paths
  packChartOptions.ts               CREATE  pure ECharts options: waterfall, 12-month trend
  packTrendService.ts               CREATE  12-month revenue/expense/profit series (company-scoped)
  packDocument.ts                   CREATE  ReportPack + trend → PackDocument (the one model)
  packDeckModel.ts                  CREATE  PackDocument → DeckSlide[] (pure)
  pptxExportService.ts              CREATE  DeckSlide[] → .pptx Buffer via pptxgenjs
  serverChartSvg.ts                 CREATE  ECharts SSR → SVG string; AFS chart builders

src/components/accounting/packs/
  PackPrintView.tsx                 CREATE  the printed pack: cover, TOC, sections
  PackSectionView.tsx               CREATE  one section's blocks → grid / KV / chart
  PackCover.tsx                     CREATE  cover page
  PackToc.tsx                       CREATE  table of contents
  PackChart.tsx                     CREATE  EChartClient wrapper, svg renderer, data-pack-chart
  usePrintReady.ts                  CREATE  sets data-print-ready when data + charts are up

pages/accounting/reports/report-packs.tsx   MODIFY  ?print=1&pack=&from=&to= branch
pages/api/accounting/packs/[id]/trend.ts    CREATE  12-month series for the print page
pages/api/accounting/packs/[id]/pdf.ts      CREATE  streams the rendered PDF
pages/api/accounting/packs/[id]/pptx.ts     CREATE  streams the rendered PPTX
styles/print.css                            MODIFY  landscape pages, cover/TOC breaks
scripts/pdf/render-pack.ts                  CREATE  proof script, both transports
src/modules/accounting/services/afs/pdfExportService.ts  MODIFY  charts passed to the renderer

tests/unit/lib/pdf/printAuth.test.ts              MODIFY  multi-path cases
tests/unit/lib/pdf/selectTransport.test.ts        CREATE
tests/unit/lib/pdf/gotenbergForm.test.ts          CREATE
tests/unit/services/packs/packSections.test.ts    CREATE
tests/unit/services/packs/packChartOptions.test.ts CREATE
tests/unit/services/packs/packTrendService.test.ts CREATE
tests/unit/services/packs/packDocument.test.ts    CREATE
tests/unit/services/packs/packDeckModel.test.ts   CREATE
tests/unit/services/packs/pptxExportService.test.ts CREATE
tests/unit/services/packs/serverChartSvg.test.ts  CREATE
tests/unit/api/packsDownloadRoutes.test.ts        CREATE
tests/unit/components/packs/PackPrintView.dom.test.tsx CREATE  (bun run test:components)
```

**Why `serverChartSvg.ts` lives under `services/packs/` rather than under `services/afs/` or `src/lib/charts/`:** those two directories belong to other owners (the AFS module and WS-E). The file is generic — it turns any ECharts option into an SVG string — and the AFS-specific option builder sits beside it so this workstream owns both halves. Move it when the AFS module wants it.

---

### Task 1: The print token authorises a SET of API paths

The pack print page fetches two API paths (`reports-pack` and the pack trend route). Today a print token binds exactly one, so the second call 401s and the chart renders empty. Widen the payload to `paths: string[]`, keeping exact-match semantics per path — a prefix or a wildcard would turn a 2-minute report token into a general API key.

**Files:**
- Modify: `src/lib/pdf/printAuth.ts`
- Modify: `src/lib/auth/withAuth.ts:125-140` (four lines — the exact diff is in Step 5)
- Test: `tests/unit/lib/pdf/printAuth.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PrintTokenPayload { companyId: string; userId: string; paths: string[]; exp: number }`, `mintPrintToken(companyId: string, userId: string, paths: string[], ttlSeconds?: number): string`, `verifyPrintTokenSignature(token: string): PrintTokenPayload | null`, `verifyPrintToken(token: string, requestPath: string): PrintTokenPayload | null`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/lib/pdf/printAuth.test.ts` (and change the existing cases' `mintPrintToken(company, user, path)` calls to pass `[path]`):

```ts
describe('multi-path print tokens', () => {
  const PACK = '/api/accounting/reports-pack';
  const TREND = '/api/accounting/packs/management/trend';

  it('authorises every path in the set', () => {
    const token = mintPrintToken(COMPANY, USER, [PACK, TREND]);
    expect(verifyPrintToken(token, PACK)?.companyId).toBe(COMPANY);
    expect(verifyPrintToken(token, TREND)?.companyId).toBe(COMPANY);
  });

  it('rejects a path that is not in the set', () => {
    const token = mintPrintToken(COMPANY, USER, [PACK, TREND]);
    expect(verifyPrintToken(token, '/api/accounting/reports-balance-sheet')).toBeNull();
  });

  it('matches exactly, never by prefix', () => {
    const token = mintPrintToken(COMPANY, USER, [PACK]);
    // A prefix match here would authorise every route that merely starts with
    // the bound path — a 2-minute report token becoming a general API key.
    expect(verifyPrintToken(token, `${PACK}-secret`)).toBeNull();
    expect(verifyPrintToken(token, '/api/accounting/reports')).toBeNull();
    expect(verifyPrintToken(token, `${PACK}/sub`)).toBeNull();
  });

  it('signs the whole set, so a path cannot be appended to a minted token', () => {
    const token = mintPrintToken(COMPANY, USER, [PACK]);
    const [payloadB64, sig] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8'));
    payload.paths.push('/api/accounting/customers');
    const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
    expect(verifyPrintToken(forged, '/api/accounting/customers')).toBeNull();
    expect(verifyPrintTokenSignature(forged)).toBeNull();
  });

  it('refuses to mint a token with no paths, a wildcard, or a query string', () => {
    expect(() => mintPrintToken(COMPANY, USER, [])).toThrow(/at least one path/);
    expect(() => mintPrintToken(COMPANY, USER, ['*'])).toThrow(/absolute API path/);
    expect(() => mintPrintToken(COMPANY, USER, ['/api/x?y=1'])).toThrow(/absolute API path/);
    expect(() => mintPrintToken(COMPANY, USER, ['/api/a\n/api/b'])).toThrow(/absolute API path/);
  });

  it('rejects a payload whose paths field is not an array of strings', () => {
    const token = mintPrintToken(COMPANY, USER, [PACK]);
    const [, sig] = token.split('.');
    const bad = Buffer.from(JSON.stringify({ companyId: COMPANY, userId: USER, paths: PACK, exp: 9e9 })).toString('base64url');
    expect(verifyPrintTokenSignature(`${bad}.${sig}`)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd <worktree> && bun run test:unit tests/unit/lib/pdf/printAuth.test.ts`
Expected: FAIL — `mintPrintToken` rejects an array argument / `paths` is undefined.

- [ ] **Step 3: Implement the payload change in `printAuth.ts`**

Replace the payload interface, the signer, the minter and the two verifiers:

```ts
export interface PrintTokenPayload {
  companyId: string;
  userId: string;
  /** Exact API pathnames this token authorises. Matched with ===, never by prefix. */
  paths: string[];
  exp: number; // unix seconds
}

// A newline cannot appear in a URL pathname, so joining on it makes the
// signature unambiguous: ['/a', '/b'] and ['/a,/b'] hash differently. A comma
// would not — a comma is legal in a pathname, and two different sets sharing a
// signature is a forged token.
const PATH_SEP = '\n';

function sign(companyId: string, userId: string, paths: string[], exp: number, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${companyId}|${userId}|${paths.join(PATH_SEP)}|${exp}`)
    .digest('hex');
}

function assertPaths(paths: string[]): void {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('mintPrintToken: at least one path is required');
  }
  for (const p of paths) {
    if (typeof p !== 'string' || !p.startsWith('/') || /[?#*\s]/.test(p)) {
      throw new Error(`mintPrintToken: ${String(p)} is not an absolute API path without a query string`);
    }
  }
}

/** Mint a print token bound to an exact set of API paths, expiring in `ttlSeconds`. */
export function mintPrintToken(companyId: string, userId: string, paths: string[], ttlSeconds = 120): string {
  assertPaths(paths);
  const raw = process.env.PRINT_TOKEN_SECRET;
  if (!raw) throw new Error('PRINT_TOKEN_SECRET is not set');
  const secret = getSecret();
  if (!secret) throw new Error(`PRINT_TOKEN_SECRET must be at least ${MIN_SECRET_LEN} characters`);

  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = sign(companyId, userId, paths, exp, secret);
  const payload = Buffer.from(JSON.stringify({ companyId, userId, paths, exp })).toString('base64url');
  return `${payload}.${signature}`;
}
```

In `parsePayload`, replace the `path` check with an array check:

```ts
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.companyId !== 'string' ||
    typeof candidate.userId !== 'string' ||
    !Array.isArray(candidate.paths) ||
    candidate.paths.length === 0 ||
    !candidate.paths.every((p) => typeof p === 'string') ||
    typeof candidate.exp !== 'number'
  ) {
    return null;
  }
  return candidate as unknown as PrintTokenPayload;
```

In `verifyPrintTokenSignature`, the expected signature now reads `sign(payload.companyId, payload.userId, payload.paths, payload.exp, secret)` and the two `log.warn` calls carry `{ paths: payload.paths }`. In `verifyPrintToken`:

```ts
export function verifyPrintToken(token: string, requestPath: string): PrintTokenPayload | null {
  const payload = verifyPrintTokenSignature(token);
  if (!payload) return null;

  // Exact match per path. `startsWith` here would authorise every route under
  // the bound prefix; see the prefix test in printAuth.test.ts.
  if (!payload.paths.includes(requestPath)) {
    log.warn('printAuth: path not authorised', { tokenPaths: payload.paths, requestPath }, 'printAuth');
    return null;
  }
  return payload;
}
```

Update the file header comment: the token binds "a specific, already-known SET of API paths".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd <worktree> && bun run test:unit tests/unit/lib/pdf/printAuth.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Apply the `withAuth.ts` diff — the ONLY change this workstream makes to that file**

In `src/lib/auth/withAuth.ts`, inside the print-token fallback (currently lines 125-140), change exactly this:

```diff
       const requestPath = req.url?.split('?')[0] ?? '';
-      if (candidate.path !== requestPath || candidate.companyId !== activeCompanyId) {
+      if (!candidate.paths.includes(requestPath) || candidate.companyId !== activeCompanyId) {
         log.warn('withAuth: print token not valid for this request', {
-          tokenPath: candidate.path,
+          tokenPaths: candidate.paths,
           requestPath,
           tokenCompanyId: candidate.companyId,
           activeCompanyId,
         }, 'Auth');
         return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' } });
       }
       log.info('withAuth: print token accepted', {
         companyId: candidate.companyId,
         userId: candidate.userId,
-        path: candidate.path,
+        paths: candidate.paths,
       }, 'Auth');
```

Nothing else in `withAuth.ts` changes. The company check, the two-step signature-then-path split, and the "do not clear cookies for a genuine token bound elsewhere" behaviour all stay exactly as they are.

- [ ] **Step 6: Prove the exact-match rule with a mutation**

Temporarily change `payload.paths.includes(requestPath)` to `payload.paths.some(p => requestPath.startsWith(p))` in `printAuth.ts`, run the suite, and confirm "matches exactly, never by prefix" goes RED. Revert the mutation.

Run: `cd <worktree> && bun run test:unit tests/unit/lib/pdf/printAuth.test.ts`
Expected: RED with the mutation, PASS after reverting. Paste both outputs into the PR.

- [ ] **Step 7: Type-check and commit**

```bash
cd <worktree>
bun run type-check
git add src/lib/pdf/printAuth.ts src/lib/auth/withAuth.ts tests/unit/lib/pdf/printAuth.test.ts
git commit -m "feat(pdf): print token authorises a set of API paths, exact-match per path"
```

> **Review gate:** this task is the one that touches auth. It gets an adversarial security review (a fresh agent, no session context) before the PR merges, with the brief: "can this token be widened, replayed, or made to authorise a path it was not minted for?"

---

### Task 2: `renderPagePdf` gains a query string, a path set, and a transport seam

`renderPagePdf` hard-codes `?print=1` onto the path and launches Playwright inline. The pack page needs `?print=1&pack=management&from=…&to=…`, and production needs Gotenberg. Split the browser work behind a `PdfTransport` and keep the caller-facing function identical in shape.

**Files:**
- Create: `src/lib/pdf/pdfTransport.ts`
- Create: `src/lib/pdf/selectTransport.ts`
- Create: `src/lib/pdf/transports/playwrightTransport.ts`
- Modify: `src/lib/pdf/renderPagePdf.ts`
- Modify: `scripts/pdf/try-render.ts` (its `apiPath` argument becomes `apiPaths`)
- Test: `tests/unit/lib/pdf/selectTransport.test.ts`

**Interfaces:**
- Consumes: `mintPrintToken(companyId, userId, paths, ttl?)` from Task 1.
- Produces:
  - `interface PrintCookie { name: string; value: string; httpOnly: boolean }`
  - `interface PdfRenderRequest { url: string; landscape: boolean; cookies: PrintCookie[]; allowedApiPaths: string[] }`
  - `interface PdfTransport { name: 'playwright' | 'gotenberg'; render(req: PdfRenderRequest): Promise<Buffer> }`
  - `PDF_MARGIN_MM`, `PAPER_A4_IN`, `PRINT_READY_SELECTOR`, `PRINT_READY_TIMEOUT_MS`, `FOOTER_HTML` from `pdfTransport.ts`
  - `chooseTransportName(env: NodeJS.ProcessEnv): 'gotenberg' | 'playwright'` from `selectTransport.ts`
  - `renderPagePdf(options: RenderPagePdfOptions): Promise<Buffer>` where `RenderPagePdfOptions = { companyId: string; userId: string; path: string; query?: Record<string, string>; apiPaths?: string[]; landscape?: boolean }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lib/pdf/selectTransport.test.ts
import { describe, it, expect } from 'vitest';
import { chooseTransportName } from '@/lib/pdf/selectTransport';

describe('chooseTransportName', () => {
  it('uses Gotenberg when GOTENBERG_URL is set', () => {
    expect(chooseTransportName({ GOTENBERG_URL: 'http://localhost:5002' })).toBe('gotenberg');
  });
  it('falls back to Playwright when it is not', () => {
    expect(chooseTransportName({})).toBe('playwright');
  });
  it('treats an empty or whitespace GOTENBERG_URL as unset', () => {
    expect(chooseTransportName({ GOTENBERG_URL: '' })).toBe('playwright');
    expect(chooseTransportName({ GOTENBERG_URL: '   ' })).toBe('playwright');
  });
  it('lets PDF_TRANSPORT force Playwright even when a container is configured', () => {
    expect(chooseTransportName({ GOTENBERG_URL: 'http://x', PDF_TRANSPORT: 'playwright' })).toBe('playwright');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd <worktree> && bun run test:unit tests/unit/lib/pdf/selectTransport.test.ts`
Expected: FAIL, cannot find module `@/lib/pdf/selectTransport`.

- [ ] **Step 3: Write the transport contract**

```ts
// src/lib/pdf/pdfTransport.ts
//
// The contract every PDF transport implements. A transport receives a fully
// built URL and the cookies that authenticate it, and returns PDF bytes. It
// knows nothing about print tokens, companies or report pages — that is
// renderPagePdf's job — so a new transport is one file and a switch entry.

export interface PrintCookie {
  name: string;
  value: string;
  httpOnly: boolean;
}

export interface PdfRenderRequest {
  /** Absolute URL including the ?print=1 query. */
  url: string;
  landscape: boolean;
  cookies: PrintCookie[];
  /**
   * The API pathnames the page is allowed to call. The Playwright transport
   * stubs everything else so a background call cannot race the report fetch;
   * Gotenberg cannot intercept, so there the print token is the only gate
   * (an unauthorised call 401s and withAuth leaves the cookies alone).
   */
  allowedApiPaths: string[];
}

export interface PdfTransport {
  name: 'playwright' | 'gotenberg';
  render(request: PdfRenderRequest): Promise<Buffer>;
}

/** A4 with the margins the reporting brief specifies, in both units the two
 *  transports want: Playwright takes CSS units, Gotenberg takes inches. */
export const PDF_MARGIN_MM = { top: 18, bottom: 18, left: 14, right: 14 } as const;
export const MM_PER_INCH = 25.4;
export const PAPER_A4_IN = { width: 8.27, height: 11.69 } as const;

export const PRINT_READY_SELECTOR = '[data-print-ready="true"]';
export const PRINT_READY_TIMEOUT_MS = 30_000;

/** Chromium's page-number footer. Both transports render the same markup. */
export const FOOTER_HTML =
  '<div style="font-size:9px;width:100%;text-align:center;color:#555">' +
  '<span class="pageNumber"></span> / <span class="totalPages"></span></div>';

/** Chromium prints its own title/date header unless it is given an empty one. */
export const HEADER_HTML = '<span></span>';

export const mm = (v: number): string => `${v}mm`;
export const mmToIn = (v: number): string => (v / MM_PER_INCH).toFixed(2);
```

- [ ] **Step 4: Write the transport selector**

```ts
// src/lib/pdf/selectTransport.ts
//
// Which browser renders the page. Gotenberg (a container next to the
// WeasyPrint sidecar) in production, Playwright's bundled Chromium in dev and
// in tests. PDF_TRANSPORT=playwright forces the local one on a host that also
// has a container configured, which is how a production incident gets a
// same-shape fallback without an env teardown.

export type TransportName = 'playwright' | 'gotenberg';

export function chooseTransportName(env: NodeJS.ProcessEnv | Record<string, string | undefined>): TransportName {
  if (env.PDF_TRANSPORT === 'playwright') return 'playwright';
  if (env.PDF_TRANSPORT === 'gotenberg') return 'gotenberg';
  const url = (env.GOTENBERG_URL ?? '').trim();
  return url.length > 0 ? 'gotenberg' : 'playwright';
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd <worktree> && bun run test:unit tests/unit/lib/pdf/selectTransport.test.ts`
Expected: PASS.

- [ ] **Step 6: Move the Playwright logic into its own transport**

```ts
// src/lib/pdf/transports/playwrightTransport.ts
//
// The dev/local transport: Playwright's bundled Chromium, in-process. It is
// the only transport that can intercept the page's network, so it stubs every
// /api/* call the print token does not authorise — the page's own "no data
// yet" handling takes over and nothing races the report fetch.

import { chromium, type Browser } from 'playwright';
import {
  FOOTER_HTML, HEADER_HTML, PDF_MARGIN_MM, PRINT_READY_SELECTOR, PRINT_READY_TIMEOUT_MS,
  mm, type PdfRenderRequest, type PdfTransport,
} from '../pdfTransport';
import { log } from '@/lib/logger';

async function launchChromium(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

export const playwrightTransport: PdfTransport = {
  name: 'playwright',
  async render(request: PdfRenderRequest): Promise<Buffer> {
    const { hostname } = new URL(request.url);
    const browser = await launchChromium();
    try {
      const context = await browser.newContext();
      await context.addCookies(
        request.cookies.map((c) => ({
          name: c.name, value: c.value, domain: hostname, path: '/',
          httpOnly: c.httpOnly, sameSite: 'Lax' as const,
        })),
      );

      const allowed = new Set(request.allowedApiPaths);
      await context.route('**/api/**', async (route) => {
        const requestPath = new URL(route.request().url()).pathname;
        if (allowed.has(requestPath)) {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: null }),
        });
      });

      const page = await context.newPage();
      // 'load', not 'networkidle': the app keeps background connections open
      // that never go quiet. waitForSelector is the real readiness gate.
      await page.goto(request.url, { waitUntil: 'load' });
      await page.waitForSelector(PRINT_READY_SELECTOR, { timeout: PRINT_READY_TIMEOUT_MS });
      await page.emulateMedia({ media: 'print' });

      const pdf = await page.pdf({
        format: 'A4',
        landscape: request.landscape,
        printBackground: true,
        margin: {
          top: mm(PDF_MARGIN_MM.top), bottom: mm(PDF_MARGIN_MM.bottom),
          left: mm(PDF_MARGIN_MM.left), right: mm(PDF_MARGIN_MM.right),
        },
        displayHeaderFooter: true,
        headerTemplate: HEADER_HTML,
        footerTemplate: FOOTER_HTML,
      });
      log.info('playwrightTransport: rendered', { url: request.url, bytes: pdf.length }, 'pdf');
      return pdf;
    } finally {
      await browser.close();
    }
  },
};
```

Note what moved OUT: the `page.evaluate` that added `print-mode` and removed `.dark`. Gotenberg cannot run that, so the printed page sets both itself (Task 7) and the two transports stay identical. Any other page later added to this pipeline must do the same.

- [ ] **Step 7: Rewrite `renderPagePdf` around the seam**

```ts
// src/lib/pdf/renderPagePdf.ts
//
// Renders one authenticated app page to a PDF buffer. The browser lives
// behind PdfTransport (src/lib/pdf/pdfTransport.ts): Gotenberg in Docker when
// GOTENBERG_URL is set, Playwright's bundled Chromium otherwise.
//
// Auth: mints a print token (printAuth.ts) bound to the exact SET of API
// paths the target page fetches, and hands it to the browser in the SAME
// cookie GoTrue uses (ACCESS_COOKIE). Edge middleware only checks the cookie
// is present; withAuth is what verifies it.
//
// The page is responsible for adding `print-mode` to <html> and dropping
// `.dark` when it sees ?print=1 — Gotenberg cannot execute a script on our
// behalf, so the page, not the renderer, owns that.

import { mintPrintToken } from './printAuth';
import { ACCESS_COOKIE, ACTIVE_COMPANY_COOKIE, ONBOARDING_DONE_COOKIE } from '@/lib/auth/cookies';
import { chooseTransportName } from './selectTransport';
import { playwrightTransport } from './transports/playwrightTransport';
import { gotenbergTransport } from './transports/gotenbergTransport';
import type { PdfTransport } from './pdfTransport';
import { log } from '@/lib/logger';

export interface RenderPagePdfOptions {
  companyId: string;
  userId: string;
  /** Page path, e.g. /accounting/reports/report-packs */
  path: string;
  /** Extra query parameters. `print=1` is always added. */
  query?: Record<string, string>;
  /**
   * Exact API pathnames (no query strings) the print token authorises.
   * Defaults to `[path]` for a page whose data route matches its own path.
   */
  apiPaths?: string[];
  landscape?: boolean;
}

function transportFor(name: ReturnType<typeof chooseTransportName>): PdfTransport {
  return name === 'gotenberg' ? gotenbergTransport : playwrightTransport;
}

export async function renderPagePdf(options: RenderPagePdfOptions): Promise<Buffer> {
  const appUrl = process.env.APP_URL;
  if (!appUrl) throw new Error('APP_URL is not set');

  const { companyId, userId, path, landscape = false } = options;
  const apiPaths = options.apiPaths ?? [path];
  const token = mintPrintToken(companyId, userId, apiPaths);

  const params = new URLSearchParams({ ...(options.query ?? {}), print: '1' });
  const url = `${appUrl}${path}?${params.toString()}`;

  const transport = transportFor(chooseTransportName(process.env));
  const pdf = await transport.render({
    url,
    landscape,
    allowedApiPaths: apiPaths,
    cookies: [
      { name: ACCESS_COOKIE, value: token, httpOnly: true },
      { name: ACTIVE_COMPANY_COOKIE, value: companyId, httpOnly: false },
      // Middleware redirects an authed request without this cookie to
      // /onboarding, which navigates away from the report entirely.
      { name: ONBOARDING_DONE_COOKIE, value: '1', httpOnly: false },
    ],
  });

  log.info('renderPagePdf: rendered', { companyId, userId, path, transport: transport.name, bytes: pdf.length }, 'pdf');
  return pdf;
}
```

- [ ] **Step 8: Update the existing proof script**

In `scripts/pdf/try-render.ts`, change `apiPath: '/api/accounting/reports-management-accounts'` to `apiPaths: ['/api/accounting/reports-management-accounts']`.

- [ ] **Step 9: Type-check and commit**

```bash
cd <worktree>
bun run type-check
git add src/lib/pdf/pdfTransport.ts src/lib/pdf/selectTransport.ts src/lib/pdf/transports/playwrightTransport.ts src/lib/pdf/renderPagePdf.ts scripts/pdf/try-render.ts tests/unit/lib/pdf/selectTransport.test.ts
git commit -m "refactor(pdf): transport seam, query support and multi-path tokens in renderPagePdf"
```

Step 7 imports `gotenbergTransport`, which Task 3 creates — implement Task 3 in the same session before running `bun run type-check`, or stub nothing and simply do Task 3 first. Do not commit a broken import.

---

### Task 3: The Gotenberg transport

Production renders through a Gotenberg container next to the WeasyPrint sidecar: same operational shape, no Chromium on the host. Gotenberg fetches the URL itself, so authentication travels as an `extraHttpHeaders` cookie and readiness as a `waitForExpression`.

**Files:**
- Create: `src/lib/pdf/transports/gotenbergForm.ts`
- Create: `src/lib/pdf/transports/gotenbergTransport.ts`
- Test: `tests/unit/lib/pdf/gotenbergForm.test.ts`

**Interfaces:**
- Consumes: `PdfRenderRequest`, `PdfTransport`, `PDF_MARGIN_MM`, `PAPER_A4_IN`, `PRINT_READY_SELECTOR`, `PRINT_READY_TIMEOUT_MS`, `FOOTER_HTML`, `HEADER_HTML`, `mmToIn` from `pdfTransport.ts`.
- Produces: `buildGotenbergFields(request: PdfRenderRequest): Record<string, string>` and `gotenbergTransport: PdfTransport`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lib/pdf/gotenbergForm.test.ts
import { describe, it, expect } from 'vitest';
import { buildGotenbergFields } from '@/lib/pdf/transports/gotenbergForm';

const request = {
  url: 'https://app.isaflow.co.za/accounting/reports/report-packs?pack=management&print=1',
  landscape: false,
  allowedApiPaths: ['/api/accounting/reports-pack'],
  cookies: [
    { name: 'sb-access-token', value: 'tok.sig', httpOnly: true },
    { name: 'active_company_id', value: 'c-1', httpOnly: false },
  ],
};

describe('buildGotenbergFields', () => {
  it('sends the page URL and A4 geometry in inches', () => {
    const f = buildGotenbergFields(request);
    expect(f.url).toBe(request.url);
    expect(f.paperWidth).toBe('8.27');
    expect(f.paperHeight).toBe('11.69');
    expect(f.marginTop).toBe('0.71');
    expect(f.marginLeft).toBe('0.55');
  });

  it('waits for the print-ready flag rather than a fixed delay', () => {
    const f = buildGotenbergFields(request);
    expect(f.waitForExpression).toContain('[data-print-ready="true"]');
    expect(f.waitDelay).toBeUndefined();
  });

  it('emulates print media and prints backgrounds', () => {
    const f = buildGotenbergFields(request);
    expect(f.emulatedMediaType).toBe('print');
    expect(f.printBackground).toBe('true');
  });

  it('carries every cookie in one Cookie header', () => {
    const headers = JSON.parse(buildGotenbergFields(request).extraHttpHeaders!);
    expect(headers.Cookie).toBe('sb-access-token=tok.sig; active_company_id=c-1');
  });

  it('sets landscape only when asked', () => {
    expect(buildGotenbergFields(request).landscape).toBe('false');
    expect(buildGotenbergFields({ ...request, landscape: true }).landscape).toBe('true');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd <worktree> && bun run test:unit tests/unit/lib/pdf/gotenbergForm.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement the field builder**

```ts
// src/lib/pdf/transports/gotenbergForm.ts
//
// The multipart FIELDS of a Gotenberg /forms/chromium/convert/url request,
// as a plain object so they can be asserted without a container running.
// The file parts (header.html, footer.html) are added by the transport.

import {
  PAPER_A4_IN, PDF_MARGIN_MM, PRINT_READY_SELECTOR, PRINT_READY_TIMEOUT_MS,
  mmToIn, type PdfRenderRequest,
} from '../pdfTransport';

export function buildGotenbergFields(request: PdfRenderRequest): Record<string, string> {
  const cookieHeader = request.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  return {
    url: request.url,
    paperWidth: PAPER_A4_IN.width.toFixed(2),
    paperHeight: PAPER_A4_IN.height.toFixed(2),
    marginTop: mmToIn(PDF_MARGIN_MM.top),
    marginBottom: mmToIn(PDF_MARGIN_MM.bottom),
    marginLeft: mmToIn(PDF_MARGIN_MM.left),
    marginRight: mmToIn(PDF_MARGIN_MM.right),
    landscape: String(request.landscape),
    printBackground: 'true',
    emulatedMediaType: 'print',
    // The same gate the Playwright transport waits on. A waitDelay would be a
    // guess that either truncates a slow pack or wastes seconds on a fast one.
    waitForExpression: `document.querySelector('${PRINT_READY_SELECTOR}') !== null`,
    // The app holds background connections open, so network-idle never fires.
    skipNetworkIdleEvent: 'true',
    extraHttpHeaders: JSON.stringify({ Cookie: cookieHeader }),
  };
}

export const GOTENBERG_TIMEOUT_MS = PRINT_READY_TIMEOUT_MS + 30_000;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd <worktree> && bun run test:unit tests/unit/lib/pdf/gotenbergForm.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the transport**

```ts
// src/lib/pdf/transports/gotenbergTransport.ts
//
// Gotenberg Docker sidecar — Chromium URL → PDF. Same operational shape as
// the WeasyPrint sidecar (src/modules/accounting/services/afs/weasyprintService.ts).
//
// Setup on velo:
//   docker run -d \
//     --name gotenberg \
//     --restart unless-stopped \
//     -p 5002:3000 \
//     --add-host host.docker.internal:host-gateway \
//     gotenberg/gotenberg:8 gotenberg \
//       --chromium-allow-list='^https?://(app\.isaflow\.co\.za|host\.docker\.internal:3200)/'
//
// Set GOTENBERG_URL=http://localhost:5002 in the systemd service environment
// (production) and in .env.local for a local container. Unset, renderPagePdf
// uses the Playwright transport instead — see selectTransport.ts.
//
// Verify:
//   curl --request POST http://localhost:5002/forms/chromium/convert/url \
//     --form url=https://gotenberg.dev --output test.pdf
//
// NOTE: Gotenberg fetches the URL itself, from inside the container. APP_URL
// must therefore be reachable FROM the container (host.docker.internal in dev,
// the real hostname in production) and must be on the chromium-allow-list.
//
// NOTE: unlike the Playwright transport, Gotenberg cannot intercept the page's
// own requests, so background /api/* calls are not stubbed. They 401 — the
// print token authorises only `allowedApiPaths` — and withAuth deliberately
// does NOT clear cookies for a valid token bound elsewhere, so the report
// fetch is unaffected. A page in this pipeline must tolerate a 401 on any call
// outside its authorised set.

import { buildGotenbergFields, GOTENBERG_TIMEOUT_MS } from './gotenbergForm';
import { FOOTER_HTML, HEADER_HTML, type PdfRenderRequest, type PdfTransport } from '../pdfTransport';
import { log } from '@/lib/logger';

const CONVERT_PATH = '/forms/chromium/convert/url';

function htmlPart(html: string): Blob {
  return new Blob([`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`], {
    type: 'text/html',
  });
}

export const gotenbergTransport: PdfTransport = {
  name: 'gotenberg',
  async render(request: PdfRenderRequest): Promise<Buffer> {
    const base = process.env.GOTENBERG_URL;
    if (!base) throw new Error('GOTENBERG_URL is not set');

    const form = new FormData();
    for (const [key, value] of Object.entries(buildGotenbergFields(request))) {
      form.append(key, value);
    }
    // Chromium renders these two as the running header and footer. The header
    // is empty so Chromium's default title/date line is suppressed.
    form.append('files', htmlPart(HEADER_HTML), 'header.html');
    form.append('files', htmlPart(FOOTER_HTML), 'footer.html');

    const response = await fetch(`${base}${CONVERT_PATH}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(GOTENBERG_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      log.error('gotenbergTransport: render failed', { status: response.status, body }, 'pdf');
      throw new Error(`Gotenberg error: ${response.status} ${body}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    log.info('gotenbergTransport: rendered', { url: request.url, bytes: bytes.length }, 'pdf');
    return bytes;
  },
};
```

- [ ] **Step 6: Type-check and commit**

```bash
cd <worktree>
bun run type-check
git add src/lib/pdf/transports/gotenbergForm.ts src/lib/pdf/transports/gotenbergTransport.ts tests/unit/lib/pdf/gotenbergForm.test.ts
git commit -m "feat(pdf): Gotenberg transport for production rendering"
```

---
### Task 4: Pack section identity — IFRS titles, landscape flags, chart options

Two pure files the rest of the workstream builds on: which sections a pack has and what they are called in a document sent to a client, and the ECharts options for the two sections that are charts.

**Files:**
- Create: `src/modules/accounting/services/packs/packSections.ts`
- Create: `src/modules/accounting/services/packs/packChartOptions.ts`
- Test: `tests/unit/services/packs/packSections.test.ts`
- Test: `tests/unit/services/packs/packChartOptions.test.ts`

**Interfaces:**
- Consumes: `getPackTemplate(type: PackType): PackSectionConfig[]` and `type PackType = 'board' | 'management' | 'monthly'` from `@/modules/accounting/services/reports/reportPackService`; `WaterfallStep { label, start, end, value, isSubtotal, color }` from `@/modules/accounting/services/reports/waterfallDataService`.
- Produces:
  - `PACK_LABELS: Record<PackType, string>`
  - `packSectionTitle(sectionType: string, fallback: string): string`
  - `isLandscapeSection(sectionType: string): boolean`
  - `packPrintApiPaths(packType: PackType): string[]`
  - `packTrendApiPath(packType: PackType): string`
  - `PACK_DATA_API = '/api/accounting/reports-pack'`
  - `interface TrendPoint { label: string; value: number }`
  - `interface ChartPalette { ink: string; fav: string; unfav: string; prior: string; axis: string }`, `DEFAULT_CHART_PALETTE`
  - `waterfallOption(steps: WaterfallStep[], palette?: ChartPalette): EChartsCoreOption`
  - `trendOption(points: TrendPoint[], palette?: ChartPalette): EChartsCoreOption`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/services/packs/packSections.test.ts
import { describe, it, expect } from 'vitest';
import { getPackTemplate } from '@/modules/accounting/services/reports/reportPackService';
import {
  packSectionTitle, isLandscapeSection, packPrintApiPaths, packTrendApiPath, PACK_DATA_API, PACK_LABELS,
} from '@/modules/accounting/services/packs/packSections';

describe('packSectionTitle', () => {
  it('uses the IFRS for SMEs names for the three primary statements', () => {
    expect(packSectionTitle('income_statement', 'Income Statement')).toBe('Statement of Comprehensive Income');
    expect(packSectionTitle('balance_sheet', 'Balance Sheet')).toBe('Statement of Financial Position');
    expect(packSectionTitle('cash_flow', 'Cash Flow')).toBe('Statement of Cash Flows');
  });

  it('has a title for EVERY section the pack service emits, on every pack type', () => {
    // A section added to reportPackService with no entry here would otherwise
    // print its plain-English screen label inside an IFRS document.
    for (const type of ['board', 'management', 'monthly'] as const) {
      for (const section of getPackTemplate(type)) {
        expect(packSectionTitle(section.type, '')).not.toBe('');
      }
    }
  });
});

describe('isLandscapeSection', () => {
  it('turns the two chart sections sideways and nothing else', () => {
    expect(isLandscapeSection('waterfall')).toBe(true);
    expect(isLandscapeSection('trends')).toBe(true);
    expect(isLandscapeSection('income_statement')).toBe(false);
    expect(isLandscapeSection('ratios')).toBe(false);
  });
});

describe('print API paths', () => {
  it('authorises the pack route and the pack-specific trend route, and nothing else', () => {
    expect(packPrintApiPaths('management')).toEqual([PACK_DATA_API, '/api/accounting/packs/management/trend']);
    expect(packTrendApiPath('board')).toBe('/api/accounting/packs/board/trend');
  });
  it('names all three packs', () => {
    expect(Object.keys(PACK_LABELS).sort()).toEqual(['board', 'management', 'monthly']);
  });
});
```

```ts
// tests/unit/services/packs/packChartOptions.test.ts
import { describe, it, expect } from 'vitest';
import { waterfallOption, trendOption, DEFAULT_CHART_PALETTE } from '@/modules/accounting/services/packs/packChartOptions';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';

const steps: WaterfallStep[] = [
  { label: 'Revenue', start: 0, end: 1000, value: 1000, isSubtotal: false, color: 'green' },
  { label: 'Cost of Sales', start: 1000, end: 600, value: -400, isSubtotal: false, color: 'red' },
  { label: 'Gross Profit', start: 0, end: 600, value: 600, isSubtotal: true, color: 'teal' },
];

interface BarSeries { name: string; type: string; stack: string; data: Array<number | { value: number; itemStyle: { color: string } }> }

describe('waterfallOption', () => {
  it('labels the x axis with the step labels, in order', () => {
    const opt = waterfallOption(steps) as { xAxis: { data: string[] } };
    expect(opt.xAxis.data).toEqual(['Revenue', 'Cost of Sales', 'Gross Profit']);
  });

  it('floats each bar on an invisible base at the lower of start and end', () => {
    const opt = waterfallOption(steps) as unknown as { series: BarSeries[] };
    expect(opt.series[0]!.data).toEqual([0, 600, 0]);
  });

  it('draws the visible bar at the absolute movement', () => {
    const opt = waterfallOption(steps) as unknown as { series: BarSeries[] };
    const values = opt.series[1]!.data.map((d) => (typeof d === 'number' ? d : d.value));
    expect(values).toEqual([1000, 400, 600]);
  });

  it('paints increases favourable, decreases unfavourable, subtotals in ink', () => {
    const opt = waterfallOption(steps) as unknown as { series: BarSeries[] };
    const colours = opt.series[1]!.data.map((d) => (typeof d === 'number' ? '' : d.itemStyle.color));
    expect(colours).toEqual([DEFAULT_CHART_PALETTE.fav, DEFAULT_CHART_PALETTE.unfav, DEFAULT_CHART_PALETTE.ink]);
  });
});

describe('trendOption', () => {
  const points = [
    { label: 'Mar 2026', value: 100 },
    { label: 'Apr 2026', value: 140 },
  ];

  it('plots the points as given, in order', () => {
    const opt = trendOption(points) as unknown as { xAxis: { data: string[] }; series: Array<{ data: number[] }> };
    expect(opt.xAxis.data).toEqual(['Mar 2026', 'Apr 2026']);
    expect(opt.series[0]!.data).toEqual([100, 140]);
  });

  it('renders without animation, so a headless screenshot is never mid-transition', () => {
    const opt = trendOption(points) as { animation: boolean };
    expect(opt.animation).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd <worktree> && bun run test:unit tests/unit/services/packs/`
Expected: FAIL, cannot find either module.

- [ ] **Step 3: Implement `packSections.ts`**

```ts
/**
 * What a pack's sections are called, which way up they print, and which API
 * paths the printed page is allowed to call.
 *
 * The titles are IFRS for SMEs names, not the screen's plain-English labels:
 * a pack is a document a director forwards to a bank, and "Balance Sheet" on
 * a page headed "IFRS for SMEs" is a finding waiting to happen. The screen
 * keeps its own labels — only the pack is renamed.
 */
import type { PackType } from '@/modules/accounting/services/reports/reportPackService';

export const PACK_LABELS: Record<PackType, string> = {
  board: 'Board Pack',
  management: 'Management Pack',
  monthly: 'Monthly Pack',
};

const IFRS_TITLES: Record<string, string> = {
  income_statement: 'Statement of Comprehensive Income',
  balance_sheet: 'Statement of Financial Position',
  cash_flow: 'Statement of Cash Flows',
  ratios: 'Financial Ratios',
  kpis: 'KPI Scorecard',
  waterfall: 'Profit Bridge',
  trends: 'Twelve-Month Trend',
  commentary: 'Commentary',
};

/** The pack's title for a section. `fallback` is the service's own title and
 *  is only reached by a section type added upstream without an entry above —
 *  which packSections.test.ts fails on. */
export function packSectionTitle(sectionType: string, fallback: string): string {
  return IFRS_TITLES[sectionType] ?? fallback;
}

/** Sections whose content is a chart wide enough to need the page turned. */
const LANDSCAPE = new Set(['waterfall', 'trends']);

export function isLandscapeSection(sectionType: string): boolean {
  return LANDSCAPE.has(sectionType);
}

export const PACK_DATA_API = '/api/accounting/reports-pack';

export function packTrendApiPath(packType: PackType): string {
  return `/api/accounting/packs/${packType}/trend`;
}

/**
 * The exact API pathnames the printed pack page fetches — and therefore the
 * exact set the print token authorises. One list, read by the page (to build
 * its URLs) and by the download route (to mint the token), so the two cannot
 * drift into a 401 that shows up as an empty chart.
 */
export function packPrintApiPaths(packType: PackType): string[] {
  return [PACK_DATA_API, packTrendApiPath(packType)];
}
```

- [ ] **Step 4: Implement `packChartOptions.ts`**

```ts
/**
 * ECharts options for the pack's two chart sections. Pure: no DOM, no theme
 * lookup, no data fetching — so the same option object is rendered by the
 * browser on the printed page and by the server-side SVG renderer.
 *
 * The palette is a parameter rather than a `getComputedStyle` call because
 * this module runs in Node (serverChartSvg.ts) as well as in the browser.
 * Defaults mirror the `--ff-*` fallbacks in src/lib/charts/theme.ts.
 *
 * NOTE ON FIGURES: `base` and `visible` below are chart GEOMETRY derived from
 * the service's own `start`, `end` and `value`; no figure is invented and
 * nothing is summed. The number a reader sees on a bar label is `step.value`
 * exactly as the service produced it.
 */
import type { EChartsCoreOption } from 'echarts/core';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';

export interface ChartPalette {
  ink: string;
  fav: string;
  unfav: string;
  prior: string;
  axis: string;
}

export const DEFAULT_CHART_PALETTE: ChartPalette = {
  ink: '#15202b',
  fav: '#1f7a4d',
  unfav: '#b23a3a',
  prior: '#c9d0cc',
  axis: '#9ca3af',
};

export interface TrendPoint {
  label: string;
  value: number;
}

function stepColour(step: WaterfallStep, palette: ChartPalette): string {
  if (step.isSubtotal) return palette.ink;
  return step.value < 0 ? palette.unfav : palette.fav;
}

export function waterfallOption(steps: WaterfallStep[], palette: ChartPalette = DEFAULT_CHART_PALETTE): EChartsCoreOption {
  return {
    animation: false,
    grid: { left: 80, right: 24, top: 24, bottom: 72 },
    xAxis: {
      type: 'category',
      data: steps.map((s) => s.label),
      axisLabel: { color: palette.axis, interval: 0, rotate: 30 },
      axisLine: { lineStyle: { color: palette.axis } },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: palette.axis },
      axisLine: { lineStyle: { color: palette.axis } },
      splitLine: { lineStyle: { color: palette.prior } },
    },
    series: [
      {
        name: 'base',
        type: 'bar',
        stack: 'waterfall',
        silent: true,
        itemStyle: { color: 'transparent' },
        data: steps.map((s) => (s.isSubtotal ? 0 : Math.min(s.start, s.end))),
      },
      {
        name: 'movement',
        type: 'bar',
        stack: 'waterfall',
        data: steps.map((s) => ({
          value: Math.abs(s.value),
          itemStyle: { color: stepColour(s, palette) },
        })),
      },
    ],
  };
}

export function trendOption(points: TrendPoint[], palette: ChartPalette = DEFAULT_CHART_PALETTE): EChartsCoreOption {
  return {
    animation: false,
    grid: { left: 80, right: 24, top: 24, bottom: 64 },
    xAxis: {
      type: 'category',
      data: points.map((p) => p.label),
      axisLabel: { color: palette.axis, interval: 0, rotate: 30 },
      axisLine: { lineStyle: { color: palette.axis } },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: palette.axis },
      axisLine: { lineStyle: { color: palette.axis } },
      splitLine: { lineStyle: { color: palette.prior } },
    },
    series: [
      {
        name: 'Actual',
        type: 'bar',
        itemStyle: { color: palette.ink },
        data: points.map((p) => p.value),
      },
    ],
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd <worktree> && bun run test:unit tests/unit/services/packs/`
Expected: PASS.

- [ ] **Step 6: Prove the title coverage test bites**

Add a temporary tenth section `{ type: 'gearing', title: 'Gearing' }` to `MONTHLY_SECTIONS` in `reportPackService.ts`, run the suite, and confirm "has a title for EVERY section the pack service emits" goes RED. Revert.

Run: `cd <worktree> && bun run test:unit tests/unit/services/packs/packSections.test.ts`
Expected: RED with the extra section, PASS after reverting.

- [ ] **Step 7: Commit**

```bash
cd <worktree>
bun run type-check
git add src/modules/accounting/services/packs/packSections.ts src/modules/accounting/services/packs/packChartOptions.ts tests/unit/services/packs/packSections.test.ts tests/unit/services/packs/packChartOptions.test.ts
git commit -m "feat(packs): IFRS section titles, landscape flags and pure chart options"
```

---

### Task 5: The twelve-month trend series

The pack's `trends` section is a single-period snapshot with the text "Trend data requires multi-period historical context" on the page. Give it a real twelve-month series, defined once so the PDF and the PPTX plot the same numbers.

**Files:**
- Create: `src/modules/accounting/services/packs/packTrendService.ts`
- Create: `pages/api/accounting/packs/[id]/trend.ts`
- Test: `tests/unit/services/packs/packTrendService.test.ts`

**Interfaces:**
- Consumes: `sql` from `@/lib/neon`, `log` from `@/lib/logger`, `PackType` from `reportPackService`.
- Produces:
  - `interface PackTrendPoint { month: string; label: string; revenue: number; expenses: number; netProfit: number }`
  - `monthSlots(to: string, months: number): Array<{ month: string; label: string; from: string; to: string }>`
  - `getPackTrend(companyId: string, to: string, months?: number): Promise<PackTrendPoint[]>`
  - Route `GET /api/accounting/packs/[id]/trend?to=YYYY-MM-DD&months=12` → `apiResponse.success(res, points)`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/packs/packTrendService.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { getPackTrend, monthSlots } from '@/modules/accounting/services/packs/packTrendService';

const COMPANY = '11111111-1111-4111-8111-111111111111';

describe('monthSlots', () => {
  it('ends on the month of `to` and counts backwards', () => {
    const slots = monthSlots('2026-03-15', 3);
    expect(slots.map((s) => s.month)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('crosses a year boundary', () => {
    const slots = monthSlots('2026-02-28', 3);
    expect(slots.map((s) => s.month)).toEqual(['2025-12', '2026-01', '2026-02']);
  });

  it('gives each month its real last day, February included', () => {
    const [feb] = monthSlots('2026-02-10', 1);
    expect(feb!.from).toBe('2026-02-01');
    expect(feb!.to).toBe('2026-02-28');
  });

  it('never builds a date through toISOString, which shifts a SAST midnight back a day', () => {
    const slots = monthSlots('2026-01-01', 1);
    expect(slots[0]!.month).toBe('2026-01');
  });
});

describe('getPackTrend', () => {
  beforeEach(() => sqlMock.mockReset());

  it('scopes the query to the company on both tables', async () => {
    sqlMock.mockResolvedValue([]);
    await getPackTrend(COMPANY, '2026-03-31', 2);
    const params = sqlMock.mock.calls[0]!.slice(1);
    expect(params.filter((p) => p === COMPANY).length).toBeGreaterThanOrEqual(2);
  });

  it('returns one point per month, zero-filling a month with no journals', async () => {
    sqlMock.mockResolvedValue([{ month: '2026-03', revenue: '1000.50', expenses: '400.25' }]);
    const points = await getPackTrend(COMPANY, '2026-03-31', 2);
    expect(points).toEqual([
      { month: '2026-02', label: 'Feb 2026', revenue: 0, expenses: 0, netProfit: 0 },
      { month: '2026-03', label: 'Mar 2026', revenue: 1000.5, expenses: 400.25, netProfit: 600.25 },
    ]);
  });

  it('clamps months to the 1-12 range', async () => {
    sqlMock.mockResolvedValue([]);
    expect(await getPackTrend(COMPANY, '2026-03-31', 99)).toHaveLength(12);
    expect(await getPackTrend(COMPANY, '2026-03-31', 0)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd <worktree> && bun run test:unit tests/unit/services/packs/packTrendService.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement the service**

```ts
/**
 * The pack's twelve-month revenue / expense / profit series.
 *
 * One definition, because the printed PDF fetches it over HTTP while the PPTX
 * exporter calls it in-process; two queries would be two chances to disagree
 * on a document and a deck that a reader compares side by side.
 *
 * Dates are built from local calendar parts, never through toISOString(): on
 * this UTC+2 host `new Date('2026-01-01').toISOString()` is the previous day,
 * which silently drops a month off the front of the series.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

export interface PackTrendPoint {
  /** YYYY-MM */
  month: string;
  /** 'Mar 2026' */
  label: string;
  revenue: number;
  expenses: number;
  netProfit: number;
}

interface MonthSlot { month: string; label: string; from: string; to: string }

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number): string => String(n).padStart(2, '0');

/** The `months` calendar months ending with the month containing `to`. */
export function monthSlots(to: string, months: number): MonthSlot[] {
  const [yearPart, monthPart] = to.split('-');
  const endYear = Number(yearPart);
  const endMonth = Number(monthPart); // 1-12
  const count = Math.min(12, Math.max(1, months));

  return Array.from({ length: count }, (_, i) => {
    const offset = endMonth - 1 - (count - 1 - i);
    const year = endYear + Math.floor(offset / 12);
    const monthIndex = ((offset % 12) + 12) % 12;
    const lastDay = new Date(year, monthIndex + 1, 0).getDate();
    return {
      month: `${year}-${pad(monthIndex + 1)}`,
      label: `${MONTH_NAMES[monthIndex]} ${year}`,
      from: `${year}-${pad(monthIndex + 1)}-01`,
      to: `${year}-${pad(monthIndex + 1)}-${pad(lastDay)}`,
    };
  });
}

type Row = Record<string, unknown>;
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export async function getPackTrend(companyId: string, to: string, months = 12): Promise<PackTrendPoint[]> {
  const slots = monthSlots(to, months);
  const first = slots[0]!;
  const last = slots[slots.length - 1]!;

  const rows = (await sql`
    SELECT to_char(je.entry_date, 'YYYY-MM')                                                        AS month,
           COALESCE(SUM(CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit ELSE 0 END), 0) AS revenue,
           COALESCE(SUM(CASE WHEN ga.account_type = 'expense' THEN jl.debit - jl.credit ELSE 0 END), 0) AS expenses
    FROM   gl_journal_lines  jl
    JOIN   gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN   gl_accounts        ga ON ga.id = jl.gl_account_id
    WHERE  je.company_id = ${companyId}
      AND  jl.company_id = ${companyId}::UUID
      AND  je.status     = 'posted'
      AND  je.entry_date >= ${first.from}::date
      AND  je.entry_date <= ${last.to}::date
    GROUP  BY 1
  `) as Row[];

  const byMonth = new Map(rows.map((r) => [String(r.month), r]));

  const points = slots.map((slot) => {
    const row = byMonth.get(slot.month);
    const revenue = num(row?.revenue);
    const expenses = num(row?.expenses);
    return {
      month: slot.month,
      label: slot.label,
      revenue,
      expenses,
      // The only arithmetic in this workstream, and it is the definition of
      // the series itself, not a restatement of a service figure.
      netProfit: Math.round((revenue - expenses) * 100) / 100,
    };
  });

  log.info('getPackTrend', { companyId, to, months: points.length }, 'packs');
  return points;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd <worktree> && bun run test:unit tests/unit/services/packs/packTrendService.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the route**

```ts
// pages/api/accounting/packs/[id]/trend.ts
/**
 * GET /api/accounting/packs/[id]/trend?to=YYYY-MM-DD&months=12
 *
 * The twelve-month series behind a pack's trend chart. Its own route (rather
 * than a field on reports-pack) because the printed page fetches it as a
 * second authorised path — see packPrintApiPaths.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { checkReportRateLimit } from '@/lib/rateLimit';
import { getPackTrend } from '@/modules/accounting/services/packs/packTrendService';
import type { PackType } from '@/modules/accounting/services/reports/reportPackService';

const VALID_TYPES: PackType[] = ['board', 'management', 'monthly'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!VALID_TYPES.includes(id as PackType)) {
    return apiResponse.badRequest(res, `id must be one of: ${VALID_TYPES.join(', ')}`);
  }

  const to = String(req.query.to ?? '');
  if (!ISO_DATE.test(to)) return apiResponse.badRequest(res, 'to must be a YYYY-MM-DD date');

  const months = Number(req.query.months ?? 12);
  if (!Number.isFinite(months)) return apiResponse.badRequest(res, 'months must be a number');

  if (!(await checkReportRateLimit(companyId, 'packs-trend'))) {
    log.warn('Pack trend rate limit exceeded', { companyId }, 'rateLimit');
    return apiResponse.tooManyRequests(res, 'Too many report requests. Please try again shortly.');
  }

  return apiResponse.success(res, await getPackTrend(companyId, to, months));
}

export default withAuth(withErrorHandler(handler as never));
```

- [ ] **Step 6: Register the route's response type**

`apiJson` infers a response type from `src/lib/apiRoutes.ts`; an unregistered route resolves to `unknown`. Add one line to `DynamicRoutes` and one type import (this file belongs to the lead — see "Requests to other owners"):

```diff
+import type { getPackTrend } from '@/modules/accounting/services/packs/packTrendService';
 interface DynamicRoutes {
   '/api/admin/users/{}/impersonate': { redirect: string };
+  '/api/accounting/packs/{}/trend': Awaited<ReturnType<typeof getPackTrend>>;
 }
```

- [ ] **Step 7: Type-check and commit**

```bash
cd <worktree>
bun run type-check
git add src/modules/accounting/services/packs/packTrendService.ts pages/api/accounting/packs/[id]/trend.ts src/lib/apiRoutes.ts tests/unit/services/packs/packTrendService.test.ts
git commit -m "feat(packs): twelve-month trend series and its route"
```

---

### Task 6: `PackDocument` — the one model behind the page, the PDF and the deck

Three surfaces currently read `pack.sections[].data` with their own string keys. Give them one typed model, built by copying, and hold that with a test that fails when any number appears in the document that is not in the pack.

**Files:**
- Modify: `src/modules/accounting/services/reports/statementRows/packMappers.ts` (extract `toManagementBsRows` — see Step 3; requires the lead's grant)
- Modify: `src/components/accounting/ManagementPandLRows.tsx` (call the extracted mapper — same grant)
- Create: `src/modules/accounting/services/packs/packDocument.ts`
- Test: `tests/unit/services/packs/packDocument.test.ts`

**Interfaces:**
- Consumes: `ReportPack`, `PackSection`, `PackType` from `reportPackService`; `toManagementPandLRows`, `packToTotals`, `packToMargins`, `packToBsTotals`, `packToBsDetail` from `statementRows/packMappers`; `StatementRow` from `statementRows/statementModel`; `KPIScorecardItem` from `kpiScorecardService`; `WaterfallStep` from `waterfallDataService`; `PackTrendPoint` from `packTrendService`; `packSectionTitle`, `isLandscapeSection` from `packSections`.
- Produces:
  - `type PackBlock = { kind: 'statement'; rows: StatementRow[] } | { kind: 'kv'; items: PackKvItem[] } | { kind: 'scorecard'; items: KPIScorecardItem[] } | { kind: 'waterfall'; steps: WaterfallStep[] } | { kind: 'trend'; points: PackTrendPoint[] } | { kind: 'text'; text: string }`
  - `interface PackKvItem { label: string; value: number; format: 'money' | 'ratio' | 'pct' }`
  - `interface PackDocumentSection { type: string; title: string; landscape: boolean; blocks: PackBlock[] }`
  - `interface PackDocument { packType: PackType; companyName: string; period: string; generatedAt: string; sections: PackDocumentSection[] }`
  - `buildPackDocument(pack: ReportPack, trend: PackTrendPoint[]): PackDocument`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/packs/packDocument.test.ts
import { describe, it, expect } from 'vitest';
import { buildReportPack, type ReportPackInput } from '@/modules/accounting/services/reports/reportPackService';
import { buildPackDocument } from '@/modules/accounting/services/packs/packDocument';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';

const INPUT: ReportPackInput = {
  companyName: 'ISAFlow Demo', period: '2026-01-01 to 2026-09-05',
  revenue: 4812345.67, costOfSales: 2190000, operatingExpenses: 1400000, netProfit: 1275632.74,
  totalAssets: 8200000, totalLiabilities: 3100000, totalEquity: 5100000,
  currentAssets: 4400000, currentLiabilities: 1900000, cash: 1250000,
  accountsReceivable: 2100000, accountsPayable: 900000, inventory: 350000,
  otherIncome: 53787.07, otherExpenses: 0, operatingProfit: 1275632.74,
};

const TREND: PackTrendPoint[] = [
  { month: '2026-08', label: 'Aug 2026', revenue: 400000, expenses: 300000, netProfit: 100000 },
  { month: '2026-09', label: 'Sep 2026', revenue: 420000, expenses: 310000, netProfit: 110000 },
];

const pack = buildReportPack('management', INPUT, '2026-01-01', '2026-09-05');

/** Every number reachable in a value, however deeply nested. */
function numbersIn(value: unknown, found: Set<number> = new Set()): Set<number> {
  if (typeof value === 'number') { found.add(Math.round(value * 100) / 100); return found; }
  if (Array.isArray(value)) { value.forEach((v) => numbersIn(v, found)); return found; }
  if (value && typeof value === 'object') { Object.values(value).forEach((v) => numbersIn(v, found)); return found; }
  return found;
}

describe('buildPackDocument', () => {
  it('carries every section the pack has, in order, under its IFRS title', () => {
    const doc = buildPackDocument(pack, TREND);
    expect(doc.sections.map((s) => s.type)).toEqual(pack.sections.map((s) => s.type));
    expect(doc.sections[0]!.title).toBe('Statement of Comprehensive Income');
  });

  it('turns only the chart sections landscape', () => {
    const doc = buildPackDocument(pack, TREND);
    const landscape = doc.sections.filter((s) => s.landscape).map((s) => s.type);
    expect(landscape).toEqual(['waterfall', 'trends']);
  });

  it('INVENTS NO FIGURE: every number in the document is a pack number', () => {
    const doc = buildPackDocument(pack, TREND);
    const allowed = numbersIn(pack.sections.map((s) => s.data));
    numbersIn(TREND).forEach((n) => allowed.add(n));
    // The one documented exception, inherited from ManagementBalanceSheetRows:
    // the report has no Total Liabilities and Equity field, so the row sums the
    // two subtotals. Nothing else may be derived.
    allowed.add(Math.round((INPUT.totalLiabilities + INPUT.totalEquity) * 100) / 100);
    // Row depths and chart geometry are structure, not figures.
    [0, 1].forEach((n) => allowed.add(n));

    const unexplained = [...numbersIn(doc.sections)].filter((n) => !allowed.has(n));
    expect(unexplained).toEqual([]);
  });

  it('keeps the P&L bands the pack service produced, bottom line included', () => {
    const doc = buildPackDocument(pack, TREND);
    const is = doc.sections.find((s) => s.type === 'income_statement')!;
    const rows = (is.blocks.find((b) => b.kind === 'statement') as { rows: Array<{ id: string; actual: number }> }).rows;
    expect(rows.find((r) => r.id === 'grand:netProfit')!.actual).toBe(INPUT.netProfit);
    expect(rows.map((r) => r.id)).toContain('total:operatingProfit');
  });

  it('plots the trend series it was handed, not the pack single-period snapshot', () => {
    const doc = buildPackDocument(pack, TREND);
    const trends = doc.sections.find((s) => s.type === 'trends')!;
    const block = trends.blocks.find((b) => b.kind === 'trend') as { points: PackTrendPoint[] };
    expect(block.points).toEqual(TREND);
  });

  it('renders an empty trend series as a text block rather than an empty chart', () => {
    const doc = buildPackDocument(pack, []);
    const trends = doc.sections.find((s) => s.type === 'trends')!;
    expect(trends.blocks.some((b) => b.kind === 'text')).toBe(true);
    expect(trends.blocks.some((b) => b.kind === 'trend')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd <worktree> && bun run test:unit tests/unit/services/packs/packDocument.test.ts`
Expected: FAIL, cannot find module `@/modules/accounting/services/packs/packDocument`.

- [ ] **Step 3: Extract the balance-sheet rows into the mapper they belong in**

The balance-sheet row list currently lives inside `ManagementBalanceSheetRows` in `src/components/accounting/ManagementPandLRows.tsx`. The document needs the same rows and must not hold a second copy — a second copy of a row list is how the pack came to be short by other income less other expenses. Move it, unchanged, into `packMappers.ts`:

```ts
// src/modules/accounting/services/reports/statementRows/packMappers.ts (append)
/**
 * The management pack's balance-sheet summary rows — three subtotals plus the
 * derived Total Liabilities and Equity line (the report has no field for this;
 * same documented exception as balanceSheetRows.ts). `detail` copies the
 * report's own figures in, no arithmetic.
 *
 * Moved here from ManagementPandLRows.tsx so the printed pack and the PPTX
 * deck render the SAME rows the screen does rather than a second list.
 */
export function toManagementBsRows(
  bs: Record<string, number> | undefined,
  detail?: BalanceSheetDetail,
): StatementRow[] {
  const n = (k: string) => bs?.[k] ?? 0;
  return [
    { id: 'sub:totalAssets', kind: 'subtotal', label: 'Total Assets', depth: 0, actual: n('totalAssets') },
    ...(detail?.currentAssets !== undefined ? [{ id: 'line:currentAssets', kind: 'line' as const, label: 'Current Assets', depth: 1 as const, actual: detail.currentAssets }] : []),
    ...(detail?.cash !== undefined ? [{ id: 'line:cash', kind: 'line' as const, label: 'Cash', depth: 1 as const, actual: detail.cash }] : []),
    ...(detail?.accountsReceivable !== undefined ? [{ id: 'line:accountsReceivable', kind: 'line' as const, label: 'Accounts Receivable', depth: 1 as const, actual: detail.accountsReceivable }] : []),
    { id: 'sub:totalLiabilities', kind: 'subtotal', label: 'Total Liabilities', depth: 0, actual: n('totalLiabilities') },
    ...(detail?.accountsPayable !== undefined ? [{ id: 'line:accountsPayable', kind: 'line' as const, label: 'Accounts Payable', depth: 1 as const, actual: detail.accountsPayable }] : []),
    { id: 'sub:totalEquity', kind: 'subtotal', label: 'Total Equity', depth: 0, actual: n('totalEquity') },
    { id: 'grand:totalLiabilitiesAndEquity', kind: 'grand', label: 'Total Liabilities and Equity', depth: 0, actual: n('totalLiabilities') + n('totalEquity') },
  ];
}
```

Then in `src/components/accounting/ManagementPandLRows.tsx`, replace the inline `const rows: StatementRow[] = [...]` with:

```tsx
export function ManagementBalanceSheetRows({ bs, detail }: { bs: Record<string, number> | undefined; detail?: BalanceSheetDetail }) {
  return <StatementGrid rows={toManagementBsRows(bs, detail)} columns={{ prior: false, budget: false, variance: false, trend: false }} cents />;
}
```

and add `toManagementBsRows` to the existing import from `packMappers`. The `StatementRow` type import becomes unused there — remove it.

Run the existing surface tests to prove the move changed nothing:
`cd <worktree> && bun run test:unit tests/unit/services/reports/ && bun run test:components`

- [ ] **Step 4: Implement `packDocument.ts`**

```ts
/**
 * The pack, as a model.
 *
 * The screen, the printed PDF and the PPTX deck all rendered `section.data`
 * with their own string keys and their own `?? 0` fallbacks, which is silent:
 * a rename in reportPackService produces a plausible document full of zeros
 * with no compile error. This is the one typed shape all three read, and
 * packDocument.test.ts fails if a number appears here that is not in the pack.
 *
 * NOTHING IN THIS FILE COMPUTES A FIGURE. Every value is copied through the
 * mappers in statementRows/packMappers.ts, which are themselves copies.
 */
import type { PackSection, PackType, ReportPack } from '@/modules/accounting/services/reports/reportPackService';
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';
import {
  packToBsDetail, packToBsTotals, packToMargins, packToTotals,
  toManagementBsRows, toManagementPandLRows,
} from '@/modules/accounting/services/reports/statementRows/packMappers';
import type { KPIScorecardItem } from '@/modules/accounting/services/reports/kpiScorecardService';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import type { PackTrendPoint } from './packTrendService';
import { isLandscapeSection, packSectionTitle } from './packSections';

export interface PackKvItem {
  label: string;
  value: number;
  format: 'money' | 'ratio' | 'pct';
}

export type PackBlock =
  | { kind: 'statement'; rows: StatementRow[] }
  | { kind: 'kv'; items: PackKvItem[] }
  | { kind: 'scorecard'; items: KPIScorecardItem[] }
  | { kind: 'waterfall'; steps: WaterfallStep[] }
  | { kind: 'trend'; points: PackTrendPoint[] }
  | { kind: 'text'; text: string };

export interface PackDocumentSection {
  type: string;
  title: string;
  landscape: boolean;
  blocks: PackBlock[];
}

export interface PackDocument {
  packType: PackType;
  companyName: string;
  period: string;
  generatedAt: string;
  sections: PackDocumentSection[];
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const CASH_FLOW_LINES: Array<[string, string]> = [
  ['Operating Cash Flow', 'operatingCashFlow'],
  ['Investing Cash Flow', 'investingCashFlow'],
  ['Financing Cash Flow', 'financingCashFlow'],
  ['Net Cash Flow', 'netCashFlow'],
  ['Opening Cash', 'openingCash'],
  ['Closing Cash', 'closingCash'],
];

function humanise(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
}

function blocksFor(section: PackSection, trend: PackTrendPoint[]): PackBlock[] {
  const d = section.data;

  switch (section.type) {
    case 'income_statement': {
      const margins = packToMargins(d);
      return [
        { kind: 'statement', rows: toManagementPandLRows(packToTotals(d)) },
        {
          kind: 'kv',
          items: [
            { label: 'Gross Margin', value: margins.grossMargin, format: 'pct' },
            { label: 'Net Margin', value: margins.netMargin, format: 'pct' },
          ],
        },
      ];
    }

    case 'balance_sheet':
      return [{ kind: 'statement', rows: toManagementBsRows(packToBsTotals(d), packToBsDetail(d)) }];

    case 'cash_flow':
      return [{
        kind: 'kv',
        items: CASH_FLOW_LINES.map(([label, key]) => ({ label, value: num(d[key]), format: 'money' as const })),
      }];

    case 'ratios':
      return [{
        kind: 'kv',
        items: Object.entries(d)
          .filter(([, v]) => typeof v === 'number')
          .map(([k, v]) => ({ label: humanise(k), value: num(v), format: 'ratio' as const })),
      }];

    case 'kpis': {
      const items = (d.scorecard as KPIScorecardItem[] | undefined) ?? [];
      return [{ kind: 'scorecard', items }];
    }

    case 'waterfall': {
      const steps = (d.steps as WaterfallStep[] | undefined) ?? [];
      return steps.length > 0
        ? [{ kind: 'waterfall', steps }]
        : [{ kind: 'text', text: 'No profit bridge for this period.' }];
    }

    case 'trends':
      return trend.length > 0
        ? [{ kind: 'trend', points: trend }]
        : [{ kind: 'text', text: 'No posted journals in the last twelve months.' }];

    case 'commentary':
      return [{ kind: 'text', text: String(d.summary ?? '') }];

    default:
      return [];
  }
}

export function buildPackDocument(pack: ReportPack, trend: PackTrendPoint[]): PackDocument {
  return {
    packType: pack.type,
    companyName: pack.companyName,
    period: pack.period,
    generatedAt: pack.generatedAt,
    sections: pack.sections.map((section) => ({
      type: section.type,
      title: packSectionTitle(section.type, section.title),
      landscape: isLandscapeSection(section.type),
      blocks: blocksFor(section, trend),
    })),
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd <worktree> && bun run test:unit tests/unit/services/packs/packDocument.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove the no-new-numbers test bites**

Temporarily change the cash-flow block to `value: num(d[key]) * 1.15` (a VAT-inclusive "improvement" of exactly the kind that must never reach a pack), run the test, and confirm "INVENTS NO FIGURE" goes RED with the unexplained numbers listed. Revert.

Run: `cd <worktree> && bun run test:unit tests/unit/services/packs/packDocument.test.ts`
Expected: RED with the mutation, PASS after reverting. Paste both into the PR.

- [ ] **Step 7: Commit**

```bash
cd <worktree>
bun run type-check
git add src/modules/accounting/services/packs/packDocument.ts src/modules/accounting/services/reports/statementRows/packMappers.ts src/components/accounting/ManagementPandLRows.tsx tests/unit/services/packs/packDocument.test.ts
git commit -m "feat(packs): one PackDocument model behind screen, PDF and deck"
```

---
### Task 7: The printable pieces — print mode, chart wrapper, section view

Three small components the printed pack is assembled from. They are separate from the assembly (Task 8) because each has its own failure mode: print mode has to win the theme fight, the chart wrapper has to announce when it is actually drawn, and the section view has to render every block kind.

**Files:**
- Create: `src/components/accounting/packs/usePrintMode.ts`
- Create: `src/components/accounting/packs/PackChart.tsx`
- Create: `src/components/accounting/packs/PackSectionView.tsx`
- Test: `tests/unit/components/packs/PackSectionView.dom.test.tsx`

**Interfaces:**
- Consumes: `PackBlock`, `PackDocumentSection` from `packDocument`; `waterfallOption`, `trendOption` from `packChartOptions`; `StatementGrid` from `@/components/accounting/statement/StatementGrid`; `formatMoney`, `formatPct` from `@/lib/format/money`; `EChartClient` from `@/components/charts/EChartClient`.
- Produces:
  - `usePrintMode(enabled: boolean): void`
  - `usePrintReady(dataReady: boolean, expectedCharts: number): boolean`
  - `countCharts(sections: PackDocumentSection[]): number`
  - `<PackChart option={EChartsCoreOption} height?={number} />`
  - `<PackSectionView section={PackDocumentSection} />`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/components/packs/PackSectionView.dom.test.tsx
/**
 * Runs under vitest.components.config.ts (happy-dom): `bun run test:components`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { PackDocumentSection } from '@/modules/accounting/services/packs/packDocument';

// EChartClient is a next/dynamic(ssr:false) import of a canvas library; the
// wrapper's contract here is the container it renders, not ECharts itself.
vi.mock('@/components/charts/EChartClient', () => ({
  EChartClient: () => <div data-testid="echart" />,
}));

import { PackSectionView } from '@/components/accounting/packs/PackSectionView';
import { countCharts } from '@/components/accounting/packs/usePrintMode';

afterEach(cleanup);

const statementSection: PackDocumentSection = {
  type: 'income_statement',
  title: 'Statement of Comprehensive Income',
  landscape: false,
  blocks: [
    { kind: 'statement', rows: [
      { id: 'sub:revenue', kind: 'subtotal', label: 'Turnover', depth: 0, actual: 4812345.67 },
      { id: 'grand:netProfit', kind: 'grand', label: 'Net Profit / (Loss)', depth: 0, actual: 1275632.74 },
    ] },
    { kind: 'kv', items: [{ label: 'Gross Margin', value: 54.5, format: 'pct' }] },
  ],
};

const chartSection: PackDocumentSection = {
  type: 'waterfall',
  title: 'Profit Bridge',
  landscape: true,
  blocks: [{ kind: 'waterfall', steps: [
    { label: 'Revenue', start: 0, end: 1000, value: 1000, isSubtotal: false, color: 'green' },
  ] }],
};

describe('PackSectionView', () => {
  it('prints the section title', () => {
    render(<PackSectionView section={statementSection} />);
    expect(screen.getByText('Statement of Comprehensive Income')).toBeTruthy();
  });

  it('renders statement figures through the grid, formatted with cents', () => {
    render(<PackSectionView section={statementSection} />);
    expect(screen.getByText('4 812 345.67')).toBeTruthy();
    expect(screen.getByText('1 275 632.74')).toBeTruthy();
  });

  it('renders a percentage KV item as a percentage, not as money', () => {
    render(<PackSectionView section={statementSection} />);
    expect(screen.getByText('+54.5%')).toBeTruthy();
  });

  it('marks a chart section landscape and tags the chart container', () => {
    const { container } = render(<PackSectionView section={chartSection} />);
    expect(container.querySelector('[data-print-landscape]')).toBeTruthy();
    expect(container.querySelector('[data-pack-chart]')).toBeTruthy();
  });

  it('breaks the page before every section', () => {
    const { container } = render(<PackSectionView section={statementSection} />);
    expect(container.querySelector('[data-print-break]')).toBeTruthy();
  });
});

describe('countCharts', () => {
  it('counts the blocks that draw a chart and nothing else', () => {
    expect(countCharts([statementSection, chartSection])).toBe(1);
    expect(countCharts([statementSection])).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd <worktree> && bun run test:components tests/unit/components/packs/PackSectionView.dom.test.tsx`
Expected: FAIL, cannot find `@/components/accounting/packs/PackSectionView`.

- [ ] **Step 3: Implement `usePrintMode.ts`**

```ts
/**
 * Print-mode plumbing for the pack page.
 *
 * THE THEME FIGHT: ThemeContext defaults to dark and adds `.dark` to <html>
 * in a mount effect, so a child that simply removes the class is overwritten
 * a moment later — the PDF then prints white text on white paper. Writing the
 * stored preference in a LAYOUT effect wins instead: child layout effects run
 * before the provider's passive mount effect, so the provider reads 'light'
 * and takes the class off itself.
 *
 * THE READINESS GATE: the renderer waits for [data-print-ready="true"]
 * (src/lib/pdf/pdfTransport.ts). It is set only when the data has loaded AND
 * every chart has actually drawn an <svg>. There is deliberately no timeout
 * that gives up and prints anyway: a pack missing a chart is a document sent
 * to a client with a hole in it, and a hard render timeout is the loud,
 * diagnosable failure we want instead.
 */
import { useEffect, useLayoutEffect, useState } from 'react';
import type { PackDocumentSection } from '@/modules/accounting/services/packs/packDocument';

const THEME_STORAGE_KEY = 'accounting-theme';
const CHART_POLL_MS = 100;

export function usePrintMode(enabled: boolean): void {
  useLayoutEffect(() => {
    if (!enabled || typeof document === 'undefined') return;
    document.documentElement.classList.add('print-mode');
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    } catch {
      // A headless context with storage disabled still prints: print.css
      // forces a white ground and dark ink on html.print-mode regardless.
      document.documentElement.classList.remove('dark');
    }
  }, [enabled]);
}

/** Chart blocks across the whole document — what usePrintReady waits for. */
export function countCharts(sections: PackDocumentSection[]): number {
  return sections.reduce(
    (total, section) => total + section.blocks.filter((b) => b.kind === 'waterfall' || b.kind === 'trend').length,
    0,
  );
}

export function usePrintReady(dataReady: boolean, expectedCharts: number): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!dataReady) return;
    if (expectedCharts === 0) { setReady(true); return; }

    const check = () => document.querySelectorAll('[data-pack-chart] svg').length >= expectedCharts;
    if (check()) { setReady(true); return; }

    const timer = window.setInterval(() => {
      if (check()) {
        window.clearInterval(timer);
        setReady(true);
      }
    }, CHART_POLL_MS);
    return () => window.clearInterval(timer);
  }, [dataReady, expectedCharts]);

  return ready;
}
```

- [ ] **Step 4: Implement `PackChart.tsx`**

```tsx
/**
 * A pack chart. Always the SVG renderer: the readiness gate counts <svg>
 * elements, and an SVG in the PDF stays sharp at print resolution where a
 * canvas bitmap does not.
 */
import type { EChartsCoreOption } from 'echarts/core';
import { EChartClient } from '@/components/charts/EChartClient';

export interface PackChartProps {
  option: EChartsCoreOption;
  height?: number;
}

export function PackChart({ option, height = 320 }: PackChartProps) {
  return (
    <div data-pack-chart className="w-full">
      <EChartClient option={option} height={height} renderer="svg" />
    </div>
  );
}
```

- [ ] **Step 5: Implement `PackSectionView.tsx`**

```tsx
/**
 * One pack section, printed. Renders PackBlocks and nothing else — every
 * figure arrives already chosen by buildPackDocument.
 */
import { StatementGrid } from '@/components/accounting/statement/StatementGrid';
import { formatMoney, formatPct } from '@/lib/format/money';
import { waterfallOption, trendOption } from '@/modules/accounting/services/packs/packChartOptions';
import type { PackBlock, PackDocumentSection, PackKvItem } from '@/modules/accounting/services/packs/packDocument';
import { PackChart } from './PackChart';

const NO_COMPARATORS = { prior: false, budget: false, variance: false, trend: false } as const;

function kvText(item: PackKvItem): string {
  if (item.format === 'pct') return formatPct(item.value);
  if (item.format === 'ratio') return item.value.toFixed(2);
  return formatMoney(item.value, { cents: true });
}

function Block({ block }: { block: PackBlock }) {
  switch (block.kind) {
    case 'statement':
      return <StatementGrid rows={block.rows} columns={NO_COMPARATORS} cents />;

    case 'kv':
      return (
        <dl className="grid grid-cols-3 gap-3">
          {block.items.map((item) => (
            <div key={item.label}>
              <dt className="text-xs text-[var(--ff-text-tertiary)]">{item.label}</dt>
              <dd className="text-sm font-medium text-[var(--ff-text-primary)] tabular-nums">{kvText(item)}</dd>
            </div>
          ))}
        </dl>
      );

    case 'scorecard':
      return (
        <div className="grid grid-cols-3 gap-2">
          {block.items.map((item) => (
            <div key={item.name} className="rounded border border-[var(--ff-border-light)] p-2 text-xs">
              <span className="block text-[var(--ff-text-tertiary)]">{item.name}</span>
              <span className="font-bold tabular-nums text-[var(--ff-text-primary)]">{item.value.toFixed(2)}</span>
              <span className="ml-1 text-[var(--ff-text-tertiary)]">/ {item.target}</span>
            </div>
          ))}
        </div>
      );

    case 'waterfall':
      return <PackChart option={waterfallOption(block.steps)} />;

    case 'trend':
      // Revenue is the series a reader quotes off a twelve-month page; the
      // other two are on the statements a page earlier.
      return <PackChart option={trendOption(block.points.map((p) => ({ label: p.label, value: p.revenue })))} />;

    case 'text':
      return <p className="text-sm text-[var(--ff-text-secondary)]">{block.text}</p>;
  }
}

export function PackSectionView({ section }: { section: PackDocumentSection }) {
  return (
    <section
      data-print-break
      {...(section.landscape ? { 'data-print-landscape': '' } : {})}
      id={`pack-section-${section.type}`}
      className="space-y-4"
    >
      <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">{section.title}</h2>
      {section.blocks.map((block, i) => (
        <Block key={`${section.type}-${i}`} block={block} />
      ))}
    </section>
  );
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd <worktree> && bun run test:components tests/unit/components/packs/PackSectionView.dom.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd <worktree>
bun run type-check
git add src/components/accounting/packs/usePrintMode.ts src/components/accounting/packs/PackChart.tsx src/components/accounting/packs/PackSectionView.tsx tests/unit/components/packs/PackSectionView.dom.test.tsx
git commit -m "feat(packs): print mode, chart wrapper and section view"
```

---

### Task 8: The printed pack — cover, contents, page breaks

Assemble the pieces into the page the renderer photographs, and give `report-packs.tsx` its `?print=1` branch.

**Files:**
- Create: `src/components/accounting/packs/PackCover.tsx`
- Create: `src/components/accounting/packs/PackToc.tsx`
- Create: `src/components/accounting/packs/PackPrintView.tsx`
- Create: `src/components/accounting/packs/usePackPrintData.ts`
- Modify: `pages/accounting/reports/report-packs.tsx`
- Modify: `styles/print.css`
- Test: `tests/unit/components/packs/PackPrintView.dom.test.tsx`

**Interfaces:**
- Consumes: `PackDocument` and `buildPackDocument` from `packDocument`; `PACK_LABELS`, `PACK_DATA_API`, `packTrendApiPath` from `packSections`; `usePrintMode`, `usePrintReady`, `countCharts` from `usePrintMode`; `PackSectionView`; `apiJson` from `@/lib/apiFetch`.
- Produces:
  - `<PackCover document={PackDocument} />`
  - `<PackToc document={PackDocument} />`
  - `<PackPrintView document={PackDocument} />`
  - `usePackPrintData(packType: PackType, from: string, to: string): { document: PackDocument | null; error: string | null }`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/components/packs/PackPrintView.dom.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { PackDocument } from '@/modules/accounting/services/packs/packDocument';

vi.mock('@/components/charts/EChartClient', () => ({ EChartClient: () => <div data-testid="echart" /> }));

import { PackPrintView } from '@/components/accounting/packs/PackPrintView';

afterEach(cleanup);

const doc: PackDocument = {
  packType: 'management',
  companyName: 'ISAFlow Demo',
  period: '2026-01-01 to 2026-09-05',
  generatedAt: '2026-09-06T08:00:00.000Z',
  sections: [
    { type: 'income_statement', title: 'Statement of Comprehensive Income', landscape: false,
      blocks: [{ kind: 'statement', rows: [{ id: 'grand:netProfit', kind: 'grand', label: 'Net Profit / (Loss)', depth: 0, actual: 1275632.74 }] }] },
    { type: 'balance_sheet', title: 'Statement of Financial Position', landscape: false,
      blocks: [{ kind: 'text', text: 'nothing to see' }] },
  ],
};

describe('PackPrintView', () => {
  it('opens with a cover naming the company, the pack and the period', () => {
    render(<PackPrintView document={doc} />);
    expect(screen.getByText('ISAFlow Demo')).toBeTruthy();
    expect(screen.getByText('Management Pack')).toBeTruthy();
    expect(screen.getByText('2026-01-01 to 2026-09-05')).toBeTruthy();
  });

  it('lists every section in the table of contents, numbered and in order', () => {
    const { container } = render(<PackPrintView document={doc} />);
    const entries = [...container.querySelectorAll('[data-pack-toc] li')].map((li) => li.textContent);
    expect(entries).toEqual([
      '1. Statement of Comprehensive Income',
      '2. Statement of Financial Position',
    ]);
  });

  it('breaks the page after the cover and after the contents', () => {
    const { container } = render(<PackPrintView document={doc} />);
    expect(container.querySelector('[data-pack-cover]')).toBeTruthy();
    expect(container.querySelector('[data-pack-toc]')).toBeTruthy();
  });

  it('announces print-readiness once a chartless pack has rendered', async () => {
    const { container } = render(<PackPrintView document={doc} />);
    await waitFor(() => {
      expect(container.querySelector('[data-print-ready="true"]')).toBeTruthy();
    });
  });

  it('is NOT print-ready before its document arrives', () => {
    const { container } = render(<PackPrintView document={null} />);
    expect(container.querySelector('[data-print-ready="true"]')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd <worktree> && bun run test:components tests/unit/components/packs/PackPrintView.dom.test.tsx`
Expected: FAIL, cannot find `PackPrintView`.

- [ ] **Step 3: Implement the cover and the contents**

```tsx
// src/components/accounting/packs/PackCover.tsx
import { PACK_LABELS } from '@/modules/accounting/services/packs/packSections';
import type { PackDocument } from '@/modules/accounting/services/packs/packDocument';

export function PackCover({ document }: { document: PackDocument }) {
  const generated = document.generatedAt.slice(0, 10);
  return (
    <section data-pack-cover className="flex h-[240mm] flex-col justify-center gap-6 text-center">
      <p className="text-sm uppercase tracking-[0.3em] text-[var(--ff-text-tertiary)]">Prepared under IFRS for SMEs</p>
      <h1 className="text-4xl font-bold text-[var(--ff-text-primary)]">{document.companyName}</h1>
      <p className="text-2xl text-[var(--ff-text-secondary)]">{PACK_LABELS[document.packType]}</p>
      <p className="text-base text-[var(--ff-text-secondary)]">{document.period}</p>
      <p className="text-xs text-[var(--ff-text-tertiary)]">Generated {generated}</p>
    </section>
  );
}
```

```tsx
// src/components/accounting/packs/PackToc.tsx
import type { PackDocument } from '@/modules/accounting/services/packs/packDocument';

/**
 * Sections are numbered, not page-numbered: HTML cannot know which page a
 * section lands on, and a wrong page number in a table of contents is worse
 * than none. The printed page number is in the running footer, which the
 * renderer draws (FOOTER_HTML in src/lib/pdf/pdfTransport.ts).
 */
export function PackToc({ document }: { document: PackDocument }) {
  return (
    <section data-pack-toc className="space-y-4">
      <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Contents</h2>
      <ol className="space-y-1 text-sm text-[var(--ff-text-secondary)]">
        {document.sections.map((section, i) => (
          <li key={section.type}>{`${i + 1}. ${section.title}`}</li>
        ))}
      </ol>
    </section>
  );
}
```

- [ ] **Step 4: Implement `PackPrintView.tsx`**

```tsx
/**
 * The pack as the renderer photographs it: cover, contents, then one section
 * per page. `data-print-ready` on the root is the renderer's gate — see
 * usePrintMode.ts for why there is no timeout behind it.
 */
import { PackCover } from './PackCover';
import { PackToc } from './PackToc';
import { PackSectionView } from './PackSectionView';
import { countCharts, usePrintMode, usePrintReady } from './usePrintMode';
import type { PackDocument } from '@/modules/accounting/services/packs/packDocument';

export function PackPrintView({ document }: { document: PackDocument | null }) {
  usePrintMode(true);
  const ready = usePrintReady(document !== null, document ? countCharts(document.sections) : 0);

  return (
    <div
      data-print-ready={ready ? 'true' : 'false'}
      className="mx-auto max-w-[190mm] bg-white p-0 text-[var(--ff-text-primary)]"
    >
      {document && (
        <>
          <PackCover document={document} />
          <PackToc document={document} />
          {document.sections.map((section) => (
            <PackSectionView key={section.type} section={section} />
          ))}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Implement the data hook**

```ts
// src/components/accounting/packs/usePackPrintData.ts
/**
 * The printed pack's two fetches, in the order the renderer's token
 * authorises them (packPrintApiPaths). Uses apiJson so an envelope change is
 * a compile error rather than a document full of zeros.
 */
import { useEffect, useState } from 'react';
import { apiJson } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { buildPackDocument, type PackDocument } from '@/modules/accounting/services/packs/packDocument';
import { PACK_DATA_API, packTrendApiPath } from '@/modules/accounting/services/packs/packSections';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import type { PackType, ReportPack } from '@/modules/accounting/services/reports/reportPackService';

export function usePackPrintData(packType: PackType, from: string, to: string) {
  const [document, setDocument] = useState<PackDocument | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const packUrl = `${PACK_DATA_API}?type=${packType}&from=${from}&to=${to}`;
        const packPayload = (await apiJson(packUrl)) as { pack: ReportPack };
        const trend = await apiJson(`${packTrendApiPath(packType)}?to=${to}&months=12`);
        if (cancelled) return;
        setDocument(buildPackDocument(packPayload.pack, trend as PackTrendPoint[]));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('usePackPrintData: failed', { packType, from, to, error: message });
        if (!cancelled) setError(message);
      }
    })();
    return () => { cancelled = true; };
  }, [packType, from, to]);

  return { document, error };
}
```

`reports-pack` is not in the route registry and its handler returns three fields, so its payload is narrowed with one cast at the call site. Do not widen the registry for it: its GET returns `{ pack, period, unclassifiedAccounts }` and a shared-path registration would have to hold for every method on that path.

- [ ] **Step 6: Add the print branch to the page**

At the top of `pages/accounting/reports/report-packs.tsx`:

```tsx
import { useRouter } from 'next/router';
import { PackPrintView } from '@/components/accounting/packs/PackPrintView';
import { usePackPrintData } from '@/components/accounting/packs/usePackPrintData';
```

and inside `ReportPacksPage`, before every other hook-free branch (hooks must stay unconditional, so this is a separate component):

```tsx
function PackPrintPage({ packType, from, to }: { packType: PackType; from: string; to: string }) {
  const { document } = usePackPrintData(packType, from, to);
  return <PackPrintView document={document} />;
}

export default function ReportPacksPage() {
  const router = useRouter();
  const isPrint = router.query.print === '1';

  if (isPrint) {
    const packType = (String(router.query.pack ?? 'management')) as PackType;
    const from = String(router.query.from ?? '');
    const to = String(router.query.to ?? '');
    // No AppLayout in print mode: the chrome is hidden by print.css anyway,
    // and skipping it means the page fires no background /api calls at all —
    // which is what makes the Gotenberg transport (no request interception)
    // behave identically to the Playwright one.
    return <PackPrintPage packType={packType} from={from} to={to} />;
  }

  // ...existing interactive page unchanged...
}
```

Keep the file under 300 lines: it is 216 today and this adds roughly 20. If it goes over, move `SectionCard` and `KVItem` into `src/components/accounting/packs/PackSectionCard.tsx` rather than trimming the print branch.

- [ ] **Step 7: Add the print rules**

Append to `styles/print.css`:

```css
  /* Pack pagination. The cover and the contents each own a page; every
     section starts on a new one. */
  html.print-mode [data-pack-cover],
  html.print-mode [data-pack-toc] {
    break-after: page;
  }

  /* Sections whose content is a wide chart print sideways. Named pages need
     Chromium 111+; both transports ship a newer one (Playwright 1.58,
     Gotenberg 8). */
  @page landscape-page {
    size: A4 landscape;
  }

  html.print-mode [data-print-landscape] {
    page: landscape-page;
  }

  /* A chart split across a page boundary is unreadable. */
  html.print-mode svg,
  html.print-mode [data-pack-chart] {
    break-inside: avoid;
  }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd <worktree> && bun run test:components tests/unit/components/packs/`
Expected: PASS, both files.

- [ ] **Step 9: Prove the readiness gate bites**

Temporarily change `usePrintReady` to `return true` unconditionally and confirm "is NOT print-ready before its document arrives" goes RED. Revert.

Run: `cd <worktree> && bun run test:components tests/unit/components/packs/PackPrintView.dom.test.tsx`
Expected: RED with the mutation, PASS after reverting.

- [ ] **Step 10: Commit**

```bash
cd <worktree>
bun run type-check
git add src/components/accounting/packs/PackCover.tsx src/components/accounting/packs/PackToc.tsx src/components/accounting/packs/PackPrintView.tsx src/components/accounting/packs/usePackPrintData.ts pages/accounting/reports/report-packs.tsx styles/print.css tests/unit/components/packs/PackPrintView.dom.test.tsx
git commit -m "feat(packs): printable pack page with cover, contents and landscape charts"
```

---

### Task 9: The PDF download endpoint

**Files:**
- Create: `pages/api/accounting/packs/[id]/pdf.ts`
- Test: `tests/unit/api/packsDownloadRoutes.test.ts`

**Interfaces:**
- Consumes: `renderPagePdf` from `@/lib/pdf/renderPagePdf`; `packPrintApiPaths` from `packSections`.
- Produces: `GET /api/accounting/packs/[id]/pdf?from=YYYY-MM-DD&to=YYYY-MM-DD` streaming `application/pdf`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/api/packsDownloadRoutes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const renderPagePdfMock = vi.fn(async () => Buffer.from('%PDF-1.7 fake'));
vi.mock('@/lib/pdf/renderPagePdf', () => ({ renderPagePdf: (...a: unknown[]) => renderPagePdfMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: vi.fn(async () => true) }));

import pdfRoute from '../../../pages/api/accounting/packs/[id]/pdf';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

function mockRes() {
  const res = {
    statusCode: 0, headers: {} as Record<string, unknown>, body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
    end(p: unknown) { this.body = p; return this; },
    setHeader(k: string, v: unknown) { this.headers[k] = v; return this; },
  };
  return res as unknown as NextApiResponse & typeof res;
}

function req(query: Record<string, string>, method = 'GET') {
  return { method, query, url: '/api/accounting/packs/management/pdf', companyId: COMPANY, user: { id: USER } } as unknown as NextApiRequest;
}

describe('GET /api/accounting/packs/[id]/pdf', () => {
  beforeEach(() => renderPagePdfMock.mockClear());

  it('renders the pack page for the requested pack and period', async () => {
    const res = mockRes();
    await pdfRoute(req({ id: 'management', from: '2026-01-01', to: '2026-09-05' }), res);
    expect(renderPagePdfMock).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY,
      userId: USER,
      path: '/accounting/reports/report-packs',
      query: { pack: 'management', from: '2026-01-01', to: '2026-09-05' },
      apiPaths: ['/api/accounting/reports-pack', '/api/accounting/packs/management/trend'],
    }));
    expect(res.headers['Content-Type']).toBe('application/pdf');
    expect(res.statusCode).toBe(200);
  });

  it('names the download after the pack and the period', async () => {
    const res = mockRes();
    await pdfRoute(req({ id: 'board', from: '2026-01-01', to: '2026-09-05' }), res);
    expect(res.headers['Content-Disposition']).toContain('report-pack-board-2026-01-01-to-2026-09-05.pdf');
  });

  it('rejects an unknown pack id before rendering anything', async () => {
    const res = mockRes();
    await pdfRoute(req({ id: 'secret', from: '2026-01-01', to: '2026-09-05' }), res);
    expect(res.statusCode).toBe(400);
    expect(renderPagePdfMock).not.toHaveBeenCalled();
  });

  it('rejects a non-ISO date rather than passing it into a URL', async () => {
    const res = mockRes();
    await pdfRoute(req({ id: 'board', from: '01/01/2026', to: '2026-09-05' }), res);
    expect(res.statusCode).toBe(400);
    expect(renderPagePdfMock).not.toHaveBeenCalled();
  });

  it('refuses a POST', async () => {
    const res = mockRes();
    await pdfRoute(req({ id: 'board', from: '2026-01-01', to: '2026-09-05' }, 'POST'), res);
    expect(res.statusCode).toBe(405);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd <worktree> && bun run test:unit tests/unit/api/packsDownloadRoutes.test.ts`
Expected: FAIL, cannot find the route module.

- [ ] **Step 3: Implement the route**

```ts
// pages/api/accounting/packs/[id]/pdf.ts
/**
 * GET /api/accounting/packs/[id]/pdf?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Streams the pack as a PDF. The pack is not re-assembled here: the renderer
 * loads the same React page the user saw (?print=1) and photographs it, so a
 * figure can never differ between the screen and the document.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { checkReportRateLimit } from '@/lib/rateLimit';
import { renderPagePdf } from '@/lib/pdf/renderPagePdf';
import { packPrintApiPaths } from '@/modules/accounting/services/packs/packSections';
import type { PackType } from '@/modules/accounting/services/reports/reportPackService';

const VALID_TYPES: PackType[] = ['board', 'management', 'monthly'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PACK_PAGE = '/accounting/reports/report-packs';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId, user } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!VALID_TYPES.includes(id as PackType)) {
    return apiResponse.badRequest(res, `id must be one of: ${VALID_TYPES.join(', ')}`);
  }

  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  // Validated before they reach a URL the renderer navigates to.
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    return apiResponse.badRequest(res, 'from and to must be YYYY-MM-DD dates');
  }

  if (!(await checkReportRateLimit(companyId, 'packs-pdf'))) {
    log.warn('Pack PDF rate limit exceeded', { companyId }, 'rateLimit');
    return apiResponse.tooManyRequests(res, 'Too many report exports. Please try again shortly.');
  }

  const pdf = await renderPagePdf({
    companyId,
    userId: user.id,
    path: PACK_PAGE,
    query: { pack: id, from, to },
    apiPaths: packPrintApiPaths(id as PackType),
  });

  log.info('Pack PDF downloaded', { companyId, userId: user.id, packType: id, from, to, bytes: pdf.length }, 'packs');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="report-pack-${id}-${from}-to-${to}.pdf"`);
  res.setHeader('Content-Length', pdf.length);
  return res.status(200).end(pdf);
}

export default withAuth(withErrorHandler(handler as never));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd <worktree> && bun run test:unit tests/unit/api/packsDownloadRoutes.test.ts`
Expected: PASS.

- [ ] **Step 5: Point the page's download button at the new route**

In `pages/accounting/reports/report-packs.tsx`, replace the `downloadPdf` body's POST to `/api/accounting/reports-pdf` with a GET to the new route (the jsPDF route stays in place for now — removing it is a separate change with its own review):

```tsx
      const res = await apiFetch(`/api/accounting/packs/${selectedType}/pdf?from=${from}&to=${to}`);
      await assertOk(res, 'PDF generation failed');
      const blob = await res.blob();
```

and add `assertOk` to the existing `@/lib/apiFetch` import. `apiFetch` resolves on a 4xx, so the bare `if (!res.ok) throw` it replaces was the only thing standing between a 429 and a downloaded file named `.pdf` containing a JSON error.

- [ ] **Step 6: Commit**

```bash
cd <worktree>
bun run type-check
git add "pages/api/accounting/packs/[id]/pdf.ts" pages/accounting/reports/report-packs.tsx tests/unit/api/packsDownloadRoutes.test.ts
git commit -m "feat(packs): PDF download endpoint rendering the pack page"
```

---
### Task 10: PowerPoint export

Native slides with editable charts, from the same `PackDocument`. `pptxgenjs` is the one new dependency this workstream is allowed.

**Files:**
- Modify: `package.json` (add `pptxgenjs`, pinned exactly)
- Create: `src/modules/accounting/services/packs/packDeckModel.ts`
- Create: `src/modules/accounting/services/packs/pptxExportService.ts`
- Create: `pages/api/accounting/packs/[id]/pptx.ts`
- Test: `tests/unit/services/packs/packDeckModel.test.ts`
- Test: `tests/unit/services/packs/pptxExportService.test.ts`
- Test: `tests/unit/api/packsDownloadRoutes.test.ts` (append the PPTX cases)

**Interfaces:**
- Consumes: `PackDocument`, `PackBlock` from `packDocument`; `formatMoney`, `formatPct` from `@/lib/format/money`; `NON_FIGURE_KINDS` from `statementRows/statementModel`; `PACK_LABELS` from `packSections`; `getReportPackInput` from `reports/reportPackDataService`; `buildReportPack` from `reports/reportPackService`; `getPackTrend` from `packTrendService`.
- Produces:
  - `interface DeckTitleSlide { kind: 'title'; title: string; subtitle: string; footnote: string }`
  - `interface DeckTableRow { label: string; value: string; emphasis: boolean }`
  - `interface DeckTableSlide { kind: 'table'; title: string; rows: DeckTableRow[] }`
  - `interface DeckChartSlide { kind: 'chart'; title: string; categories: string[]; series: Array<{ name: string; values: number[] }> }`
  - `interface DeckTextSlide { kind: 'text'; title: string; body: string }`
  - `type DeckSlide = DeckTitleSlide | DeckTableSlide | DeckChartSlide | DeckTextSlide`
  - `buildPackDeck(document: PackDocument): DeckSlide[]`
  - `renderPackPptx(slides: DeckSlide[]): Promise<Buffer>`
  - `GET /api/accounting/packs/[id]/pptx?from=&to=`

- [ ] **Step 1: Install and pin the dependency**

```bash
cd <worktree>
bun add pptxgenjs
grep '"pptxgenjs"' package.json                     # note the resolved version
grep -n "addChart\|nodebuffer" node_modules/pptxgenjs/types/index.d.ts | head
```

Edit `package.json` so the entry is the exact resolved version with no caret (e.g. `"pptxgenjs": "3.12.0"`). Before writing code against it, confirm from the types printed above that the installed version exposes `addChart`, `addTable`, and `write({ outputType: 'nodebuffer' })`. If the resolved major is newer than 3 and those names differ, fetch the current docs with the `context7` MCP and adjust the calls in Step 5 — the model in Step 3 does not change either way.

- [ ] **Step 2: Write the failing tests**

```ts
// tests/unit/services/packs/packDeckModel.test.ts
import { describe, it, expect } from 'vitest';
import { buildPackDeck } from '@/modules/accounting/services/packs/packDeckModel';
import type { PackDocument } from '@/modules/accounting/services/packs/packDocument';

const doc: PackDocument = {
  packType: 'management',
  companyName: 'ISAFlow Demo',
  period: '2026-01-01 to 2026-09-05',
  generatedAt: '2026-09-06T08:00:00.000Z',
  sections: [
    { type: 'income_statement', title: 'Statement of Comprehensive Income', landscape: false, blocks: [
      { kind: 'statement', rows: [
        { id: 'sec:revenue', kind: 'section', label: 'Revenue', depth: 0, actual: 4812345.67 },
        { id: 'sub:revenue', kind: 'subtotal', label: 'Turnover', depth: 0, actual: 4812345.67 },
        { id: 'grand:netProfit', kind: 'grand', label: 'Net Profit / (Loss)', depth: 0, actual: 1275632.74 },
      ] },
      { kind: 'kv', items: [{ label: 'Gross Margin', value: 54.5, format: 'pct' }] },
    ] },
    { type: 'waterfall', title: 'Profit Bridge', landscape: true, blocks: [
      { kind: 'waterfall', steps: [
        { label: 'Revenue', start: 0, end: 4812345.67, value: 4812345.67, isSubtotal: false, color: 'green' },
        { label: 'Cost of Sales', start: 4812345.67, end: 2622345.67, value: -2190000, isSubtotal: false, color: 'red' },
      ] },
    ] },
  ],
};

describe('buildPackDeck', () => {
  it('opens with a title slide naming the company, the pack and the period', () => {
    const [first] = buildPackDeck(doc);
    expect(first).toEqual({
      kind: 'title', title: 'ISAFlow Demo', subtitle: 'Management Pack', footnote: '2026-01-01 to 2026-09-05',
    });
  });

  it('turns a statement into a table of formatted figures', () => {
    const slides = buildPackDeck(doc);
    const table = slides.find((s) => s.kind === 'table') as { title: string; rows: Array<{ label: string; value: string; emphasis: boolean }> };
    expect(table.title).toBe('Statement of Comprehensive Income');
    expect(table.rows.map((r) => r.label)).toContain('Turnover');
    expect(table.rows.find((r) => r.label === 'Net Profit / (Loss)')!.emphasis).toBe(true);
  });

  it('formats table figures with formatMoney, cents included', () => {
    const slides = buildPackDeck(doc);
    const table = slides.find((s) => s.kind === 'table') as { rows: Array<{ label: string; value: string }> };
    // The exact separator is whatever Intl en-ZA produces; the contract is
    // that the value is formatted, not raw, and carries two decimals.
    const netProfit = table.rows.find((r) => r.label === 'Net Profit / (Loss)')!.value;
    expect(netProfit).toMatch(/^1\D?275\D?632\.74$/);
  });

  it('drops band-header rows, which carry a figure the subtotal already prints', () => {
    const slides = buildPackDeck(doc);
    const table = slides.find((s) => s.kind === 'table') as { rows: Array<{ label: string }> };
    expect(table.rows.map((r) => r.label)).not.toContain('Revenue');
  });

  it('gives PowerPoint the RAW numbers so the chart stays editable', () => {
    const slides = buildPackDeck(doc);
    const chart = slides.find((s) => s.kind === 'chart') as { categories: string[]; series: Array<{ values: number[] }> };
    expect(chart.categories).toEqual(['Revenue', 'Cost of Sales']);
    expect(chart.series[0]!.values).toEqual([4812345.67, -2190000]);
  });

  it('formats a percentage as a percentage', () => {
    const slides = buildPackDeck(doc);
    const rows = slides.flatMap((s) => (s.kind === 'table' ? s.rows : []));
    expect(rows.find((r) => r.label === 'Gross Margin')!.value).toBe('+54.5%');
  });
});
```

```ts
// tests/unit/services/packs/pptxExportService.test.ts
import { describe, it, expect } from 'vitest';
import { renderPackPptx } from '@/modules/accounting/services/packs/pptxExportService';
import type { DeckSlide } from '@/modules/accounting/services/packs/packDeckModel';

const slides: DeckSlide[] = [
  { kind: 'title', title: 'ISAFlow Demo', subtitle: 'Management Pack', footnote: '2026-01-01 to 2026-09-05' },
  { kind: 'table', title: 'Statement of Comprehensive Income', rows: [
    { label: 'Turnover', value: '4 812 345.67', emphasis: false },
    { label: 'Net Profit / (Loss)', value: '1 275 632.74', emphasis: true },
  ] },
  { kind: 'chart', title: 'Profit Bridge', categories: ['Revenue', 'Cost of Sales'], series: [{ name: 'Movement', values: [4812345.67, -2190000] }] },
  { kind: 'text', title: 'Commentary', body: 'Revenue grew.' },
];

describe('renderPackPptx', () => {
  it('produces a real OOXML package', async () => {
    const buffer = await renderPackPptx(slides);
    // .pptx is a zip: every one starts with the local file header magic.
    expect(buffer.subarray(0, 2).toString('binary')).toBe('PK');
    expect(buffer.length).toBeGreaterThan(5000);
  });

  it('renders a deck with no slides rather than throwing', async () => {
    const buffer = await renderPackPptx([]);
    expect(buffer.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd <worktree> && bun run test:unit tests/unit/services/packs/packDeckModel.test.ts tests/unit/services/packs/pptxExportService.test.ts`
Expected: FAIL, cannot find either module.

- [ ] **Step 4: Implement `packDeckModel.ts`**

```ts
/**
 * PackDocument to slides. Pure, so what lands in PowerPoint is assertable
 * without opening PowerPoint.
 *
 * Tables carry FORMATTED strings (the deck is read, not recalculated);
 * charts carry RAW numbers, because a native PowerPoint chart the reader can
 * edit is the whole point of exporting to pptx rather than pasting an image.
 */
import { formatMoney, formatPct } from '@/lib/format/money';
import { NON_FIGURE_KINDS } from '@/modules/accounting/services/reports/statementRows/statementModel';
import type { PackBlock, PackDocument, PackKvItem } from './packDocument';
import { PACK_LABELS } from './packSections';

export interface DeckTitleSlide { kind: 'title'; title: string; subtitle: string; footnote: string }
export interface DeckTableRow { label: string; value: string; emphasis: boolean }
export interface DeckTableSlide { kind: 'table'; title: string; rows: DeckTableRow[] }
export interface DeckChartSlide { kind: 'chart'; title: string; categories: string[]; series: Array<{ name: string; values: number[] }> }
export interface DeckTextSlide { kind: 'text'; title: string; body: string }
export type DeckSlide = DeckTitleSlide | DeckTableSlide | DeckChartSlide | DeckTextSlide;

const EMPHASIS_KINDS = new Set(['total', 'grand']);

function kvValue(item: PackKvItem): string {
  if (item.format === 'pct') return formatPct(item.value);
  if (item.format === 'ratio') return item.value.toFixed(2);
  return formatMoney(item.value, { cents: true });
}

function slidesForBlock(title: string, block: PackBlock): DeckSlide[] {
  switch (block.kind) {
    case 'statement':
      return [{
        kind: 'table',
        title,
        // A `section` row carries the band total that its own subtotal row
        // prints; keeping both would show every band twice.
        rows: block.rows
          .filter((row) => !NON_FIGURE_KINDS.has(row.kind))
          .map((row) => ({
            label: row.label,
            value: formatMoney(row.actual, { cents: true }),
            emphasis: EMPHASIS_KINDS.has(row.kind),
          })),
      }];

    case 'kv':
      return [{ kind: 'table', title, rows: block.items.map((item) => ({ label: item.label, value: kvValue(item), emphasis: false })) }];

    case 'scorecard':
      return [{
        kind: 'table', title,
        rows: block.items.map((item) => ({ label: item.name, value: `${item.value.toFixed(2)} / ${item.target}`, emphasis: false })),
      }];

    case 'waterfall':
      return [{
        kind: 'chart', title,
        categories: block.steps.map((s) => s.label),
        series: [{ name: 'Movement', values: block.steps.map((s) => s.value) }],
      }];

    case 'trend':
      return [{
        kind: 'chart', title,
        categories: block.points.map((p) => p.label),
        series: [{ name: 'Revenue', values: block.points.map((p) => p.revenue) }],
      }];

    case 'text':
      return [{ kind: 'text', title, body: block.text }];
  }
}

export function buildPackDeck(document: PackDocument): DeckSlide[] {
  const title: DeckTitleSlide = {
    kind: 'title',
    title: document.companyName,
    subtitle: PACK_LABELS[document.packType],
    footnote: document.period,
  };
  const body = document.sections.flatMap((section) =>
    section.blocks.flatMap((block) => slidesForBlock(section.title, block)),
  );
  return [title, ...body];
}
```

- [ ] **Step 5: Implement `pptxExportService.ts`**

```ts
/**
 * Slides to .pptx bytes.
 *
 * Charts are added with `addChart`, not as pictures: a native chart carries
 * its own data sheet, so the reader can retitle an axis or change a colour
 * without coming back to ask for a new pack.
 */
import PptxGenJS from 'pptxgenjs';
import { log } from '@/lib/logger';
import type { DeckSlide } from './packDeckModel';

const INK = '15202B';
const MUTED = '6B7280';
const ACCENT = '0D9488';

function addTitleSlide(pptx: PptxGenJS, slide: Extract<DeckSlide, { kind: 'title' }>): void {
  const s = pptx.addSlide();
  s.addText(slide.title, { x: 0.6, y: 2.1, w: 8.8, h: 0.9, fontSize: 36, bold: true, color: INK });
  s.addText(slide.subtitle, { x: 0.6, y: 3.0, w: 8.8, h: 0.6, fontSize: 22, color: ACCENT });
  s.addText(slide.footnote, { x: 0.6, y: 3.7, w: 8.8, h: 0.4, fontSize: 14, color: MUTED });
}

function addTableSlide(pptx: PptxGenJS, slide: Extract<DeckSlide, { kind: 'table' }>): void {
  const s = pptx.addSlide();
  s.addText(slide.title, { x: 0.5, y: 0.4, w: 9, h: 0.5, fontSize: 20, bold: true, color: INK });
  s.addTable(
    slide.rows.map((row) => [
      { text: row.label, options: { bold: row.emphasis, color: INK } },
      { text: row.value, options: { bold: row.emphasis, color: INK, align: 'right' as const } },
    ]),
    { x: 0.5, y: 1.1, w: 9, colW: [6, 3], fontSize: 12, border: { type: 'solid', pt: 0.5, color: 'E5E7EB' } },
  );
}

function addChartSlide(pptx: PptxGenJS, slide: Extract<DeckSlide, { kind: 'chart' }>): void {
  const s = pptx.addSlide();
  s.addText(slide.title, { x: 0.5, y: 0.4, w: 9, h: 0.5, fontSize: 20, bold: true, color: INK });
  s.addChart(
    pptx.ChartType.bar,
    slide.series.map((series) => ({ name: series.name, labels: slide.categories, values: series.values })),
    { x: 0.5, y: 1.1, w: 9, h: 4.4, showLegend: false, chartColors: [ACCENT], catAxisLabelRotate: 30 },
  );
}

function addTextSlide(pptx: PptxGenJS, slide: Extract<DeckSlide, { kind: 'text' }>): void {
  const s = pptx.addSlide();
  s.addText(slide.title, { x: 0.5, y: 0.4, w: 9, h: 0.5, fontSize: 20, bold: true, color: INK });
  s.addText(slide.body, { x: 0.5, y: 1.1, w: 9, h: 4, fontSize: 14, color: INK });
}

export async function renderPackPptx(slides: DeckSlide[]): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';

  for (const slide of slides) {
    if (slide.kind === 'title') addTitleSlide(pptx, slide);
    else if (slide.kind === 'table') addTableSlide(pptx, slide);
    else if (slide.kind === 'chart') addChartSlide(pptx, slide);
    else addTextSlide(pptx, slide);
  }

  const output = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  log.info('renderPackPptx: rendered', { slides: slides.length, bytes: output.length }, 'packs');
  return output;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd <worktree> && bun run test:unit tests/unit/services/packs/packDeckModel.test.ts tests/unit/services/packs/pptxExportService.test.ts`
Expected: PASS.

- [ ] **Step 7: Add the PPTX route**

```ts
// pages/api/accounting/packs/[id]/pptx.ts
/**
 * GET /api/accounting/packs/[id]/pptx?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Streams the pack as a PowerPoint deck. Unlike the PDF route (which
 * photographs the page), this assembles the pack in-process through the SAME
 * pack service and the SAME PackDocument the page renders, so the two
 * downloads cannot disagree on a figure.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { checkReportRateLimit } from '@/lib/rateLimit';
import { buildReportPack, type PackType } from '@/modules/accounting/services/reports/reportPackService';
import { getReportPackInput } from '@/modules/accounting/services/reports/reportPackDataService';
import { buildPackDocument } from '@/modules/accounting/services/packs/packDocument';
import { buildPackDeck } from '@/modules/accounting/services/packs/packDeckModel';
import { renderPackPptx } from '@/modules/accounting/services/packs/pptxExportService';
import { getPackTrend } from '@/modules/accounting/services/packs/packTrendService';

const VALID_TYPES: PackType[] = ['board', 'management', 'monthly'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

type Row = Record<string, unknown>;

async function companyName(companyId: string): Promise<string> {
  const rows = (await sql`SELECT name FROM companies WHERE id = ${companyId}::UUID LIMIT 1`) as Row[];
  return String(rows[0]?.name ?? 'Company');
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId, user } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!VALID_TYPES.includes(id as PackType)) {
    return apiResponse.badRequest(res, `id must be one of: ${VALID_TYPES.join(', ')}`);
  }

  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    return apiResponse.badRequest(res, 'from and to must be YYYY-MM-DD dates');
  }

  if (!(await checkReportRateLimit(companyId, 'packs-pptx'))) {
    log.warn('Pack PPTX rate limit exceeded', { companyId }, 'rateLimit');
    return apiResponse.tooManyRequests(res, 'Too many report exports. Please try again shortly.');
  }

  const name = await companyName(companyId);
  const [input, trend] = await Promise.all([
    getReportPackInput(companyId, name, from, to),
    getPackTrend(companyId, to, 12),
  ]);

  const deck = buildPackDeck(buildPackDocument(buildReportPack(id as PackType, input, from, to), trend));
  const pptx = await renderPackPptx(deck);

  log.info('Pack PPTX downloaded', { companyId, userId: user.id, packType: id, from, to, bytes: pptx.length }, 'packs');

  res.setHeader('Content-Type', PPTX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="report-pack-${id}-${from}-to-${to}.pptx"`);
  res.setHeader('Content-Length', pptx.length);
  return res.status(200).end(pptx);
}

export default withAuth(withErrorHandler(handler as never));
```

- [ ] **Step 8: Add the route's tests**

Append to `tests/unit/api/packsDownloadRoutes.test.ts`. Add these mocks at the top of the file alongside the existing ones:

```ts
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => [{ name: 'ISAFlow Demo' }]) }));
vi.mock('@/modules/accounting/services/reports/reportPackDataService', () => ({
  getReportPackInput: vi.fn(async () => ({
    companyName: 'ISAFlow Demo', period: 'p', revenue: 1000, costOfSales: 400, operatingExpenses: 200,
    netProfit: 400, totalAssets: 5000, totalLiabilities: 2000, totalEquity: 3000, currentAssets: 2500,
    currentLiabilities: 1000, cash: 800, accountsReceivable: 900, accountsPayable: 500, inventory: 100,
    otherIncome: 0, otherExpenses: 0, operatingProfit: 400, inventoryCaveat: null, classificationCaveat: null,
  })),
}));
vi.mock('@/modules/accounting/services/packs/packTrendService', () => ({ getPackTrend: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/packs/pptxExportService', () => ({ renderPackPptx: vi.fn(async () => Buffer.from('PKpptx')) }));
```

and the cases:

```ts
import pptxRoute from '../../../pages/api/accounting/packs/[id]/pptx';

describe('GET /api/accounting/packs/[id]/pptx', () => {
  it('streams a pptx named after the pack and the period', async () => {
    const res = mockRes();
    await pptxRoute(req({ id: 'management', from: '2026-01-01', to: '2026-09-05' }), res);
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['Content-Type'])).toContain('presentationml.presentation');
    expect(String(res.headers['Content-Disposition'])).toContain('report-pack-management-2026-01-01-to-2026-09-05.pptx');
  });

  it('rejects an unknown pack id', async () => {
    const res = mockRes();
    await pptxRoute(req({ id: 'secret', from: '2026-01-01', to: '2026-09-05' }), res);
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 9: Add the button**

In `pages/accounting/reports/report-packs.tsx`, beside the existing PDF button, add a PowerPoint button that GETs `/api/accounting/packs/${selectedType}/pptx?from=${from}&to=${to}`, guards the response with `assertOk`, and downloads the blob as `.pptx`. Extract the shared "fetch a blob and click a link" logic into one local `downloadFile(url, filename)` helper rather than copying the eight lines.

- [ ] **Step 10: Run everything and commit**

```bash
cd <worktree>
bun run type-check
bun run test:unit tests/unit/services/packs/ tests/unit/api/packsDownloadRoutes.test.ts
git add package.json bun.lock src/modules/accounting/services/packs/packDeckModel.ts src/modules/accounting/services/packs/pptxExportService.ts "pages/api/accounting/packs/[id]/pptx.ts" pages/accounting/reports/report-packs.tsx tests/unit/services/packs/packDeckModel.test.ts tests/unit/services/packs/pptxExportService.test.ts tests/unit/api/packsDownloadRoutes.test.ts
git commit -m "feat(packs): PowerPoint export with native editable charts"
```

---

### Task 11: AFS statement pages get a server-rendered ECharts SVG

The statutory AFS PDF stays on WeasyPrint — it is the PDF/A path and nothing here changes that. WeasyPrint runs no JavaScript, so a chart has to arrive as SVG markup. Build the seam (a chart builder per section type, one map) and implement the first chart.

**Files:**
- Create: `src/modules/accounting/services/packs/serverChartSvg.ts`
- Modify: `src/modules/accounting/services/afs/pdfExportService.ts` (the `renderAfsToHtml` call only)
- Modify: `src/modules/accounting/services/afs/afsHtmlRendererService.ts` and `afsHtmlTableRenderer.ts` — **requires the lead's grant, see "Requests to other owners"**
- Modify: `src/modules/accounting/services/afs/noteGenerators/primaryStatements/incomeStatement.ts` — export `isRevenueLine` (one word), same grant
- Test: `tests/unit/services/packs/serverChartSvg.test.ts`

**Interfaces:**
- Consumes: `SectionLine`, `flipSign` from `afs/noteGenerators/primaryStatements/_helpers`; `isRevenueLine` from the same directory's `incomeStatement`; `AfsSection`, `SectionType` from `afs/afsTypes`; `ChartPalette`, `DEFAULT_CHART_PALETTE` from `packChartOptions`.
- Produces:
  - `renderOptionToSvg(option: EChartsCoreOption, size?: { width: number; height: number }): string`
  - `afsIncomeChartOption(lines: SectionLine[], palette?: ChartPalette): EChartsCoreOption`
  - `buildAfsCharts(sections: AfsSection[]): Partial<Record<SectionType, string>>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/packs/serverChartSvg.test.ts
import { describe, it, expect } from 'vitest';
import { renderOptionToSvg, afsIncomeChartOption, buildAfsCharts } from '@/modules/accounting/services/packs/serverChartSvg';
import type { SectionLine } from '@/modules/accounting/services/afs/noteGenerators/primaryStatements/_helpers';
import type { AfsSection } from '@/modules/accounting/services/afs/afsTypes';

const line = (over: Partial<SectionLine>): SectionLine => ({
  code: 'IS001', label: 'Revenue', parentCode: null, noteNumber: null, sortOrder: 1,
  isHeader: false, isTotal: true, currentAmount: -1000, priorAmount: -800,
  totalBasis: 'running', totalComponents: null, ...over,
});

describe('renderOptionToSvg', () => {
  it('renders an SVG string in Node, with no DOM', () => {
    const svg = renderOptionToSvg({ xAxis: { type: 'category', data: ['a'] }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: [1] }] });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('</svg>');
  });
});

describe('afsIncomeChartOption', () => {
  const lines = [
    line({ code: 'IS001', label: 'Revenue', currentAmount: -1000, priorAmount: -800 }),
    line({ code: 'IS900', label: 'Operating Expenses', currentAmount: 400, priorAmount: 350 }),
    line({ code: 'IS002', label: 'Detail line', isTotal: false }),
  ];

  it('charts the statement totals only', () => {
    const opt = afsIncomeChartOption(lines) as { xAxis: { data: string[] } };
    expect(opt.xAxis.data).toEqual(['Revenue', 'Operating Expenses']);
  });

  it('applies the SAME sign flip the statement applies, so revenue reads positive', () => {
    const opt = afsIncomeChartOption(lines) as unknown as { series: Array<{ name: string; data: number[] }> };
    expect(opt.series[0]!.name).toBe('Current');
    expect(opt.series[0]!.data).toEqual([1000, 400]);
    expect(opt.series[1]!.data).toEqual([800, 350]);
  });

  it('cannot be broken out of by an account name', () => {
    const nasty = afsIncomeChartOption([line({ label: 'Revenue</svg><script>alert(1)</script>' })]);
    const svg = renderOptionToSvg(nasty);
    expect(svg).not.toContain('<script');
    expect(svg.match(/<\/svg>/g)!.length).toBe(1);
  });
});

describe('buildAfsCharts', () => {
  it('returns a chart for the income statement section and nothing for the others', () => {
    const sections = [
      { sectionType: 'income_statement', dataSnapshot: { lines: [line({})] } },
      { sectionType: 'note_4', dataSnapshot: { lines: [line({})] } },
    ] as unknown as AfsSection[];
    const charts = buildAfsCharts(sections);
    expect(charts.income_statement?.startsWith('<svg')).toBe(true);
    expect(charts.note_4).toBeUndefined();
  });

  it('skips a section whose snapshot has no lines rather than drawing an empty box', () => {
    const sections = [{ sectionType: 'income_statement', dataSnapshot: null }] as unknown as AfsSection[];
    expect(buildAfsCharts(sections).income_statement).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd <worktree> && bun run test:unit tests/unit/services/packs/serverChartSvg.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement `serverChartSvg.ts`**

```ts
/**
 * Server-rendered ECharts SVG, for PDFs produced by a renderer that runs no
 * JavaScript — the statutory AFS path through WeasyPrint.
 *
 * Its own module registry, deliberately: src/lib/charts/echarts.ts registers
 * the canvas renderer and is documented as client-only. Here only the SVG
 * renderer and the chart types a statement needs are registered, so this file
 * is safe to import in a Node request handler.
 *
 * It lives under services/packs/ rather than services/afs/ or src/lib/charts/
 * because those directories belong to other owners; the module is generic and
 * moves the day the AFS module wants it.
 */
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, LegendComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';
import { log } from '@/lib/logger';
import type { AfsSection, SectionType } from '@/modules/accounting/services/afs/afsTypes';
import { flipSign, type SectionLine } from '@/modules/accounting/services/afs/noteGenerators/primaryStatements/_helpers';
import { isRevenueLine } from '@/modules/accounting/services/afs/noteGenerators/primaryStatements/incomeStatement';
import { DEFAULT_CHART_PALETTE, type ChartPalette } from './packChartOptions';

echarts.use([BarChart, GridComponent, LegendComponent, SVGRenderer]);

const DEFAULT_SIZE = { width: 680, height: 300 };
/** Statement totals are few; more than this on one chart is unreadable. */
const MAX_BARS = 6;

/**
 * Account labels come from the database and end up inside SVG text. Angle
 * brackets are removed rather than entity-escaped: escaping would double up
 * if ECharts escapes as well, and no legitimate account name contains one.
 */
function sanitizeLabel(label: string): string {
  return label.replace(/[<>]/g, '').trim();
}

export function renderOptionToSvg(option: EChartsCoreOption, size = DEFAULT_SIZE): string {
  const chart = echarts.init(null, undefined, { renderer: 'svg', ssr: true, width: size.width, height: size.height });
  try {
    chart.setOption(option);
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}

export function afsIncomeChartOption(lines: SectionLine[], palette: ChartPalette = DEFAULT_CHART_PALETTE): EChartsCoreOption {
  // The SAME flip the statement applies (incomeStatement.ts), imported rather
  // than restated: a second copy of that rule is a chart that contradicts the
  // table three centimetres above it.
  const totals = lines
    .filter((l) => l.isTotal)
    .slice(0, MAX_BARS)
    .map((l) => (isRevenueLine(l) ? flipSign(l) : l));

  return {
    animation: false,
    grid: { left: 90, right: 20, top: 30, bottom: 70 },
    legend: { data: ['Current', 'Prior'], bottom: 0 },
    xAxis: {
      type: 'category',
      data: totals.map((l) => sanitizeLabel(l.label)),
      axisLabel: { color: palette.axis, interval: 0, rotate: 25 },
    },
    yAxis: { type: 'value', axisLabel: { color: palette.axis } },
    series: [
      { name: 'Current', type: 'bar', itemStyle: { color: palette.ink }, data: totals.map((l) => l.currentAmount) },
      { name: 'Prior', type: 'bar', itemStyle: { color: palette.prior }, data: totals.map((l) => l.priorAmount) },
    ],
  };
}

/** The seam: one entry per section type that benefits from a visual. */
const CHART_BUILDERS: Partial<Record<SectionType, (snapshot: Record<string, unknown>) => EChartsCoreOption | null>> = {
  income_statement: (snapshot) => {
    const lines = snapshot.lines;
    if (!Array.isArray(lines) || lines.length === 0) return null;
    return afsIncomeChartOption(lines as SectionLine[]);
  },
};

export function buildAfsCharts(sections: AfsSection[]): Partial<Record<SectionType, string>> {
  const charts: Partial<Record<SectionType, string>> = {};
  for (const section of sections) {
    const builder = CHART_BUILDERS[section.sectionType];
    if (!builder || !section.dataSnapshot) continue;
    const option = builder(section.dataSnapshot);
    if (!option) continue;
    charts[section.sectionType] = renderOptionToSvg(option);
  }
  log.info('buildAfsCharts', { rendered: Object.keys(charts).length }, 'afs');
  return charts;
}
```

`flipSign` returns a `SectionLine` with both amounts negated; confirm that before relying on it, and if it negates only `currentAmount`, negate `priorAmount` in the map above rather than changing the shared helper.

- [ ] **Step 4: Export the flip rule (grant required)**

In `src/modules/accounting/services/afs/noteGenerators/primaryStatements/incomeStatement.ts`, change `function isRevenueLine` to `export function isRevenueLine`. Nothing else in that file changes.

- [ ] **Step 5: Let the AFS renderer place a chart (grant required)**

In `src/modules/accounting/services/afs/afsHtmlTableRenderer.ts`:

```diff
-export function renderSectionContent(section: AfsSection): string {
+export function renderSectionContent(section: AfsSection, chartSvg?: string): string {
   const noteContent = resolveContent(section);
   if (!noteContent) return '';
 
   const blocks = noteContent.blocks.map(renderBlock).join('\n');
+  // Charts are generated by us from the section's own snapshot
+  // (serverChartSvg.ts), never from user-supplied markup.
+  const chart = chartSvg ? `<div class="section-chart">${chartSvg}</div>` : '';
 
   return `<section class="section-start" id="section-${escapeHtml(section.id)}">
 <h2>${escapeHtml(noteContent.title)}</h2>
 ${blocks}
+${chart}
 </section>`;
 }
```

In `src/modules/accounting/services/afs/afsHtmlRendererService.ts`, add one optional field to `AfsRenderContext`:

```diff
   coverPhotoUrl?: string;
   entityType?: 'pty' | 'cc' | 'trust';
+  /** Server-rendered SVG per section type — see serverChartSvg.buildAfsCharts. */
+  charts?: Partial<Record<AfsSection['sectionType'], string>>;
 }
```

and pass it through:

```diff
-  const sectionsHtml = sections.map(renderSectionContent).join('\n');
+  const sectionsHtml = sections
+    .map((s) => renderSectionContent(s, context.charts?.[s.sectionType]))
+    .join('\n');
```

plus one rule in `buildCss`: `.section-chart { margin: 1.2em 0; break-inside: avoid; }`.

- [ ] **Step 6: Wire the seam into the AFS export**

In `src/modules/accounting/services/afs/pdfExportService.ts`, step 6, the only change:

```diff
+  // Charts for the statement pages. Additive: a section with no builder
+  // registered renders exactly as it does today.
+  const charts = buildAfsCharts(sections);
+
   const html = renderAfsToHtml(
-    { document, sections, brandProfile: safeBrandProfile, companyName, registrationNumber },
+    { document, sections, brandProfile: safeBrandProfile, companyName, registrationNumber, charts },
     { watermark: options?.watermark },
   );
```

with `import { buildAfsCharts } from '@/modules/accounting/services/packs/serverChartSvg';` at the top.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd <worktree> && bun run test:unit tests/unit/services/packs/serverChartSvg.test.ts && bun run test:unit tests/unit/services/afs/`
Expected: PASS, and every existing AFS renderer test still passes — the seam changes nothing for a section with no builder registered.

- [ ] **Step 8: Prove the sign flip is shared, not copied**

Temporarily delete the `isRevenueLine(l) ? flipSign(l) : l` map in `afsIncomeChartOption` and confirm "applies the SAME sign flip" goes RED with revenue at -1000. Revert.

Run: `cd <worktree> && bun run test:unit tests/unit/services/packs/serverChartSvg.test.ts`
Expected: RED with the mutation, PASS after reverting.

- [ ] **Step 9: Commit**

```bash
cd <worktree>
bun run type-check
git add src/modules/accounting/services/packs/serverChartSvg.ts src/modules/accounting/services/afs/pdfExportService.ts src/modules/accounting/services/afs/afsHtmlRendererService.ts src/modules/accounting/services/afs/afsHtmlTableRenderer.ts src/modules/accounting/services/afs/noteGenerators/primaryStatements/incomeStatement.ts tests/unit/services/packs/serverChartSvg.test.ts
git commit -m "feat(afs): server-rendered ECharts SVG on statement pages"
```

---
### Task 12: End-to-end proof, both transports, and the PR

Nothing above proves a pack actually renders. This task does, against a real tenant, through both transports, and attaches the artefacts.

**Files:**
- Create: `scripts/pdf/render-pack.ts`
- Create: `docs/superpowers/plans/screenshots/2026-09-ws2-management-pack-playwright.pdf`
- Create: `docs/superpowers/plans/screenshots/2026-09-ws2-management-pack-gotenberg.pdf` (or a recorded deferral, see Step 4)
- Create: `docs/superpowers/plans/screenshots/2026-09-ws2-management-pack.pptx`
- Create: `docs/superpowers/plans/screenshots/2026-09-ws2-pack-print-page.png`

- [ ] **Step 1: Write the proof script**

```ts
// scripts/pdf/render-pack.ts
//
// Renders a report pack end to end and writes the artefacts to disk.
// Requires:
//   - the dev server running and reachable at APP_URL
//   - PRINT_TOKEN_SECRET set to the same value the dev server was started with
//   - GOTENBERG_URL set to exercise the Gotenberg transport; unset for Playwright
//
// Usage:
//   APP_URL=http://localhost:3200 PRINT_TOKEN_SECRET=<secret> \
//     bun run scripts/pdf/render-pack.ts management 2026-01-01 2026-09-05 out.pdf

import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { renderPagePdf } from '@/lib/pdf/renderPagePdf';
import { chooseTransportName } from '@/lib/pdf/selectTransport';
import { packPrintApiPaths } from '@/modules/accounting/services/packs/packSections';
import type { PackType } from '@/modules/accounting/services/reports/reportPackService';
import { log } from '@/lib/logger';

const DEMO_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const DEMO_USER_ID = 'aeb3949e-6c93-4c17-bbdf-b6d2d99fa9a2';

async function main() {
  const packType = (process.argv[2] ?? 'management') as PackType;
  const from = process.argv[3] ?? '2026-01-01';
  const to = process.argv[4] ?? '2026-09-05';
  const outPath = process.argv[5] ?? `docs/superpowers/plans/screenshots/2026-09-ws2-${packType}-pack.pdf`;

  const pdf = await renderPagePdf({
    companyId: DEMO_COMPANY_ID,
    userId: DEMO_USER_ID,
    path: '/accounting/reports/report-packs',
    query: { pack: packType, from, to },
    apiPaths: packPrintApiPaths(packType),
  });

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, pdf);
  log.info('render-pack: wrote PDF', {
    outPath, bytes: pdf.length, transport: chooseTransportName(process.env),
  }, 'pdf');
}

main().catch((err) => {
  log.error('render-pack: failed', { message: err instanceof Error ? err.message : String(err) }, 'pdf');
  process.exitCode = 1;
});
```

- [ ] **Step 2: Render the Management pack through Playwright**

```bash
cd <worktree>
bun run dev &                       # :3200, with PRINT_TOKEN_SECRET in .env.local
# wait for the server to answer, then:
APP_URL=http://localhost:3200 PDF_TRANSPORT=playwright \
  PRINT_TOKEN_SECRET=$(grep '^PRINT_TOKEN_SECRET=' .env.local | cut -d= -f2-) \
  bun run scripts/pdf/render-pack.ts management 2026-01-01 2026-09-05 \
  docs/superpowers/plans/screenshots/2026-09-ws2-management-pack-playwright.pdf
```

Open the PDF and check, by eye, all six of these. A green script is not proof of a readable document.

1. A cover page with the company, the pack name and the period.
2. A contents page listing all eight management-pack sections in order.
3. Every section on its own page, under its IFRS title.
4. The profit bridge and the twelve-month trend printed landscape, with visible bars.
5. Page numbers in the footer, no Chromium title/date header.
6. Black ink on white paper — no dark-mode ground anywhere.

If the ground is dark, the theme fight in `usePrintMode` was lost: check that the layout effect writes `accounting-theme` before `ThemeProvider` reads it.

- [ ] **Step 3: Check the figures against the screen**

Open `/accounting/reports/report-packs` in a browser for the same company and period, expand the income statement and balance sheet sections, and compare every figure with the PDF. They come from one service through one model, so any difference is a bug in this workstream, not a rounding difference. Record the comparison in the PR.

- [ ] **Step 4: Render the same pack through Gotenberg**

```bash
docker run -d --name gotenberg --restart unless-stopped \
  -p 5002:3000 --add-host host.docker.internal:host-gateway \
  gotenberg/gotenberg:8 gotenberg \
  --chromium-allow-list='^https?://host\.docker\.internal:3200/'

curl -sS --request POST http://localhost:5002/forms/chromium/convert/url \
  --form url=https://gotenberg.dev --output /tmp/gotenberg-smoke.pdf && ls -l /tmp/gotenberg-smoke.pdf

APP_URL=http://host.docker.internal:3200 GOTENBERG_URL=http://localhost:5002 \
  PRINT_TOKEN_SECRET=$(grep '^PRINT_TOKEN_SECRET=' .env.local | cut -d= -f2-) \
  bun run scripts/pdf/render-pack.ts management 2026-01-01 2026-09-05 \
  docs/superpowers/plans/screenshots/2026-09-ws2-management-pack-gotenberg.pdf
```

Then diff the two PDFs by eye: same sections, same figures, same orientation. Small typographic differences between Chromium builds are expected; a missing chart or a different number is not.

If Docker cannot be run on this host, do NOT fake this step. Record in the PR, verbatim: "Gotenberg transport proof DEFERRED — no container runtime available in this worktree; the docker run and the render command are in `scripts/pdf/render-pack.ts` and `gotenbergTransport.ts` headers and must be run on velo before the transport is switched on in production." An unproven transport must not be enabled by setting `GOTENBERG_URL` in production.

- [ ] **Step 5: Render the PPTX**

```bash
curl -sS -b "sb-access-token=<a real session cookie>" -b "active_company_id=<demo company id>" \
  'http://localhost:3200/api/accounting/packs/management/pptx?from=2026-01-01&to=2026-09-05' \
  --output docs/superpowers/plans/screenshots/2026-09-ws2-management-pack.pptx
```

Open it in PowerPoint, Keynote or LibreOffice Impress and check: a title slide, one slide per section, and that clicking the profit-bridge chart opens an editable data sheet with the real figures rather than a picture.

- [ ] **Step 6: Screenshot the print page in a browser**

Use the browser tooling to load `http://localhost:3200/accounting/reports/report-packs?print=1&pack=management&from=2026-01-01&to=2026-09-05`, confirm `data-print-ready="true"` appears on the root element, and save the screenshot to `docs/superpowers/plans/screenshots/2026-09-ws2-pack-print-page.png`. Attach it to the PR (programme gate 4).

- [ ] **Step 7: Run the full gate**

```bash
cd <worktree>
bun run ci
bun run test:components
```

Both green. If `bun run ci` skips integration tests for want of `DATABASE_URL`, say so in the PR rather than reporting a clean run.

- [ ] **Step 8: Commit the artefacts and open the PR**

```bash
cd <worktree>
git add scripts/pdf/render-pack.ts docs/superpowers/plans/screenshots/2026-09-ws2-*
git commit -m "test(packs): end-to-end pack render artefacts, both transports"
timeout 420 git push -u origin feat/reporting-ws2-packs
gh pr create --title "WS2: report packs as rendered pages, PDF and PowerPoint exports" --body "<see below>"
```

The PR body must carry, in this order:

1. The mutation proofs from Tasks 1, 4, 6, 8 and 11 — the RED output and the PASS output for each.
2. The figure comparison from Step 3.
3. The two transport artefacts, or the verbatim deferral from Step 4.
4. The browser screenshot from Step 6.
5. The list of files touched outside this workstream's ownership, with the grant that authorised each.
6. A one-line note that `pages/api/accounting/reports-pdf.ts` (jsPDF) and `reports-html.ts` are still in place and unchanged, and that retiring them is a separate PR.

- [ ] **Step 9: Reviews**

- `/review` blind review of the whole branch. Fix every HIGH, MEDIUM and LOW.
- An adversarial security review of Task 1 only (`printAuth.ts` + `withAuth.ts`), with a fresh agent and no session context, briefed: "can this token be widened, replayed, or made to authorise a path it was not minted for?"
- No auto-merge. Every PR in this programme touches a production path; the lead or Hein merges after the gates.

---

## Self-Review

**Spec coverage.** Every controller ruling maps to a task:

| Ruling | Task |
|---|---|
| Gotenberg in Docker, `GOTENBERG_URL`, swappable launch seam, docker run in the header | 2, 3 |
| Playwright stays as the dev/local transport | 2 |
| The pack is the React page, with cover, contents, page numbers, landscape sections, `data-print-ready` | 7, 8 |
| Print token authorises a SET of paths, exact match per path, reject tests kept | 1 |
| PowerPoint via `pptxgenjs`, native editable charts, pinned | 10 |
| AFS keeps WeasyPrint, gains an ECharts SSR seam, one chart implemented | 11 |
| Download endpoints under `pages/api/accounting/packs/[id]/`, company-scoped, streamed, audited | 9, 10 |
| No dependency beyond `pptxgenjs` | Global Constraints, Task 10 |
| Every figure is a service figure | 6 (the no-new-numbers test), 10 |
| Proof: Management pack for ISAFlow Demo through both transports, artefacts committed | 12 |
| `withAuth.ts` touched only for the token, exact diff, adversarial review | 1 |

**Type consistency.** `PackDocument` / `PackDocumentSection` / `PackBlock` are defined in Task 6 and used unchanged in Tasks 7, 8, 10. `DeckSlide` is defined in Task 10 and used only there. `PdfRenderRequest` and `PdfTransport` are defined in Task 2 and implemented in Tasks 2 and 3. `packPrintApiPaths` is defined in Task 4 and consumed in Tasks 8, 9 and 12. `usePrintReady` and `countCharts` are defined in Task 7 and consumed in Task 8. `PackTrendPoint` is defined in Task 5 and consumed in Tasks 6, 7, 10.

**Known risks, stated rather than hidden.**

- **The theme fight.** `usePrintMode` relies on child layout effects running before a parent's passive mount effect. That is React's documented ordering, but it is the single most likely thing to produce a black-on-black PDF. Task 12 Step 2 check 6 exists to catch it, and the fallback (removing `.dark` directly) is in the code.
- **Named `@page landscape-page`.** Chromium 111+ only. Both transports ship newer, but if a landscape section prints portrait, the fallback is a fixed-width rotated container rather than a named page.
- **Gotenberg cannot stub requests.** The print page renders without `AppLayout`, so it fires no background calls at all; that is what makes the two transports equivalent. Anyone adding a page to this pipeline must do the same or accept 401s in the log.
- **`bun run ci` does not exercise a browser.** Nothing in the unit suite would catch a pack that renders blank. Task 12 is not optional.
- **`reports-pdf.ts` (jsPDF) stays.** Two PDF paths exist at the end of this workstream. Retiring the old one is a separate PR with its own review, because it is a live production path.

---

## Requests to other owners

Each of these is small, additive, and outside this workstream's file ownership. Send them to the lead before starting the task that needs them.

1. **`src/lib/auth/withAuth.ts`** (Task 1) — the four-line print-token diff shown in Task 1 Step 5. Already sanctioned by the controller; listed here because it is the one auth file this workstream touches, and it carries a mandatory adversarial security review.
2. **`src/lib/apiRoutes.ts`** (Task 5) — one import and one line registering `'/api/accounting/packs/{}/trend'` so `apiJson` infers its type instead of returning `unknown`.
3. **`src/modules/accounting/services/reports/statementRows/packMappers.ts`** and **`src/components/accounting/ManagementPandLRows.tsx`** (Task 6) — move the balance-sheet row list out of the component into `toManagementBsRows` in the mapper, unchanged. Without it the printed pack and the deck need a second copy of that row list, which is the exact defect that put an unfooted pack in front of a client.
4. **`src/modules/accounting/services/afs/afsHtmlRendererService.ts`** and **`afsHtmlTableRenderer.ts`** (Task 11) — an optional `charts?: Partial<Record<SectionType, string>>` on `AfsRenderContext`, an optional second parameter on `renderSectionContent`, and one CSS rule. Fully additive: a section with no chart renders byte-identically today.
5. **`src/modules/accounting/services/afs/noteGenerators/primaryStatements/incomeStatement.ts`** (Task 11) — export `isRevenueLine`. One word. Without it the AFS chart has to restate the revenue sign-flip rule, and a chart that contradicts the table above it is worse than no chart.
6. **WS1 (charts)** — no request. This workstream deliberately builds its chart options as pure functions in its own service directory and renders them through the existing `EChartClient`, so nothing here blocks on, or collides with, `src/components/accounting/charts/**`. If WS1 later ships a waterfall component with an equivalent option builder, the pack should switch to it and delete `waterfallOption`.
7. **New directory claim** — `src/components/accounting/packs/**` is claimed by WS2. It is unassigned in the programme's ownership table; flagging it so WS1 and WS3 do not also claim it.
