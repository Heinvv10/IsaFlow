/**
 * The plain direct links of a nav tab (`Tab.links`) followed by a separator.
 * Shared by ModuleNav and SidebarNav so the two renderers cannot drift; each
 * supplies its own link and separator classes.
 */

import Link from 'next/link';
import { mostSpecificActiveHref, type DropdownItem } from '../accounting/accountingNavConfig';

interface NavLinksBlockProps {
  links: DropdownItem[] | undefined;
  asPath: string;
  onNav: () => void;
  linkClassName: (active: boolean) => string;
  separatorClassName: string;
}

export function NavLinksBlock({ links, asPath, onNav, linkClassName, separatorClassName }: NavLinksBlockProps) {
  if (!links || links.length === 0) return null;
  const activeHref = mostSpecificActiveHref(links.map(l => l.href), asPath);
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
