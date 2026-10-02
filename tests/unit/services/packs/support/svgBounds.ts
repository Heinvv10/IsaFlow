/**
 * What a chart paints outside its own SVG: every text's box and every
 * rectangle, held to the SVG's width and height.
 */
import { format } from 'echarts/core';
import { PACK_FONT_STACK } from '@/lib/charts/packFont';

const unesc = (s: string) => s.replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** What a chart paints outside its own SVG, as sentences. */
export function outsideSvg(svg: string): string[] {
  const size = /<svg width="([\d.]+)" height="([\d.]+)"/.exec(svg)!;
  const [W, H] = [Number(size[1]), Number(size[2])];
  const out: string[] = [];
  for (const m of svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)) {
    const attrs = m[1]!;
    // A rotated name: its own test (`packLegacyBridgeContainment`) holds it.
    if (/transform="matrix/.test(attrs)) continue;
    const t = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(attrs);
    const num = (name: string) => Number(new RegExp(`\\s${name}="([-\\d.]+)"`).exec(attrs)?.[1] ?? 0);
    const px = Number(/font-size:([\d.]+)px/.exec(attrs)?.[1] ?? 12);
    const x = Number(t?.[1] ?? 0) + num('x');
    const y = Number(t?.[2] ?? 0) + num('y');
    const text = unesc(m[2]!);
    const width = format.getTextRect(text.replace(/\s/g, ' '), `${px}px ${PACK_FONT_STACK}`).width;
    const anchor = /text-anchor="(\w+)"/.exec(attrs)?.[1];
    const left = anchor === 'end' ? x - width : anchor === 'middle' ? x - width / 2 : x;
    // `dominant-baseline: central`: y is the middle of the line.
    if (y - px / 2 < -0.5 || y + px / 2 > H + 0.5) out.push(`"${text}" spans y ${(y - px / 2).toFixed(1)} to ${(y + px / 2).toFixed(1)} of ${H}`);
    if (left < -0.5 || left + width > W + 0.5) out.push(`"${text}" spans x ${left.toFixed(1)} to ${(left + width).toFixed(1)} of ${W}`);
  }
  // The clip path's own rectangle is not painted.
  const body = svg.replace(/<clipPath[\s\S]*?<\/clipPath>/g, '');
  for (const m of body.matchAll(/<path d="M([-\d.]+) ([-\d.]+)l([-\d.]+) 0l0 ([-\d.]+)l[-\d.]+ 0Z"([^>]*)>/g)) {
    // Not a rectangle with nothing in it — zrender emits those for layout.
    if (/fill="(none|transparent)"/.test(m[5]!) && !/stroke="#/.test(m[5]!)) continue;
    const t = /transform="translate\(([-\d.]+) ([-\d.]+)\)"/.exec(m[5]!);
    const [x, y, w, h] = [Number(m[1]) + Number(t?.[1] ?? 0), Number(m[2]) + Number(t?.[2] ?? 0), Number(m[3]), Number(m[4])];
    if (x < -0.5 || y < -0.5 || x + w > W + 0.5 || y + h > H + 0.5) out.push(`a rectangle at ${x},${y} ${w}x${h} leaves ${W}x${H}`);
  }
  return out;
}
