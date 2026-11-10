/**
 * A SOFT HYPHEN AND A ZERO-WIDTH SPACE BREAK IN THE MODEL EXACTLY WHERE THEY BREAK IN CHROMIUM, AND A LINE THAT ENDS AT
 * A SOFT HYPHEN IS AS WIDE AS THE HYPHEN CHROMIUM SETS THERE.
 *
 * Fewer breaks than Chromium is safe for a width and unsafe for a height (a line count short), more is the other way
 * round, so at a soft hyphen or a zero-width space the breaks are compared, not bounded: each text is set at its
 * narrowest (every break taken), its lines are read back character by character, and at every position next to one of
 * the two the model breaks exactly when Chromium does (elsewhere it never breaks where Chromium does not, as
 * `packLineBreaks.test.ts` holds). A hyphen is drawn exactly at the lines the model says, and a line's width is its
 * piece's (never short, at most 1/32px over). The tables of what holds to a soft hyphen or a zero-width space
 * (`packSoftBreakRanges.ts`) are re-scanned in production's image (`printParity/packBreakTablesImage.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launchPrintChromium } from './printChromium';
import { openProbePage } from './measureWidths';
import { pieces } from '@/modules/accounting/services/packs/pages/packLineBreaks';
import { reasonPx } from '@/modules/accounting/services/packs/pages/packReasonWidth';
import { inFace } from '@/modules/accounting/services/packs/pages/packGlyphRuler';

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });

const SHY = '­';
const ZWSP = '​';
/** Every kind of neighbour: scripts, wide forms, emoji, signs, brackets, quotes, stops, dashes, spaces, joiners, marks. */
const NEIGHBOURS = ['日', '한', 'ー', 'ぁ', '々', 'Ａ', '😀', '❤️', '🇿🇦', '👍🏽', 'a', '5', 'é', 'α', 'Ж', 'א', 'ก', 'ह', 'ي',
  '€', '$', '%', '°', '(', ')', '[', ']', '"', "'", '’', '“', '«', '»', '.', ',', ':', ';', '!', '?', '/', '&', '+', '「', '」', '。', '、', '・', '…',
  '-', '–', '—', '‐', '‑', '|', '_', '#', ' ', ' ', ' ', ' ', '　', '⁠', '​', '‍', '﻿', '­', '́', ' '];
const TEXTS = [
  ...NEIGHBOURS.flatMap((x) => [`ab${x}${SHY}cd`, `ab${SHY}${x}cd`, `ab${x}${ZWSP}cd`, `ab${ZWSP}${x}cd`, `${SHY}${x}cd`, `${x}${SHY}cd`, `${ZWSP}${x}cd`]),
  // The adversary's (#1196 review): breaks Chromium takes and the model did not.
  'Not meaningful: zero​width​space​words​here.', 'Not meaningful: soft­hyphen­ated­words­here.',
  'ab­-cd', 'ab-­cd', 'ab­–cd', 'ab–­cd', 'ab­—cd', 'ab​-cd', 'ab​–cd', '-­ab', '­-ab', '2024­-25', '2024-­25',
  'R 1­000', 'ab­　　cd', 'ab​​­­cd', 'ab­­​​cd', 'ab­ cd­ ef', 'ab­', '­', '​',
  'ab ­cd', 'ab ​cd', 'a­b­c­d­e', 'a​b​c', 'Rev­enue­-based', 'ab­ cd', 'ab­ cd', 'ab­ cd',
];

interface Line { text: string; width: number; alone: number }

/** Each text set at its narrowest in the reason's style: its lines, each line's width, and its text's width alone. */
async function linesOf(texts: readonly string[]): Promise<Line[][]> {
  const page = await openProbePage(browser);
  try {
    return await page.evaluate((list) => {
      const td = document.getElementById('label')!;
      const span = (text: string, box: string): HTMLSpanElement => {
        const holder = document.createElement('div');
        holder.style.cssText = box;
        const s = document.createElement('span');
        s.className = 'pack-kpi-unavailable';
        s.textContent = text;
        holder.appendChild(s);
        td.appendChild(holder);
        return s;
      };
      return list.map((text) => {
        td.textContent = '';
        const narrow = span(text, 'width:0;white-space:normal');
        const node = narrow.firstChild!;
        const lines: Array<{ top: number; text: string }> = [];
        let at = 0;
        for (const ch of Array.from(text)) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + ch.length);
          at += ch.length;
          const rects = range.getClientRects();
          const last = lines[lines.length - 1];
          const top = rects.length > 0 ? Math.round(rects[rects.length - 1]!.top) : (last?.top ?? 0);
          if (last !== undefined && Math.abs(last.top - top) < 2) last.text += ch; else lines.push({ top, text: ch });
        }
        const widthAt = new Map<number, number>();
        for (const r of Array.from(narrow.getClientRects())) widthAt.set(Math.round(r.top), (widthAt.get(Math.round(r.top)) ?? 0) + r.width);
        return lines.map((line) => {
          const alone = span(line.text, 'white-space:nowrap').getBoundingClientRect().width;
          return { text: line.text, width: widthAt.get(line.top) ?? 0, alone };
        });
      });
    }, texts);
  } finally {
    await page.close();
  }
}

/** A line as the model's piece: the collapsible spaces a break consumes (and any line of nothing else) dropped. */
const visible = (lines: readonly Line[]): Line[] => lines.map((l) => ({ ...l, text: l.text.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '') }))
  .filter((l) => l.text !== '');

