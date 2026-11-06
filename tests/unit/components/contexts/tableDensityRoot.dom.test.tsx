/**
 * DG: the density toggle drives ONE root switch (html[data-density]) and the compact rule in
 * styles/globals.css reaches every table except the exempt ones. Selector semantics are checked
 * with the browser's own `matches` (jsdom), against the real rule text from globals.css.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { act, render, screen } from '@testing-library/react';
import { TableDensityProvider } from '@/contexts/TableDensityContext';
import { TableDensityToggle } from '@/components/ui/TableDensityToggle';

// The real density block of globals.css, plus the two Tailwind utilities the fixtures use (Tailwind is not
// compiled in jsdom). The compact rule out-specifies a utility class, so these tests exercise the real cascade.
const css = readFileSync('styles/globals.css', 'utf8');
const densityBlock = css.slice(css.indexOf('/* ── Table density'));
const utilities = '.py-3{padding-top:.75rem;padding-bottom:.75rem}.py-2{padding-top:.5rem;padding-bottom:.5rem}.py-8{padding-top:2rem;padding-bottom:2rem}';

beforeAll(() => {
  const style = document.createElement('style');
  style.id = 'density-test-css';
  style.textContent = utilities + densityBlock;
  document.head.appendChild(style);
});

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.density;
  document.body.innerHTML = '';
});

describe('root density switch', () => {
  it('follows the toggle and storage', async () => {
    localStorage.setItem('isaflow.tableDensity', 'compact');
    render(<TableDensityProvider><TableDensityToggle /></TableDensityProvider>);
    expect(document.documentElement.dataset.density).toBe('compact');
    await act(async () => { screen.getByLabelText(/Comfortable/).click(); });
    expect(document.documentElement.dataset.density).toBe('comfortable');
    expect(localStorage.getItem('isaflow.tableDensity')).toBe('comfortable');
  });
});

const pad = (id: string) => {
  const cs = getComputedStyle(document.getElementById(id)!);
  return [cs.paddingTop, cs.paddingBottom];
};
const mount = (html: string, density: 'compact' | 'comfortable') => {
  document.documentElement.dataset.density = density;
  document.body.innerHTML = html;
};
const ROW = '<tr><td id="c" class="px-4 py-3">x</td></tr>';

describe('compact rule reach (computed style)', () => {
  it('shrinks an ordinary data cell to 4 px and a header cell to 8 px only under compact', () => {
    const html = `<table><thead><tr><th id="h" class="py-3">h</th></tr></thead><tbody>${ROW}</tbody></table>`;
    mount(html, 'compact');
    expect(pad('c')).toEqual(['4px', '4px']);
    expect(pad('h')).toEqual(['8px', '8px']);
    mount(html, 'comfortable');
    expect(pad('c')).toEqual(['12px', '12px']);
    expect(pad('h')).toEqual(['12px', '12px']);
  });

  it('keeps an empty-state colspan cell and an explicitly padded cell as authored', () => {
    mount('<table><tbody><tr><td id="e" colspan="4" class="py-8">none</td></tr><tr><td id="e2" colspan="2" class="py-3">none</td></tr><tr><td id="p" class="py-8">x</td></tr></tbody></table>', 'compact');
    expect(pad('e')).toEqual(['32px', '32px']);
    expect(pad('e2')).toEqual(['12px', '12px']);
    expect(pad('p')).toEqual(['32px', '32px']);
  });

  it.each([['data-density-exempt'], ['role="grid"']])('spares a table marked %s', (attr) => {
    mount(`<table ${attr}><tbody>${ROW}</tbody></table>`, 'compact');
    expect(pad('c')).toEqual(['12px', '12px']);
  });

  it('spares an exempt table nested inside an ordinary one, and still shrinks the outer cell', () => {
    mount('<table><tbody><tr><td id="o" class="py-3"><table data-density-exempt><tbody><tr><td id="n" class="py-3">n</td></tr></tbody></table></td></tr></tbody></table>', 'compact');
    expect(pad('n')).toEqual(['12px', '12px']);
    expect(pad('o')).toEqual(['4px', '4px']);
  });

  it('shrinks a py-2 data cell too, but leaves a py-2 header cell (already 8 px)', () => {
    mount('<table><thead><tr><th id="h2" class="py-2">h</th></tr></thead><tbody><tr><td id="d2" class="py-2">x</td></tr></tbody></table>', 'compact');
    expect(pad('d2')).toEqual(['4px', '4px']);
    expect(pad('h2')).toEqual(['8px', '8px']);
  });

  it('reaches a table whose rows sit directly under <table>', () => {
    mount(`<table>${ROW}</table>`, 'compact');
    expect(pad('c')).toEqual(['4px', '4px']);
  });
});

describe('no flash on hydration', () => {
  const script = readFileSync('public/density-init.js', 'utf8');
  const runScript = () => new Function(script)();

  it('density-init.js marks compact before first paint and leaves comfortable unmarked', () => {
    runScript();
    expect(document.documentElement.dataset.density).toBeUndefined();
    localStorage.setItem('isaflow.tableDensity', 'compact');
    runScript();
    expect(document.documentElement.dataset.density).toBe('compact');
  });

  it('the provider never overwrites the pre-paint mark with its comfortable default', () => {
    localStorage.setItem('isaflow.tableDensity', 'compact');
    document.documentElement.dataset.density = 'compact';
    const obs = new MutationObserver(() => undefined);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-density'], attributeOldValue: true });
    render(<TableDensityProvider><TableDensityToggle /></TableDensityProvider>);
    const overwritten = obs.takeRecords().map((r) => r.oldValue);
    obs.disconnect();
    // a record's oldValue is what the attribute held before that write: 'comfortable' means it was set to it
    expect(overwritten).not.toContain('comfortable');
    expect(document.documentElement.dataset.density).toBe('compact');
  });

  it('_document loads density-init.js', () => {
    expect(readFileSync('pages/_document.tsx', 'utf8')).toContain('src="/density-init.js"');
  });
});
