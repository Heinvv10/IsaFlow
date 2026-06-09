/**
 * Secondary in-module nav bar. Rendered under the primary nav while the user
 * is inside a demoted module (Sales, Purchases, …). Reuses ModuleNav with a
 * subordinate accent, presenting that module's sections as dropdown tabs.
 */
import { useRouter } from 'next/router';
import { ModuleNav } from '@/components/layout/ModuleNav';
import { moduleSectionsToTabs, getActiveSectionId } from './navSections/secondaryNav';
import type { Tab } from './navSections/types';

import { salesTab } from './navSections/sales';
import { purchasesTab } from './navSections/purchases';
import { inventoryTab } from './navSections/inventory';
import { accountingTab } from './navSections/accounting';
import { reportsTab } from './navSections/reports';
import { taxTab } from './navSections/tax';
import { payrollTab } from './navSections/payroll';
import { practiceTab } from './navSections/practice';

const MODULE_BY_ID: Record<string, Tab> = {
  sales: salesTab, purchases: purchasesTab, inventory: inventoryTab, accounting: accountingTab,
  reports: reportsTab, tax: taxTab, payroll: payrollTab, practice: practiceTab,
};

export function SecondaryModuleNav({ moduleId }: { moduleId: string }) {
  const router = useRouter();
  const moduleTab = MODULE_BY_ID[moduleId];
  if (!moduleTab) return null;

  const tabs = moduleSectionsToTabs(moduleTab);
  const activeId = getActiveSectionId(moduleTab, router.asPath);

  return (
    <div className="border-b border-gray-200 dark:border-gray-800 bg-[var(--ff-canvas-mid)]">
      <div className="flex items-center gap-2 px-4 text-xs font-semibold uppercase tracking-wide text-[var(--ff-text-tertiary)]">
        <span className="py-2">{moduleTab.label}</span>
        <ModuleNav tabs={tabs} getActiveTabId={() => activeId} accentColor="slate" />
      </div>
    </div>
  );
}
