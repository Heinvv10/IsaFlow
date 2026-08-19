/**
 * Secondary in-module nav bar. Rendered under the primary nav while the user
 * is inside a demoted module (Sales, Purchases, …). Reuses ModuleNav with a
 * subordinate accent, presenting that module's sections as dropdown tabs.
 */
import { useRouter } from 'next/router';
import { ModuleNav } from '@/components/layout/ModuleNav';
import { moduleSectionsToTabs, getActiveSectionId, MODULE_BY_ID } from './navSections/secondaryNav';
import { stripVatNav } from './navSections/vatNav';
import { useVatRegistration } from '@/hooks/useVatRegistration';

export function SecondaryModuleNav({ moduleId }: { moduleId: string }) {
  const router = useRouter();
  const { isRegistered } = useVatRegistration();
  const moduleTab = MODULE_BY_ID[moduleId];
  if (!moduleTab) return null;

  const tabs = stripVatNav(moduleSectionsToTabs(moduleTab), isRegistered);
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
