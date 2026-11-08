/**
 * EVERY CANDIDATE LINE OF THE PACK'S OWN WORDING FITS IN THE MODEL ONLY WHERE IT FITS IN CHROMIUM, in every run.
 *
 * The full-grid proofs (`packKpiLayoutGrid`, `packTableLayoutGrid`) take an hour each and are opt-in. This takes the
 * wording a pack prints, from packs across the grid's shapes, and every line a fill could try with it (each run of
 * consecutive pieces, a footnote mark only with a run that ends the text, the arrow cue only with one that starts it):
 * a KPI tile's label with its mark, its delta line over a sweep of values in both units with each cue, its reason, and a
 * statement table's row label at its row's weight with its mark. Each is held to Chromium (`support/lineFitHarness.ts`):
 * never narrower, over by a unit on at most the measured share and stated headroom. The template is the adversary's
 * review of #1235 (`realLines`, `deltaValues`).
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { log } from '@/lib/logger';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { deltaText, ROW_WEIGHT, type KpiTile } from '@/modules/accounting/services/packs/pages/packFigureFit';
import { pieces } from '@/modules/accounting/services/packs/pages/packLineBreaks';
import { allShapes, input } from '../services/packs/fixtures/packGridInputs';
import { launchPrintChromium } from './printChromium';
import { deltaCase, hold, labelCase, reasonCase, runCase, type Case } from './support/lineFitHarness';

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 120_000);
afterAll(async () => { await browser?.close(); });

/**
 * Each run of consecutive pieces of `text` that a line could break inside (two pieces or more; one piece never wraps,
 * so it decides nothing): whether it starts the text, whether it ends it. `cued`: one piece counts too, after the cue.
 */
function runs(text: string, cued = false): Array<{ line: string; first: boolean; last: boolean }> {
  const all = pieces(text);
  const out: Array<{ line: string; first: boolean; last: boolean; count: number }> = [];
  for (let a = 0; a < all.length; a += 1) {
    let line = '';
    for (let b = a; b < all.length; b += 1) {
      line = b === a ? all[b]!.text : `${line}${all[b]!.spaced ? ' ' : ''}${all[b]!.text}`;
      out.push({ line, first: a === 0, last: b === all.length - 1, count: b - a + 1 });
    }
  }
  return out.filter((r) => r.count > 1 || (cued && r.first));
}

/** The wording of packs across the grid: every 61st shape (its seven boolean switches, three trends, five scales). */
function wording(): { labels: Map<string, number | null>; bases: Set<string>; reasons: Set<string>; rows: Map<string, { weight: 400 | 500 | 600; mark: number | null }> } {
  const labels = new Map<string, number | null>();
  const bases = new Set<string>();
  const reasons = new Set<string>();
  const rows = new Map<string, { weight: 400 | 500 | 600; mark: number | null }>();
  const shapes = allShapes();
  for (let i = 0; i < shapes.length; i += 61) {
    let doc;
    try { doc = buildBoardPackPages(input(shapes[i]!)); } catch (e) { if (e instanceof PackRefusal) continue; throw e; }
    for (const block of doc.pages.flatMap((p) => p.blocks)) {
      if (block.kind === 'kpiTiles') {
        for (const tile of block.tiles) {
          labels.set(`${tile.label}|${tile.trendFootnote ?? ''}`, tile.trendFootnote ?? null);
          if (tile.delta !== null) bases.add(tile.delta.basis);
          if (tile.figure.value === null && tile.figure.unavailable) reasons.add(tile.figure.unavailable);
        }
      }
      if (block.kind === 'table') {
        for (const row of block.table.rows) rows.set(`${row.label}|${row.role}|${row.footnote ?? ''}`, { weight: ROW_WEIGHT[row.role], mark: row.footnote ?? null });
      }
    }
  }
  return { labels, bases, reasons, rows };
}

/**
 * How many over by a unit each set may have: measured 1,224 of 2,097 KPI lines and 38 of 60 table lines (the noise
 * margin, `FIT_NOISE_UNITS`, takes a unit wherever an exact sum's fraction of a unit is past a half), and a stated
 * headroom of 3% beside each.
 */
const OVER = { kpi: 1260, table: 40 } as const;

it('every candidate line of the KPI wording (labels with marks, deltas over a value sweep with each cue, reasons): never narrower than Chromium', async () => {
  vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const { labels, bases, reasons } = wording();
  expect(labels.size).toBeGreaterThan(8);
  expect(bases.size).toBeGreaterThan(0);
  const cases: Case[] = [];
  for (const [key, mark] of labels) {
    for (const r of runs(key.split('|')[0]!)) cases.push(labelCase(r.line, r.last ? mark : null));
  }
  // The values a delta prints: a sweep of magnitudes 0.1 to 50,000, both signs, in percent and in points, over every
  // basis the packs use.
  let seed = 12345;
  const next = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const deltas = new Set<string>();
  for (const basis of bases) {
    for (let i = 0; i < 120; i += 1) {
      const magnitude = 10 ** (-1 + next() * 5.7);
      const value = Math.round((next() < 0.5 ? -magnitude : magnitude) * 10) / 10;
      deltas.add(deltaText({ delta: { value, unit: next() < 0.7 ? 'percent' : 'points', basis, favourable: true } } as unknown as KpiTile));
    }
  }
  for (const text of deltas) {
    for (const r of runs(text, true)) {
      for (const arrow of r.first ? ['↑', '↓', '→'] : [null]) {
        if (arrow !== null || pieces(r.line).length > 1) cases.push(deltaCase(r.line, arrow));
      }
    }
  }
  for (const reason of reasons) for (const r of runs(reason)) cases.push(reasonCase(r.line));
  expect(cases.length).toBeGreaterThan(2000);
  const over = await hold(browser, cases, OVER.kpi);
  process.stdout.write(`REALLINES kpi: ${over} of ${cases.length} over by a unit\n`);
}, 1_200_000);

it('every candidate line of the statement tables\' row labels, at their weights with their marks: never narrower than Chromium', async () => {
  vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const { rows } = wording();
  expect(rows.size).toBeGreaterThan(20);
  const cases: Case[] = [];
  for (const [key, { weight, mark }] of rows) {
    for (const r of runs(key.split('|')[0]!)) cases.push(runCase(r.line, 12, weight, r.last ? mark : null));
  }
  const over = await hold(browser, cases, OVER.table);
  process.stdout.write(`REALLINES table: ${over} of ${cases.length} over by a unit\n`);
}, 1_200_000);
