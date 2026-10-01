/**
 * Reading a rendered bridge back off its SVG: the plot's clip rectangle, the
 * bars, and the figures printed on or beside them. Shared by the tests that
 * hold bridge labels to the rectangle ECharts actually drew.
 */
import { DEFAULT_CHART_PALETTE } from '@/modules/accounting/services/packs/packChartOptions';

export interface ClipRect { top: number; bottom: number; height: number }
export interface Bar { centre: number; top: number; bottom: number; fill: string; left?: number; right?: number }
/**
 * A figure: zrender sets it on `dominant-baseline: central`, so `y` is its
 * middle. `px` is the size it is set at, `halo` how far its paper halo
 * reaches beyond its glyphs (0 for a figure inside its bar).
 */
export interface Figure { x: number; y: number; text: string; fill: string; px: number; halo: number }

export const FIGURE_PX = 12;

/** The clip rectangle on both axes — the plot ECharts drew. */
export function clipBox(svg: string): { left: number; right: number; top: number; bottom: number } {
  const m = /<clipPath[^>]*>\s*<path d="M([-\d.]+) ([-\d.]+)l([-\d.]+) 0l0 ([-\d.]+)/.exec(svg);
  if (m === null) throw new Error('the SVG carries no clip rectangle');
  return { left: Number(m[1]), right: Number(m[1]) + Number(m[3]), top: Number(m[2]), bottom: Number(m[2]) + Number(m[4]) };
}

export function clipRect(svg: string): ClipRect {
  const m = /<clipPath[^>]*>\s*<path d="M[-\d.]+ ([-\d.]+)l[-\d.]+ 0l0 ([-\d.]+)/.exec(svg);
  if (m === null) throw new Error('the SVG carries no clip rectangle');
  const top = Number(m[1]);
  const height = Number(m[2]);
  return { top, bottom: top + height, height };
}

/** Everything drawn inside the clipped group — the custom series. */
function plotted(svg: string): string {
  const at = svg.indexOf('<g clip-path');
  return at < 0 ? '' : svg.slice(at);
}

export function bars(svg: string): Bar[] {
  const all = [...plotted(svg).matchAll(/<path d="M([-\d.]+) ([-\d.]+)l([-\d.]+) 0l0 ([-\d.]+)l[-\d.]+ 0Z"[^>]*fill="([^"]+)"/g)]
    .map((m) => ({
      centre: Number(m[1]) + Number(m[3]) / 2,
      top: Number(m[2]),
      bottom: Number(m[2]) + Number(m[4]),
      width: Number(m[3]),
      fill: m[5]!.toLowerCase(),
    }));
  // Not the paper ground under an outside figure, and not the plot-wide rect
  // the clip path itself is drawn as.
  const widest = Math.max(...all.map((r) => r.width));
  return all
    .filter((r) => r.fill !== DEFAULT_CHART_PALETTE.paper.toLowerCase() && r.width < widest)
    .map(({ centre, top, bottom, fill, width }) => ({ centre, top, bottom, fill, left: centre - width / 2, right: centre + width / 2 }));
}

/**
 * The figures, in step order. A figure's halo is painted as a pass of its own
 * — the same text, stroked in paper with no fill, under every figure's fill —
 * so those texts are read as the halo of the figure they sit behind, not as
 * figures.
 */
export function figures(svg: string): Figure[] {
  const texts = painted(svg).filter((m) => m.kind === 'text');
  const halos = texts.filter((m) => m.fill === 'none');
  return texts.filter((m) => m.fill !== 'none').map((m) => ({
    x: m.x, y: m.y, text: m.text, fill: m.fill, px: m.px,
    halo: Math.max(m.stroke, ...halos.filter((h) => h.text === m.text && Math.abs(h.x - m.x) < 0.01 && Math.abs(h.y - m.y) < 0.01).map((h) => h.stroke)) / 2,
  }));
}

/**
 * Whether every halo is painted before every figure's fill — the order that
 * makes it impossible for one figure's halo to erase another's digits — and
 * how many halo passes there are.
 */
export function haloOrder(svg: string): { halos: number; allBeneath: boolean } {
  const texts = painted(svg).filter((m) => m.kind === 'text');
  const lastHalo = texts.map((m) => m.fill === 'none').lastIndexOf(true);
  const firstFill = texts.findIndex((m) => m.fill !== 'none');
  return { halos: texts.filter((m) => m.fill === 'none').length, allBeneath: lastHalo < firstFill };
}

/** The bar a figure belongs to: the one centred under it. */
export function barOf(svg: string, figure: Figure): Bar | undefined {
  return bars(svg).find((b) => Math.abs(b.centre - figure.x) < 2);
}

/**
 * Whether a figure is on the wrong side of its bar's base: below a rising
 * bar's foot, or above a falling bar's head. On or inside the bar is not.
 */
export function wrongSide(figure: Figure, bar: Bar, rises: boolean): boolean {
  return rises
    ? figure.y - figure.px / 2 > bar.bottom + 0.01
    : figure.y + figure.px / 2 < bar.top - 0.01;
}

