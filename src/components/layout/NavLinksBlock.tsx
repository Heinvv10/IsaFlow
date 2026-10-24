/**
 * The plain direct links of a nav tab (`Tab.links`) followed by a separator.
 * Shared by ModuleNav and SidebarNav so the two renderers cannot drift; each
 * supplies its own link and separator classes.
 */

import Link from 'next/link';
import { isLinkActive, type DropdownItem } from '../accounting/accountingNavConfig';

interface NavLinksBlockProps {
  links: DropdownItem[] | undefined;
  asPath: string;
  onNav: () => void;
  linkClassName: (active: boolean) => string;
  separatorClassName: string;
}

export function NavLinksBlock({ links, asPath, onNav, linkClassName, separatorClassName }: NavLinksBlockProps) {
  if (!links || links.length === 0) return null;
  return (
    <>
      {links.map(item => (
        <Link key={item.href} href={item.href} onClick={onNav} className={linkClassName(isLinkActive(item.href, asPath))}>
          {item.label}
        </Link>
      ))}
      <div className={separatorClassName} />
    </>
  );
}
