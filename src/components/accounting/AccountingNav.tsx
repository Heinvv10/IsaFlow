/**
 * Sage-style horizontal navigation bar for accounting pages.
 * Delegates to ModuleNav with teal accent colors.
 */

import { ModuleNav } from '../layout/ModuleNav';
import { TABS, getActiveTabId } from './accountingNavConfig';
import { stripVatNav } from './navSections/vatNav';
import { stripFlagNav } from './navSections/flagNav';
import { useVatRegistration } from '@/hooks/useVatRegistration';
import { useNavFlags } from '@/hooks/useNavFlags';

export function AccountingNav() {
  const { isRegistered } = useVatRegistration();
  const flags = useNavFlags();
  return <ModuleNav tabs={stripFlagNav(stripVatNav(TABS, isRegistered), flags)} getActiveTabId={getActiveTabId} accentColor="teal" ariaLabel="Main" />;
}
