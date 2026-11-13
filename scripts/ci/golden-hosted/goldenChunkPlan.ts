/**
 * Splits the Golden Paths suite into N chunks that run as parallel hosted jobs.
 *
 * Plain `playwright --shard` splits by test COUNT, which made shard 1 (holding the 12-screen o-theme-contrast
 * sweep, ~10 of the suite's 44 test minutes) run 14-19 min against 3-6 min for the others. This plans by measured
 * seconds instead. The pieces are CONTIGUOUS in Playwright's own file order (a chunk is a run of the old single
 * run, not a scatter of specs), and o-theme-contrast is cut per screen with --grep.
 *
 * Every spec file on disk and every contrast screen in the spec source lands in exactly one chunk, whatever the
 * weight table says: a file or screen it does not list takes DEFAULT_SECONDS, so a new spec runs (and the unit
 * test goldenChunkPlan.test.ts fails if a listed file vanished or a chunk is empty).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const SPEC_DIR = 'tests/e2e/golden-paths';
export const CONTRAST_FILE = 'o-theme-contrast.spec.ts';
/** The titles in CONTRAST_FILE are `${slug}: AA contrast ...`; goldenChunkPlan.test.ts pins this against the spec. */
export const CONTRAST_TITLE_TAIL = ': AA contrast';
export const DEFAULT_SECONDS = 30;

/** Mean seconds per file over three green hosted runs (2026-11-12); files not listed take DEFAULT_SECONDS. */
export const FILE_SECONDS: Readonly<Record<string, number>> = {
  'a-quote-lifecycle.spec.ts': 3, 'b-invoice-receipt-statement.spec.ts': 4, 'c-invoice-cancel-gl-reversal.spec.ts': 1,
  'd-supplier-payment-ui.spec.ts': 11, 'e-credit-note-approve.spec.ts': 3, 'f-bank-import-reconcile.spec.ts': 4,
  'g-journal-lifecycle.spec.ts': 1, 'h-payroll-run.spec.ts': 5, 'i-vat201.spec.ts': 2, 'j-fixed-assets-far.spec.ts': 2,
  'k-month-end-close.spec.ts': 2, 'l-validation-guards.spec.ts': 1, 'm-migration-wizard.spec.ts': 32,
  'n-a11y-main-screens.spec.ts': 168, 'n-banking-top-nav.spec.ts': 89, 'o2-theme-behaviour.spec.ts': 45,
  'o3-banner-titles.spec.ts': 159, 'p-type-money.spec.ts': 24, 'q-top-nav-hover.spec.ts': 79, 'q2-top-nav-axe.spec.ts': 24,
  'r-command-palette.spec.ts': 40, 's-shell-cls-mobile.spec.ts': 55, 's2-shell-menus-keyboard.spec.ts': 24,
  't-report-filter-dates.spec.ts': 14, 'u-list-filter-dates.spec.ts': 24, 'v-budget-workspace-axe.spec.ts': 11,
  'v-empty-states.spec.ts': 64, 'w-setup-checklist.spec.ts': 14, 'x-contrast-sweep.spec.ts': 54,
  'y1-invoice-form-kit.spec.ts': 39, 'y2-bank-tx-naming.spec.ts': 41, 'y3-employee-create-kit.spec.ts': 30,
  'y5-document-dates-sales.spec.ts': 51, 'y6-document-dates-rest.spec.ts': 21, 'y7-dashboard-aging-tie.spec.ts': 24,
  'y8-purchase-forms-390.spec.ts': 31, 'z1-invoice-defaults.spec.ts': 70, 'z10-payslips.spec.ts': 38,
  'z11-kit-select.spec.ts': 31, 'z12-bank-tx-selects.spec.ts': 43, 'z13-invoice-preview-unsaved.spec.ts': 17,
  'z15-density.spec.ts': 35, 'z16-return-lifecycle.spec.ts': 50, 'z17-return-drill.spec.ts': 39, 'z18-explain.spec.ts': 9,
  'z2-invoice-autosave-send.spec.ts': 72, 'z2b-invoice-held-back.spec.ts': 26, 'z3-pnl-pdf.spec.ts': 1,
  'z4-employee-pay-on-create.spec.ts': 65, 'z5-employee-bank-details.spec.ts': 41, 'z6-payrun-review-grid.spec.ts': 38,
  'z7-undo-drawers.spec.ts': 116, 'z9-employee-readiness.spec.ts': 99,
};
/** Mean seconds per o-theme-contrast screen, same runs. */
export const CONTRAST_SECONDS: Readonly<Record<string, number>> = {
  dashboard: 45, 'customer-invoices': 34, 'customer-invoice-new': 43, 'bank-transactions': 84, 'payroll-employees': 43,
  'income-statement': 60, vat201: 44, 'balance-sheet': 54, 'trial-balance': 48, 'general-ledger': 45, 'receipt-match': 76, disputes: 45,
};

