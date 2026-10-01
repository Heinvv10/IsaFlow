/**
 * THE RUNNING FOOTER, AS CHROMIUM LAYS IT OUT — not as a model of it.
 *
 * An earlier test measured the footer with the pack's text ruler and passed
 * against a layout Chromium does not produce: the footer's outer flex row had
 * no `box-sizing:border-box` (its 100% width plus padding overflowed the
 * sheet) and no `min-width:0`, so a long company name pushed the page number
 * to x = 595pt on a 595pt sheet, made "DRAFT" vanish and clipped the right
 * block to "us". So this prints the footer through `page.pdf` with the
 * transport's real margins and reads the words back with `pdftotext -bbox`.
 *
 * WHAT MUST HOLD, for every company name, pack, period and draft state:
 *  - the page number's right edge sits at or inside the right margin, and at
 *    the SAME x on every page and every case;
 *  - "Confidential — for board use" and, on a draft, "DRAFT", are whole;
 *  - the whole period is printed (only the COMPANY NAME may be cut);
 *  - nothing extends past the sheet.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { HEADER_HTML, PDF_MARGIN_MM, mm } from '@/lib/pdf/pdfTransport';
import { buildFooterHtml, PACK_CONFIDENTIALITY } from '@/lib/pdf/printFurniture';
import { PACK_FOOTER_FACE_FILE, PACK_FOOTER_FONT_FAMILY, packFooterFaceCss } from '@/lib/charts/packFont';

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, '../../..');
const PT_PER_MM = 72 / 25.4;
const SHEET_W = 210 * PT_PER_MM;
const SHEET_H = 297 * PT_PER_MM;
const RIGHT_MARGIN_X = SHEET_W - PDF_MARGIN_MM.right * PT_PER_MM;
const FOOTER_TOP = SHEET_H - PDF_MARGIN_MM.bottom * PT_PER_MM;
const SHEETS = 12;

const NAMES = [
  ['a short name', 'Acme (Pty) Ltd'],
  ['a 53-character name', 'Brightsphere Integrated Holdings And Services (Pty) Lt'.slice(0, 53)],
  ['a 75-character name', 'The Brightsphere Integrated Holdings And Services Group Of Companies (Pty) Ltd'.slice(0, 75)],
] as const;
const PACKS = ['Board Pack', 'Management Pack'] as const;
const PERIODS = ['1 Jan 2026 – 31 Aug 2026', '11 September 2026 to 30 September 2026'] as const;

interface Word { text: string; xMin: number; xMax: number; yMin: number; yMax: number }

let browser: Browser;
let dir: string;
beforeAll(async () => {
  browser = await chromium.launch();
  dir = mkdtempSync(path.join(tmpdir(), 'pack-footer-'));
}, 120_000);
afterAll(async () => {
  await browser?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Footer words per sheet (1-based), from a real PDF. */
async function footerWords(footerHtml: string, tag: string): Promise<Word[][]> {
  const page = await browser.newPage();
  try {
    const sheets = Array.from({ length: SHEETS }, (_, i) => `<p style="break-after:page">sheet ${i + 1}</p>`).join('');
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>${sheets}</body></html>`);
    // The footer face reaches Chromium's footer only through the resource
    // cache, so the main document loads it first — as the app does.
    const css = packFooterFaceCss(readFileSync(path.join(ROOT, 'public', 'fonts', PACK_FOOTER_FACE_FILE)).toString('base64'));
    await page.evaluate(async ([faceCss, family]) => {
      const style = document.createElement('style');
      style.textContent = faceCss;
      document.head.appendChild(style);
      await document.fonts.load(`400 1em "${family}"`, '0123456789');
    }, [css, PACK_FOOTER_FONT_FAMILY]);
    const pdf = await page.pdf({
      format: 'A4', printBackground: true, displayHeaderFooter: true,
      headerTemplate: HEADER_HTML, footerTemplate: footerHtml,
      margin: {
        top: mm(PDF_MARGIN_MM.top), bottom: mm(PDF_MARGIN_MM.bottom),
        left: mm(PDF_MARGIN_MM.left), right: mm(PDF_MARGIN_MM.right),
      },
    });
    const file = path.join(dir, `${tag}.pdf`);
    writeFileSync(file, pdf);
    const { stdout } = await run('pdftotext', ['-bbox', file, '-']);
    return stdout.split('<page ').slice(1).map((chunk) =>
      [...chunk.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
        .map((m) => ({
          text: m[5]!.replace(/&amp;/g, '&'), xMin: +m[1]!, yMin: +m[2]!, xMax: +m[3]!, yMax: +m[4]!,
        }))
        .filter((w) => w.yMin >= FOOTER_TOP - 2));
  } finally {
    await page.close();
  }
}

const rows = NAMES.flatMap(([nameLabel, name]) => PACKS.flatMap((pack) =>
  [false, true].flatMap((draft) => PERIODS.map((period) => ({ nameLabel, name, pack, draft, period })))));

describe('the running footer, printed by Chromium', () => {
  const pageNumberEdges: number[] = [];

  it.each(rows)('$nameLabel · $pack · draft=$draft · $period', async ({ nameLabel, name, pack, draft, period }) => {
    const html = buildFooterHtml({ companyName: name, packLabel: pack, period, confidentiality: PACK_CONFIDENTIALITY, draft });
    const sheets = await footerWords(html, `${nameLabel}-${pack}-${draft}-${period}`.replace(/\W+/g, '_'));
    expect(sheets.length).toBe(SHEETS);

    for (const [i, words] of sheets.entries()) {
      const where = `sheet ${i + 1}`;
      const text = words.map((w) => w.text).join(' ');
      expect(words.length, `${where}: no footer was printed`).toBeGreaterThan(0);

      // Nothing past the sheet, and nothing past the right margin.
      expect(Math.max(...words.map((w) => w.xMax)), `${where}: something runs past the right margin`)
        .toBeLessThanOrEqual(RIGHT_MARGIN_X + 1);

      // The right block, whole.
      expect(text, `${where}: confidentiality clipped`).toContain('Confidential — for board use');
      if (draft) expect(text, `${where}: DRAFT missing`).toMatch(/\bDRAFT\b/);
      else expect(text).not.toMatch(/\bDRAFT\b/);

      // The page number: "N / 12", right edge on the margin, same everywhere.
      const total = words.filter((w) => w.text === String(SHEETS)).at(-1);
      expect(total, `${where}: page total missing`).toBeDefined();
      expect(words.some((w) => w.text === String(i + 1)), `${where}: page number missing`).toBe(true);
      pageNumberEdges.push(total!.xMax);

      // The period and pack are never what gets cut.
      expect(text, `${where}: the period was cut`).toContain(period);
      expect(text, `${where}: the pack label was cut`).toContain(pack);
      if (nameLabel === 'a short name') expect(text).toContain(name);
    }
  }, 60_000);

  it('put the page number at one x, on every page of every case', () => {
    expect(pageNumberEdges.length).toBe(rows.length * SHEETS);
    const spread = Math.max(...pageNumberEdges) - Math.min(...pageNumberEdges);
    expect(spread, `page-number right edges span ${spread.toFixed(2)}pt`).toBeLessThan(0.5);
  });
});
