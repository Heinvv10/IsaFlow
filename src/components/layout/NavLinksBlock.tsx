/**
 * The plain direct links of a nav tab (`Tab.links`) followed by a separator.
 * Shared by ModuleNav and SidebarNav so the two renderers cannot drift; each
 * supplies its own link and separator classes.
 */

import Link from 'next/link';
import { isFlyout, mostSpecificActiveHref, type DropdownItem, type NavItem } from '../accounting/accountingNavConfig';

interface NavLinksBlockProps {
  links: DropdownItem[] | undefined;
  /**
   * The rest of the tab (sections included). A link only lights when it beats every one of these too, so the
   * Compliance Calendar link does not stay lit on /accounting/sars/submissions, which a section row owns.
   */
  tabItems?: NavItem[];
  asPath: string;
  onNav: () => void;
  linkClassName: (active: boolean) => string;
  separatorClassName: string;
}

function hrefsOf(items: NavItem[]): string[] {
  return items.flatMap(i => (isFlyout(i) ? hrefsOf(i.items) : [i.href]));
}

export function NavLinksBlock({ links, tabItems, asPath, onNav, linkClassName, separatorClassName }: NavLinksBlockProps) {
  if (!links || links.length === 0) return null;
  const activeHref = mostSpecificActiveHref([...links.map(l => l.href), ...hrefsOf(tabItems ?? [])], asPath);
  return (
    <>
      {links.map(item => (
        <Link key={item.href} href={item.href} onClick={onNav} className={linkClassName(item.href === activeHref)}>
          {item.label}
        </Link>
      ))}
      <div className={separatorClassName} />
    </>
  );
}
