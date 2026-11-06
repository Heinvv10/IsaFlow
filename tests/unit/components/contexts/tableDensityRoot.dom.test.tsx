/**
 * DG: the density toggle drives ONE root switch (html[data-density]) and the compact rule in
 * styles/globals.css reaches every table except the exempt ones. Selector semantics are checked
 * with the browser's own `matches` (jsdom), against the real rule text from globals.css.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { act, render, screen } from '@testing-library/react';
import { TableDensityProvider } from '@/contexts/TableDensityContext';
import { TableDensityToggle } from '@/components/ui/TableDensityToggle';

const css = readFileSync('styles/globals.css', 'utf8');
const tdSelector = /^(html\[data-density='compact'\] table:not\([^)]*\) td)\s*\{/m.exec(css)?.[1] ?? '';

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

describe('compact rule reach', () => {
  const cell = (tableAttrs: string) => {
    document.body.innerHTML = `<table ${tableAttrs}><tbody><tr><td id="c">x</td></tr></tbody></table>`;
    return document.getElementById('c')!;
  };

  it('has a compact td rule', () => expect(tdSelector).not.toBe(''));

  it('hits an ordinary list table only under compact', () => {
    document.documentElement.dataset.density = 'compact';
    expect(cell('').matches(tdSelector)).toBe(true);
    document.documentElement.dataset.density = 'comfortable';
    expect(cell('').matches(tdSelector)).toBe(false);
  });

  it.each([['data-density-exempt'], ['role="grid"']])('spares a table marked %s', (attr) => {
    document.documentElement.dataset.density = 'compact';
    expect(cell(attr).matches(tdSelector)).toBe(false);
  });

  it('uses py-1 (4 px) for body cells and py-2 for header cells', () => {
    expect(css).toMatch(/td \{\s*padding-top: 0\.25rem;\s*padding-bottom: 0\.25rem;/);
    expect(css).toMatch(/th \{\s*padding-top: 0\.5rem;\s*padding-bottom: 0\.5rem;/);
  });
});

describe('exempt tables carry the attribute', () => {
  const files = [
    'src/components/accounting/afs/ManagementPackViewer.tsx',
    'src/components/accounting/afs/AfsOverviewTab.tsx',
    'src/components/accounting/afs/AfsNotesTab.tsx',
    'src/components/accounting/statement/StatementGrid.tsx',
  ];
  it.each(files)('every <table in %s is exempt', (f) => {
    const tracked = execSync(`git ls-files ${f}`).toString().trim();
    expect(tracked).toBe(f);
    const tags = readFileSync(f, 'utf8').match(/<table\b[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t).toContain('data-density-exempt');
  });
  it('the budget grid is table[role=grid]', () => {
    expect(readFileSync('src/components/accounting/budgets/workspace/BudgetGrid.tsx', 'utf8')).toMatch(/<table[^>]*role="grid"/);
  });
});
