/**
 * Pure transforms that drive the secondary in-module nav bar.
 *
 * A demoted module (e.g. salesTab) is a Tab whose `items` are FlyoutSections.
 * The secondary bar renders each section as a ModuleNav dropdown tab; a section
 * is "active" when any of its (possibly nested) links matches the current path.
 */
import { isFlyout, type Tab, type NavItem } from './types';
import { pathMatchesHref, hrefSpecificity, moreSpecific } from './activeTab';

import { salesTab } from './sales';
import { purchasesTab } from './purchases';
import { inventoryTab } from './inventory';
import { accountingTab } from './accounting';
import { reportsTab } from './reports';
import { taxTab } from './tax';
import { payrollTab } from './payroll';
import { practiceTab } from './practice';

/** Map from module id → Tab — single source of truth for the secondary nav bar. */
export const MODULE_BY_ID: Record<string, Tab> = {
  sales: salesTab, purchases: purchasesTab, inventory: inventoryTab, accounting: accountingTab,
  reports: reportsTab, tax: taxTab, payroll: payrollTab, practice: practiceTab,
};

/** Each top-level section of a module → a dropdown tab for ModuleNav. */
export function moduleSectionsToTabs(moduleTab: Tab): Tab[] {
  return (moduleTab.items ?? []).map((item): Tab => {
    if (isFlyout(item)) {
      return { id: item.section, label: item.section, items: item.items };
    }
    return { id: item.href, label: item.label, href: item.href };
  });
}

function anyLinkActive(items: NavItem[], asPath: string): boolean {
  return items.some((item) =>
    isFlyout(item) ? anyLinkActive(item.items, asPath) : pathMatchesHref(item.href, asPath),
  );
}

/** A section tab is active when one of its nested links matches the path. */
export function isSectionActive(sectionTab: Tab, asPath: string): boolean {
  if (sectionTab.href) return pathMatchesHref(sectionTab.href, asPath);
  return anyLinkActive(sectionTab.items ?? [], asPath);
}

/** The most specific matching link of a section (see hrefSpecificity), or null when none match. */
function bestMatch(items: NavItem[], asPath: string): [number, number] | null {
  let best: [number, number] | null = null;
  for (const item of items) {
    const found = isFlyout(item)
      ? bestMatch(item.items, asPath)
      : pathMatchesHref(item.href, asPath) ? hrefSpecificity(item.href) : null;
    if (found && (!best || moreSpecific(found, best))) best = found;
  }
  return best;
}

/**
 * Active section id for the whole module bar (or '' when none match). When several sections match, the one
 * holding the most specific link wins and a tie goes to the earlier section: `/accounting/afs/<id>?type=management_pack`
 * is under "All AFS Documents" (`/accounting/afs`) and "Pack Documents" (`/accounting/afs?type=management_pack`).
 */
export function getActiveSectionId(moduleTab: Tab, asPath: string): string {
  let bestId = '';
  let best: [number, number] | null = null;
  for (const tab of moduleSectionsToTabs(moduleTab)) {
    const score = tab.href
      ? (pathMatchesHref(tab.href, asPath) ? hrefSpecificity(tab.href) : null)
      : bestMatch(tab.items ?? [], asPath);
    if (score && (!best || moreSpecific(score, best))) { best = score; bestId = tab.id; }
  }
  return bestId;
}
