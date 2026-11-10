/**
 * THE PROSE MODEL'S STYLES ARE THE STYLESHEET'S: every entry of `packProseStyles.PROSE` names the rule its size and its
 * weight are read from, and this reads those rules out of `styles/` and fails where the CSS and the table disagree, so a
 * change to a prose style's size or weight in the stylesheet cannot leave the page model measuring the old one.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROSE } from '@/modules/accounting/services/packs/pages/packProseStyles';

const STYLES = path.resolve(__dirname, '../../../../styles');
const css = readdirSync(STYLES).filter((f) => f.startsWith('pack') && f.endsWith('.css'))
  .map((f) => readFileSync(path.join(STYLES, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');

/** The declarations of every rule whose selector list holds exactly `selector`. */
function declarations(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (!selectors.includes(selector)) continue;
    for (const decl of match[2]!.split(';')) {
      const [prop, ...value] = decl.split(':');
      if (prop !== undefined && value.length > 0) out.set(prop.trim(), value.join(':').trim());
    }
  }
  return out;
}

describe('the prose styles', () => {
  it.each(Object.entries(PROSE))('%s: its size and weight are the ones its rules set', (unused, style) => {
    const size = declarations(style.sizeRule);
    expect(size.size, `no rule ${style.sizeRule} in styles/`).toBeGreaterThan(0);
    expect(size.get('font-size'), `${style.sizeRule} font-size`).toBe(`${style.pt}pt`);
    const weight = declarations(style.weightRule).get('font-weight');
    if (style.weight === 400) expect(weight === undefined || weight === '400' || weight === 'normal', `${style.weightRule} font-weight ${weight}`).toBe(true);
    else expect(weight, `${style.weightRule} font-weight`).toBe(String(style.weight));
  });

  it('a style set at the regular weight takes it from no rule above it: the page sets 400', () => {
    for (const style of Object.values(PROSE)) {
      if (style.weight !== 400) continue;
      expect(declarations(style.sizeRule).get('font-weight') ?? '400', style.sizeRule).toMatch(/^(400|normal)$/);
    }
    expect(declarations('.pack-page').get('font-weight') ?? '400').toMatch(/^(400|normal)$/);
  });
});
