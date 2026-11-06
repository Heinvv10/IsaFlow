/** ADVERSARIAL REPROS for #1169 (figure-floor gate). */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { log } from '@/lib/logger';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
const gate = vi.hoisted(() => ({ on: true }));
vi.mock('@/modules/accounting/services/packs/pages/packFigureFloor', async (orig) => {
  const a = await orig<any>();
  return { ...a, assertFiguresReadable: (p: any, s: any) => { if (gate.on) a.assertFiguresReadable(p, s); } };
});
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { input, type Shape } from '../services/packs/fixtures/advInputs';
import { printBoardPack } from './renderPackPdf';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 180_000);
afterAll(async () => { await browser?.close(); });
const quiet = () => vi.spyOn(log, 'warn').mockImplementation(() => undefined);

it('SILENT OVERFLOW: a pack the gate passes does not run past the sheet edge (prior rounds to nil, R42tn revenue)', async () => {
  quiet(); gate.on = true;
  const doc = buildBoardPackPages(input({ tr: 'none', budget: true, prior: true, negative: false, loss: false, k: 10_000_000, plug: 0, sg: [1, 1, 1, 1], pk: 1e-7 }));
  const out = await printBoardPack(doc, browser);
  expect(out.overflow.map((o) => `${o.id} +${o.over} ${o.widest}`)).toEqual([]);
}, 300_000);

it.each<[string, Shape]>([
  ['table at the floor, R153tn revenue', { tr: 'demo', budget: true, prior: true, negative: false, loss: false, k: 36_517_413, plug: 0.05, sg: [1, 1, 1, 1] }],
  ['KPI row at the floor, net-debit revenue', { tr: 'demo', budget: false, prior: true, negative: true, loss: false, k: 205_352_503, plug: 0.05, sg: [1, 1, 1, 1] }],
])('OVER-REFUSAL: %s fits Chromium at the floor, so it is not refused', async (_, shape) => {
  quiet(); gate.on = false;
  const doc = buildBoardPackPages(input(shape));
  const out = await printBoardPack(doc, browser);
  const fits = out.overflow.length === 0 && out.figurePt.every((f) => (f.kpi ?? 12) >= 11.99 && (f.table ?? 7.5) >= 7.49);
  gate.on = true;
  let refused = false;
  try { buildBoardPackPages(input(shape)); } catch (e) { if (!(e instanceof PackRefusal)) throw e; refused = true; }
  expect({ fitsInChromium: fits, refused }).toEqual({ fitsInChromium: true, refused: false });
}, 300_000);

it('CHANGED OUTPUT: a fitting pack keeps the KPI size master printed (R420bn revenue: master 20.27pt)', async () => {
  quiet(); gate.on = true;
  const doc = buildBoardPackPages(input({ tr: 'demo', budget: true, prior: true, negative: false, loss: false, k: 100_000, plug: 0.05, sg: [1, 1, 1, 1] }));
  const out = await printBoardPack(doc, browser);
  expect(out.overflow).toEqual([]);
  expect(Math.min(...out.figurePt.map((f) => f.kpi ?? Infinity))).toBeGreaterThanOrEqual(20.2);
}, 300_000);

it('22PT FITS: a k=1000 pack whose KPI row fitted at 22pt before #1158 still prints 22pt', async () => {
  quiet(); gate.on = true;
  const doc = buildBoardPackPages(input({ tr: 'demo', budget: true, prior: true, negative: true, loss: false, k: 1000, plug: 0, sg: [1, -1, 1, 1] }));
  const out = await printBoardPack(doc, browser);
  expect(out.overflow).toEqual([]);
  expect(Math.min(...out.figurePt.map((f) => f.kpi ?? Infinity))).toBeGreaterThanOrEqual(21.99);
}, 300_000);
