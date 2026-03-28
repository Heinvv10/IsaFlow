/**
 * Sage-style horizontal navigation bar for accounting pages.
 * Delegates to ModuleNav with teal accent colors.
 */

import { ModuleNav } from '../layout/ModuleNav';
import { TABS, getActiveTabId } from './accountingNavConfig';

export function AccountingNav() {
  return <ModuleNav tabs={TABS} getActiveTabId={getActiveTabId} accentColor="teal" />;
}