export type Item = { kind: 'file'; name: string; seconds: number } | { kind: 'screen'; name: string; seconds: number };
/** One `playwright test` invocation: file paths, plus a --grep when only some of a file's tests belong here. */
export type Invocation = { files: string[]; grep?: string };

const SAFE = /^[A-Za-z0-9_.-]+$/;
function safe(name: string): string {
  if (!SAFE.test(name)) throw new Error(`golden chunk plan: refusing unexpected name ${JSON.stringify(name)}`);
  return name;
}

/** Contrast screen slugs, read from the spec so a new screen cannot be left out. */
export function contrastSlugs(specSource: string): string[] {
  const block = /const SCREENS = \[([\s\S]*?)\] as const;/.exec(specSource)?.[1];
  if (block === undefined) throw new Error(`golden chunk plan: no SCREENS list in ${CONTRAST_FILE}`);
  const slugs = [...block.matchAll(/slug:\s*'([^']+)'/g)].map((m) => safe(m[1]!));
  if (slugs.length === 0) throw new Error(`golden chunk plan: SCREENS in ${CONTRAST_FILE} has no slugs`);
  return slugs;
}

/** Playwright's order for these names is plain code-point order (verified against a CI log). */
export function planItems(files: string[], contrastSource: string): Item[] {
  const items: Item[] = [];
  for (const name of [...files].filter((f) => f.endsWith('.spec.ts')).sort()) {
    if (name === CONTRAST_FILE) {
      for (const slug of contrastSlugs(contrastSource)) items.push({ kind: 'screen', name: slug, seconds: CONTRAST_SECONDS[slug] ?? DEFAULT_SECONDS });
    } else items.push({ kind: 'file', name: safe(name), seconds: FILE_SECONDS[name] ?? DEFAULT_SECONDS });
  }
  return items;
}

/** Contiguous split: an item goes to the chunk its midpoint (in cumulative seconds) falls in. */
export function splitItems(items: Item[], chunks: number): Item[][] {
  if (!Number.isInteger(chunks) || chunks < 1) throw new Error(`golden chunk plan: chunks must be a positive integer, got ${chunks}`);
  const total = items.reduce((s, i) => s + i.seconds, 0);
  const out: Item[][] = Array.from({ length: chunks }, () => []);
  let before = 0;
  for (const item of items) {
    const k = Math.min(chunks - 1, Math.floor(((before + item.seconds / 2) / total) * chunks));
    out[k]!.push(item);
    before += item.seconds;
  }
  return out;
}

/** Runs of the same kind, in suite order, become one invocation each. */
export function toInvocations(items: Item[]): Invocation[] {
  const out: Invocation[] = [];
  let screens: string[] = [];
  const flush = (): void => {
    if (screens.length === 0) return;
    out.push({ files: [`${SPEC_DIR}/${CONTRAST_FILE}`], grep: `\\s(?:${screens.join('|')})${CONTRAST_TITLE_TAIL}` });
    screens = [];
  };
  let files: string[] = [];
  const flushFiles = (): void => {
    if (files.length) out.push({ files });
    files = [];
  };
  for (const item of items) {
    if (item.kind === 'screen') { flushFiles(); screens.push(item.name); } else { flush(); files.push(`${SPEC_DIR}/${item.name}`); }
  }
  flush();
  flushFiles();
  return out;
}

export function chunkSeconds(chunk: Item[]): number {
  return chunk.reduce((s, i) => s + i.seconds, 0);
}

/** The plan for chunk `k` (1-based) of `n`, from the specs on disk under `root`. */
export function planChunk(root: string, k: number, n: number): { items: Item[]; invocations: Invocation[] } {
  if (!Number.isInteger(k) || k < 1 || k > n) throw new Error(`golden chunk plan: chunk ${k} is outside 1..${n}`);
  const dir = path.join(root, SPEC_DIR);
  const files = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  const items = splitItems(planItems(files, readFileSync(path.join(dir, CONTRAST_FILE), 'utf8')), n)[k - 1]!;
  return { items, invocations: toInvocations(items) };
}
