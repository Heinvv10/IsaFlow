/**
 * The walk that collects every string a composed page prints, for the
 * glossary filter. Split out of `boardPackPages.ts` for the 300-line cap;
 * the composer is its one caller.
 */
import type { UnnumberedPage } from './packUnnumberedPage';

/**
 * Every string a composed page PRINTS, so a term can be asked whether the
 * document carries it.
 *
 * A recursive walk rather than a per-block reader, for the reason
 * `packReportingEntity.test.ts` gives about the same shape: the word that
 * reached paper last time did so through `navLabel`, which no collector was
 * reading, and the next one will reach it through whichever field the next
 * collector forgets. Chart SVG is excluded because serialised markup is not
 * words a reader reads, and the model's own vocabulary (`kind`, `type`, `id`)
 * because a zrender element is literally `{ type: 'group' }`.
 */
export function printedStrings(page: UnnumberedPage): string[] {
  const out: string[] = [];
  const skip = new Set(['svg', 'sparklineSvg', 'trendSvg', 'bulletSvg', 'kind', 'type', 'id']);
  const walk = (value: unknown): void => {
    if (typeof value === 'string') { out.push(value); return; }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (skip.has(key)) continue;
        walk(inner);
      }
    }
  };
  walk({ title: page.title, navLabel: page.navLabel, blocks: page.blocks, footnotes: page.footnotes });
  return out;
}
