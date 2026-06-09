/**
 * Pure transforms that drive the secondary in-module nav bar.
 *
 * A demoted module (e.g. salesTab) is a Tab whose `items` are FlyoutSections.
 * The secondary bar renders each section as a ModuleNav dropdown tab; a section
 * is "active" when any of its (possibly nested) links matches the current path.
 */
import { isFlyout, type Tab, type NavItem } from './types';
import { isLinkActive } from './activeTab';

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
    isFlyout(item) ? anyLinkActive(item.items, asPath) : isLinkActive(item.href, asPath),
  );
}

/** A section tab is active when one of its nested links matches the path. */
export function isSectionActive(sectionTab: Tab, asPath: string): boolean {
  if (sectionTab.href) return isLinkActive(sectionTab.href, asPath);
  return anyLinkActive(sectionTab.items ?? [], asPath);
}

/** Active section id for the whole module bar (or '' when none match). */
export function getActiveSectionId(moduleTab: Tab, asPath: string): string {
  const tabs = moduleSectionsToTabs(moduleTab);
  return tabs.find((t) => isSectionActive(t, asPath))?.id ?? '';
}