/** Where each of `parts` (in order, collapsible spaces between them dropped) starts and ends in `text`, in UTF-16 units. */
function spans(text: string, parts: readonly string[]): Array<{ from: number; to: number }> {
  let at = 0;
  return parts.map((part) => {
    const from = text.indexOf(part, at);
    if (from < 0) throw new Error(`${JSON.stringify(part)} is not in ${JSON.stringify(text)} after ${at}`);
    at = from + part.length;
    return { from, to: at };
  });
}

/** Is a break before `text[at]` one a soft hyphen or a zero-width space decides (the character on either side is one)? */
function decidedBySoftBreak(text: string, at: number): boolean {
  const before = text.slice(0, at).replace(/[ \t\n\r]+$/, '');
  const after = text.slice(at);
  return /(?:\u00AD\p{M}*|\u200B)$/u.test(before) || /^[\u00AD\u200B]/.test(after);
}

describe('a soft hyphen and a zero-width space', () => {
  it('the model breaks at every soft hyphen and zero-width space where Chromium does and nowhere else, and draws a hyphen exactly where Chromium does', async () => {
    const all = await linesOf(TEXTS);
    const wrong: string[] = [];
    let decided = 0;
    TEXTS.forEach((text, i) => {
      const lines = visible(all[i]!);
      const model = pieces(text);
      const chromiumAt = spans(text, lines.map((l) => l.text));
      const modelAt = spans(text, model.map((p) => p.text));
      const chromiumBreaks = new Set(chromiumAt.slice(1).map((l) => l.from));
      const modelBreaks = new Set(modelAt.slice(1).map((p) => p.from));
      const say = `${JSON.stringify(text)}: Chromium ${JSON.stringify(lines.map((l) => l.text))}, model ${JSON.stringify(model.map((p) => p.text))}`;
      for (let at = 1; at < text.length; at += 1) {
        if (decidedBySoftBreak(text, at)) {
          decided += 1;
          if (chromiumBreaks.has(at) !== modelBreaks.has(at)) wrong.push(`${say} (at ${at})`);
        } else if (modelBreaks.has(at) && !chromiumBreaks.has(at)) wrong.push(`${say} (a break Chromium does not take, at ${at})`);
      }
      // A hyphen, at every line end that is also a piece end (every soft-hyphen break is one, by the loop above). The
      // text's last piece keeps a soft hyphen's room, and Chromium draws none there (`packLineBreaks.pieces`;
      // `packLineFit.test.ts` holds the room).
      chromiumAt.forEach((line, j) => {
        const k = modelAt.findIndex((p) => p.to === line.to);
        if (k < 0) return;
        const drawn = lines[j]!.width - lines[j]!.alone > 1;
        const drawsHyphen = model[k]!.hyphen && k < model.length - 1;
        if (drawn !== drawsHyphen) wrong.push(`${say}: line ${JSON.stringify(lines[j]!.text)} hyphen drawn ${drawn}, model ${drawsHyphen}`);
      });
      model.forEach((p, k) => { if (p.hyphen && !chromiumAt.some((l) => l.to === modelAt[k]!.to)) wrong.push(`${say}: the model's hyphen after ${JSON.stringify(p.text)} ends no line`); });
    });
    expect(wrong.slice(0, 30)).toEqual([]);
    expect(TEXTS.length).toBeGreaterThan(450);
    expect(decided).toBeGreaterThan(900);
  }, 300_000);

  it('a line that ends at a soft hyphen is as wide as the model says, the hyphen included: never short, at most 1/32px over', async () => {
    const texts = TEXTS.filter((text) => [...text].every((ch) => /[ \t\n\r]/.test(ch) || inFace(ch)));
    const all = await linesOf(texts);
    const off: string[] = [];
    let hyphens = 0;
    let compared = 0;
    texts.forEach((text, i) => {
      const model = pieces(text);
      const lines = visible(all[i]!);
      const lineAt = spans(text, lines.map((l) => l.text));
      const modelAt = spans(text, model.map((p) => p.text));
      // Each line that is one of the model's pieces (elsewhere the model may keep two of Chromium's lines as one).
      lines.forEach((line, j) => {
        const k = modelAt.findIndex((p) => p.from === lineAt[j]!.from && p.to === lineAt[j]!.to);
        if (k < 0) return;
        compared += 1;
        const piece = model[k]!;
        // The drawn line: a soft hyphen's room on the last line is kept, not drawn (above).
        const drawsHyphen = piece.hyphen && k < model.length - 1;
        if (drawsHyphen) hyphens += 1;
        const px = reasonPx(piece.text, drawsHyphen);
        if (px < line.width - 1e-6 || px > line.width + 1 / 32 + 1e-6) off.push(`${JSON.stringify(piece.text)}${drawsHyphen ? ' + hyphen' : ''}: model ${px}, Chromium ${line.width}`);
      });
    });
    expect(off.slice(0, 30)).toEqual([]);
    expect(compared).toBeGreaterThan(600);
    expect(hyphens).toBeGreaterThan(40);
  }, 300_000);
});

// The tables of what holds to a soft hyphen or a zero-width space depend on the host's fallback fonts: they are held
// to production's image, velo only (`tests/unit/printParity/packBreakTablesImage.test.ts`).
