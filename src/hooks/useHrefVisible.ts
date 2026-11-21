/**
 * Whether a deep link to a page the nav hides (Payroll without Payroll read) may be offered: the same answer the nav
 * itself uses (`useNavFlags`, so hidden until known and if the check fails). A page that links to a payroll run shows
 * plain text instead of the link when this says no; the API still decides access.
 */
import { hidden, moduleReadFlag } from '@/components/accounting/navSections/flagNav';
import { useNavFlags } from './useNavFlags';

/** `(href) => may the user be offered a link to it`. */
export function useHrefVisible(): (href: string) => boolean {
  const flags = useNavFlags();
  return (href) => !hidden(href, flags);
}

/** Whether the user can read `moduleKey` (one of `NAV_MODULES`) in the active company. */
export function useModuleRead(moduleKey: string): boolean {
  return useNavFlags().has(moduleReadFlag(moduleKey));
}
