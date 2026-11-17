/**
 * Cash flow forecast URLs (cash13 PR 3, Hein 2026-11-16): the menu's "Cash Flow Forecast" opens the one page with
 * the 13-week and AI tabs at /accounting/reports/cash-flow-forecast; the monthly forecast keeps its own page at
 * /accounting/cash-flow-forecast (registry row, no menu link). Both light Reports and are titled under it.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TABS, settingsTab } from '@/components/accounting/accountingNavConfig';
import { buildNavIndex } from '@/components/accounting/navSections/navIndex';
import { buildPageIndex } from '@/components/accounting/navSections/pageRegistry';
import { getActiveModuleId } from '@/components/accounting/navSections/activeTab';
import { documentTitle } from '@/components/layout/shellRoutes';

const PAGE = '/accounting/reports/cash-flow-forecast';
const MONTHLY = '/accounting/cash-flow-forecast';

describe('cash flow forecast navigation', () => {
  const menu = buildNavIndex([...TABS, settingsTab], true);

  it('the menu links "Cash Flow Forecast" to the tabbed page only', () => {
    const links = menu.filter((e) => e.label === 'Cash Flow Forecast').map((e) => e.href);
    expect(links).toEqual([PAGE]);
    expect(menu.some((e) => e.href === MONTHLY)).toBe(false);
  });

  it('both pages exist', () => {
    for (const href of [PAGE, MONTHLY]) expect(fs.existsSync(path.join(process.cwd(), 'pages', `${href}.tsx`))).toBe(true);
  });

  it('both light Reports, the AI tab too', () => {
    expect(getActiveModuleId(PAGE, {})).toBe('reports');
    expect(getActiveModuleId(PAGE, { tab: 'ai' })).toBe('reports');
    expect(getActiveModuleId(MONTHLY, {})).toBe('reports');
  });

  it('both are titled under Reports', () => {
    const idx = buildPageIndex(true);
    expect(documentTitle(PAGE, idx)).toBe('Cash Flow Forecast · Reports · IsaFlow');
    expect(documentTitle(MONTHLY, idx)).toBe('Cash Flow Forecast · Reports · IsaFlow');
  });
});