export function outsideClip(figure: Figure, clip: ClipRect): boolean {
  return figure.y - figure.px / 2 < clip.top - 0.01 || figure.y + figure.px / 2 > clip.bottom + 0.01;
}

/** Whether a figure sits over its own bar — any overlap with the fill. */
export function overOwnBar(figure: Figure, bar: Bar): boolean {
  return Math.min(figure.y + figure.px / 2, bar.bottom) - Math.max(figure.y - figure.px / 2, bar.top) > 0.5;
}

/**
 * Whether a figure is part on its own bar and part off it — the state the
 * renderer may never draw where the layout had a box to reserve room in. A
 * figure wholly inside the bar, or wholly clear of it, is not.
 */
export function straddlesOwnBar(figure: Figure, bar: Bar): boolean {
  const { left, right, top, bottom } = boxOf(figure);
  const [barLeft, barRight] = [bar.left ?? -Infinity, bar.right ?? Infinity];
  const touches = Math.min(bottom, bar.bottom) - Math.max(top, bar.top) > 0.5 && Math.min(right, barRight) - Math.max(left, barLeft) > 0.5;
  const within = top >= bar.top - 0.5 && bottom <= bar.bottom + 0.5 && left >= barLeft - 0.5 && right <= barRight + 0.5;
  return touches && !within;
}

// ── LEGIBILITY, MEASURED OFF WHAT IS PAINTED ────────────────────────────────
//
// Not a restatement of the renderer's rule: for every glyph of every figure,
// what the SVG paints UNDER it in document order (bars, paper grounds, else
// paper), what it paints OVER it afterwards, and whether the plot's clip
// rectangle cuts it. A text's own paper halo is not counted as a ground.

/** IBM Plex Sans advances per 1000 em, read off the face's `hmtx` — the
 *  browser's widths, independent of every ruler production measures with. */
function advance(ch: string): number {
  if (/\d/.test(ch)) return 600;
  if (ch === '(' || ch === ')') return 335;
  if (/\s/.test(ch)) return 236;
  if (ch === '.' || ch === ',') return 272;
  if (ch === '\u2013') return 588;
  return 600;
}

export interface GlyphCell { ch: string; left: number; right: number }

export function glyphCells(text: string, centre: number, px = FIGURE_PX): GlyphCell[] {
  const widths = [...text].map((ch) => (advance(ch) * px) / 1000);
  let x = centre - widths.reduce((a, b) => a + b, 0) / 2;
  return [...text].map((ch, i) => { const cell = { ch, left: x, right: x + widths[i]! }; x += widths[i]!; return cell; });
}

/** A figure's glyph box: its advances wide, its type size tall. */
export function boxOf(figure: Figure): { left: number; right: number; top: number; bottom: number } {
  const cells = glyphCells(figure.text, figure.x, figure.px);
  return { left: cells[0]?.left ?? figure.x, right: cells[cells.length - 1]?.right ?? figure.x, top: figure.y - figure.px / 2, bottom: figure.y + figure.px / 2 };
}

/**
 * TEXT ON TEXT. Every pair of figures where one's glyph box meets the
 * other's glyph box or its halo — the halo counts because a paper stroke
 * painted over a neighbour's digits erases them: "(54 884 558)" printed as
 * "(54 884 5". Geometry alone, whatever the paint order.
 */
export function textOnText(svg: string): string[] {
  const all = figures(svg);
  const out: string[] = [];
  for (let a = 0; a < all.length; a += 1) for (let b = a + 1; b < all.length; b += 1) {
    const [A, B] = [boxOf(all[a]!), boxOf(all[b]!)];
    const reach = Math.max(all[a]!.halo, all[b]!.halo);
    const apart = Math.max(A.left - B.right, B.left - A.right, A.top - B.bottom, B.top - A.bottom);
    if (apart < reach - 0.01) out.push(`"${all[a]!.text}" and "${all[b]!.text}" are ${apart.toFixed(1)}px apart, with a ${reach}px halo`);
  }
  return out;
}

const channel = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
/** WCAG contrast ratio of two `#rrggbb` colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

interface Painted { kind: 'rect' | 'text'; left: number; right: number; top: number; bottom: number; fill: string; text: string; x: number; y: number; px: number; /** A text's stroke width. */ stroke: number }

