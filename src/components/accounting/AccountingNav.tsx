/**
 * Sage-style horizontal navigation bar for accounting pages.
 * Delegates to ModuleNav with teal accent colors.
 */

import { ModuleNav } from '../layout/ModuleNav';
import { TABS, getActiveTabId } from './accountingNavConfig';
import { stripVatNav } from './navSections/vatNav';
import { useVatRegistration } from '@/hooks/useVatRegistration';

export function AccountingNav() {
  const { isRegistered } = useVatRegistration();
  return <ModuleNav tabs={stripVatNav(TABS, isRegistered)} getActiveTabId={getActiveTabId} accentColor="teal" />;
}
