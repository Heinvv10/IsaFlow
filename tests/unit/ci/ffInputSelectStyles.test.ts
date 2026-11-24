// `ff-input` and `ff-select` are used in ~75 files (222 uses) and were never defined: the controls rendered with border 0, radius 0 and padding 0 on every
// viewport (measured in the browser, both themes). globals.css defines them in the components layer, so a page's own utilities (w-*, pl-9, px-*, min-h-11) still win.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(path.resolve(__dirname, '../../../styles/globals.css'), 'utf8');

/** The body of the rule whose selector list is exactly `.ff-input, .ff-select`, with the @layer it sits in. */
function ruleAndLayer(): { body: string; layer: string } {
  const at = CSS.search(/\.ff-input,\s*\.ff-select\s*\{/);
  expect(at, '.ff-input, .ff-select rule').toBeGreaterThan(-1);
  const body = CSS.slice(CSS.indexOf('{', at) + 1, CSS.indexOf('}', at));
  const layers = [...CSS.slice(0, at).matchAll(/@layer\s+([\w-]+)\s*\{/g)];
  return { body, layer: layers[layers.length - 1]?.[1] ?? '' };
}

describe('ff-input / ff-select', () => {
  it('are defined, in the components layer (utilities, which come later, still override them)', () => {
    expect(ruleAndLayer().layer).toBe('components');
  });

  it('give the controls a border, a radius and padding (they had none)', () => {
    const { body } = ruleAndLayer();
    expect(body).toMatch(/border:\s*1px solid var\(--ff-border-light\)/);
    expect(body).toMatch(/border-radius:\s*0\.5rem/);
    expect(body).toMatch(/padding:\s*0\.5rem 0\.75rem/);
  });

  it('do not set a width, a height, a colour or a font size: the page and the shell rules own those', () => {
    const { body } = ruleAndLayer();
    for (const prop of ['width', 'height', 'min-height', 'color', 'background', 'font-size']) expect(body, prop).not.toMatch(new RegExp(`(^|[;\\s])${prop}\\s*:`));
  });
});