/** Everything the clipped group paints, in document order. */
function painted(svg: string): Painted[] {
  const at = svg.indexOf('<g clip-path');
  const group = at < 0 ? '' : svg.slice(at, svg.indexOf('</g>', at));
  const out: Painted[] = [];
  for (const m of group.matchAll(/<path d="M([-\d.]+) ([-\d.]+)l([-\d.]+) 0l0 ([-\d.]+)l[-\d.]+ 0Z"[^>]*fill="([^"]+)"|<text([^>]*)>([^<]*)<\/text>/g)) {
    if (m[1] !== undefined) {
      const [x, y, w, h] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
      out.push({ kind: 'rect', left: x, right: x + w, top: y, bottom: y + h, fill: m[5]!.toLowerCase(), text: '', x: 0, y: 0, px: 0, stroke: 0 });
    } else {
      const attr = (name: string) => new RegExp(`\\s${name}="([^"]+)"`).exec(m[6]!)?.[1] ?? '';
      const text = m[7]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      out.push({
        kind: 'text', left: 0, right: 0, top: 0, bottom: 0, fill: attr('fill').toLowerCase(), text, x: Number(attr('x')), y: Number(attr('y')),
        px: Number(/font-size:([\d.]+)px/.exec(m[6]!)?.[1] ?? FIGURE_PX), stroke: attr('stroke') === '' || attr('stroke') === 'none' ? 0 : Number(attr('stroke-width') || 1),
      });
    }
  }
  return out;
}

export interface LostGlyph { figure: string; /** Which figure, in step order. */ nth: number; glyph: string; index: number; reason: 'clipped' | 'occluded' | 'contrast' | 'overprinted'; detail: string }

/** Where a glyph is sampled: across its cell, and over the digit band about
 *  its centre line, a third of the type size either way. */
const ACROSS = [0.15, 0.5, 0.85];
const MIN_CONTRAST = 3;

/**
 * Every glyph of every bridge figure that cannot be read: cut by the plot's
 * clip rectangle or the SVG's edge, painted over by a later mark — a bar, a
 * ground, another figure's glyphs, or another figure's halo painted after
 * it — or set on a fill it does not reach 3:1 against. `share` is how much of a glyph must be
 * lost to count — any of it by default.
 */
export function lostGlyphs(svg: string, share = 0): LostGlyph[] {
  const plot = clipBox(svg);
  // The plot's clip, and the SVG's own edge: ECharts can lay a plot out past
  // the edge of a chart too narrow for its gutters.
  const size = /<svg[^>]*\swidth="([\d.]+)"[^>]*\sheight="([\d.]+)"/.exec(svg);
  const clip = {
    left: Math.max(plot.left, 0), top: Math.max(plot.top, 0),
    right: Math.min(plot.right, size === null ? Infinity : Number(size[1])),
    bottom: Math.min(plot.bottom, size === null ? Infinity : Number(size[2])),
  };
  const paper = DEFAULT_CHART_PALETTE.paper.toLowerCase();
  const marks = painted(svg);
  const out: LostGlyph[] = [];
  let nth = -1;
  marks.forEach((mark, order) => {
    if (mark.kind !== 'text' || mark.fill === 'none') return;
    nth += 1;
    const which = nth;
    // Another figure's glyphs anywhere, or its stroke painted after this fill.
    const others = marks.flatMap((other, at) => {
      if (other.kind !== 'text' || other === mark || (other.text === mark.text && other.x === mark.x && other.y === mark.y)) return [];
      const reach = at > order ? other.stroke / 2 : 0;
      if (other.fill === 'none' && reach === 0) return [];
      const cells = glyphCells(other.text, other.x, other.px);
      return [{ left: cells[0]!.left - reach, right: cells[cells.length - 1]!.right + reach, top: other.y - other.px / 2 - reach, bottom: other.y + other.px / 2 + reach }];
    });
    glyphCells(mark.text, mark.x, mark.px).forEach((cell, index) => {
      if (/\s/.test(cell.ch)) return;
      const tally = { clipped: 0, occluded: 0, contrast: 0, overprinted: 0 };
      let detail = '';
      for (const fx of ACROSS) for (const dy of [-mark.px / 3, 0, mark.px / 3]) {
        const px = cell.left + fx * (cell.right - cell.left);
        const py = mark.y + dy;
        const on = (r: Painted) => r.kind === 'rect' && px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
        if (px < clip.left || px > clip.right || py < clip.top || py > clip.bottom) { tally.clipped += 1; continue; }
        if (others.some((o) => px >= o.left && px <= o.right && py >= o.top && py <= o.bottom)) { tally.overprinted += 1; continue; }
        if (marks.slice(order + 1).some(on)) { tally.occluded += 1; continue; }
        const under = marks.slice(0, order).reverse().find(on)?.fill ?? paper;
        if (contrast(mark.fill, under) < MIN_CONTRAST) { tally.contrast += 1; detail = `${mark.fill} on ${under}`; }
      }
      const samples = ACROSS.length * 3;
      const lost = tally.clipped + tally.occluded + tally.contrast + tally.overprinted;
      if (lost === 0 || lost / samples < share) return;
      const reason = (Object.entries(tally).sort((a, b) => b[1] - a[1])[0]![0]) as LostGlyph['reason'];
      out.push({ figure: mark.text, nth: which, glyph: cell.ch, index, reason, detail });
    });
  });
  return out;
}

/** The lost glyphs as sentences, for an assertion's message. */
export function illegible(svg: string): string[] {
  return lostGlyphs(svg).map((g) => `"${g.figure}" loses "${g.glyph}" (${g.reason}${g.detail ? `: ${g.detail}` : ''})`);
}
