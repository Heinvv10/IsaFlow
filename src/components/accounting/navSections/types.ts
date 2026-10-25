export interface DropdownItem {
  label: string;
  href: string;
  /** When true the item renders with a gear icon and a top separator. */
  isSetting?: boolean;
}

export interface FlyoutSection {
  section: string;
  items: NavItem[];
}

export type NavItem = DropdownItem | FlyoutSection;

export function isFlyout(item: NavItem): item is FlyoutSection {
  return 'section' in item;
}

export interface Tab {
  id: string;
  label: string;
  href?: string;
  /** Quick-create actions; SidebarNav renders them as "+ Label". */
  topItems?: DropdownItem[];
  /** Plain daily navigation links, shown above `topItems` and the sections. */
  links?: DropdownItem[];
  items?: NavItem[];
}
