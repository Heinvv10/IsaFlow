/**
 * Component Showcase — IsaFlow living design system.
 * Renders all 15 UI primitives with every variant, size, and state.
 */

import { useState } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { Button, ToastProvider } from '@/components/ui';
import { Palette, Moon, Sun } from 'lucide-react';

// Showcase section demos (split into sub-files to stay under 300 lines)
import { ModalDemo } from '@/components/showcase/ModalDemo';
import { EmptyStateDemo } from '@/components/showcase/EmptyStateDemo';
import { BreadcrumbDemo } from '@/components/showcase/BreadcrumbDemo';
import { ToastDemo } from '@/components/showcase/ToastDemo';
import { TabsDemo } from '@/components/showcase/TabsDemo';
import { DrawerDemo } from '@/components/showcase/DrawerDemo';
import { SkeletonDemo } from '@/components/showcase/SkeletonDemo';
import { AvatarDemo } from '@/components/showcase/AvatarDemo';
import { ProgressBarDemo } from '@/components/showcase/ProgressBarDemo';
import { SelectDemo } from '@/components/showcase/SelectDemo';
import { FormKitShowcase } from '@/components/admin/FormKitShowcase';
import { PrimitiveDemos } from '@/components/showcase/PrimitiveDemos';
import { Section } from '@/components/showcase/ShowcaseSection';

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const TOTAL_BUILT = 16;
const TOTAL_PLANNED = 21; // Next target: Checkbox, RadioGroup, Switch, Alert, Table, Pagination

const NAV_SECTIONS = [
  { label: 'Primitives', items: ['Button', 'Input', 'Badge', 'Card', 'Tooltip', 'Loading'] },
  { label: 'Feedback', items: ['Modal', 'Toast', 'EmptyState', 'Skeleton', 'ProgressBar'] },
  { label: 'Navigation', items: ['Breadcrumb', 'Tabs', 'Drawer'] },
  { label: 'Data', items: ['Avatar', 'Select', 'FormKit'] },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ComponentShowcasePage() {
  const [darkMode, setDarkMode] = useState(false);
  const [activeSection, setActiveSection] = useState('Button');

  return (
    <div className={darkMode ? 'dark' : ''}>
      <AdminLayout title="Component Library" ownHeading>
        <ToastProvider>
          <div className="flex min-h-screen bg-gray-50 dark:bg-gray-950">

            {/* Sidebar nav */}
            <aside className="sticky top-0 h-screen w-52 shrink-0 overflow-y-auto border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900 p-4">
              <div className="mb-5 flex items-center gap-2">
                <Palette size={18} className="text-teal-600" />
                <span className="font-semibold text-gray-900 dark:text-gray-100 text-sm">Design System</span>
              </div>
              <nav className="space-y-4">
                {NAV_SECTIONS.map((section) => (
                  <div key={section.label}>
                    <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-widest text-gray-600 dark:text-gray-400">
                      {section.label}
                    </p>
                    <div className="space-y-0.5">
                      {section.items.map((item) => (
                        <a
                          key={item}
                          href={`#${item}`}
                          onClick={() => setActiveSection(item)}
                          className={[
                            'block rounded-md px-3 py-2 text-sm transition-colors',
                            activeSection === item
                              ? 'bg-teal-50 text-teal-700 font-medium dark:bg-teal-900/30 dark:text-teal-300'
                              : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800',
                          ].join(' ')}
                        >
                          {item}
                        </a>
                      ))}
                    </div>
                  </div>
                ))}
              </nav>
            </aside>

            {/* Main content */}
            <main className="flex-1 overflow-y-auto p-8">
              {/* Header */}
              <div className="mb-8 flex items-start justify-between">
                <div>
                  <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                    UI Component Library
                  </h1>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    IsaFlow shared primitives — PRD-2026-04-003
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="rounded-full bg-teal-50 px-3 py-1.5 text-xs font-medium text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">
                    {TOTAL_BUILT} of {TOTAL_PLANNED} components built
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    leftIcon={darkMode ? Sun : Moon}
                    onClick={() => setDarkMode((d) => !d)}
                  >
                    {darkMode ? 'Light' : 'Dark'} mode
                  </Button>
                </div>
              </div>

              <div className="space-y-12">

                <PrimitiveDemos />

                {/* ── Modal ── */}
                <Section id="Modal" title="Modal" description="Accessible dialog with portal rendering, focus trap, ESC key, and backdrop click-to-close.">
                  <ModalDemo />
                </Section>

                {/* ── Toast ── */}
                <Section id="Toast" title="Toast" description="Notification system with context provider and useToast() hook. Supports auto-dismiss and persistent variants.">
                  <ToastDemo />
                </Section>

                {/* ── EmptyState ── */}
                <Section id="EmptyState" title="EmptyState" description="Centered empty-state block with icon, title, description, and optional action buttons.">
                  <EmptyStateDemo />
                </Section>

                {/* ── Skeleton ── */}
                <Section id="Skeleton" title="Skeleton" description="Loading placeholder shapes with shimmer animation. Variants: text, heading, avatar, card, table-row.">
                  <SkeletonDemo />
                </Section>

                {/* ── ProgressBar ── */}
                <Section id="ProgressBar" title="ProgressBar" description="Linear progress indicator with configurable value, color, size, and optional percentage label.">
                  <ProgressBarDemo />
                </Section>

                {/* ── Breadcrumb ── */}
                <Section id="Breadcrumb" title="Breadcrumb" description="Accessible breadcrumb navigation with responsive collapsing and two separator styles.">
                  <BreadcrumbDemo />
                </Section>

                {/* ── Tabs ── */}
                <Section id="Tabs" title="Tabs" description="Horizontal tab bar with underline and pill variants, count badges, icons, and URL sync support.">
                  <TabsDemo />
                </Section>

                {/* ── Drawer ── */}
                <Section id="Drawer" title="Drawer" description="Slide-in panel from the right. Portal-based with ESC key, backdrop click-to-close, and smooth animation.">
                  <DrawerDemo />
                </Section>

                {/* ── Avatar ── */}
                <Section id="Avatar" title="Avatar" description="User avatar with image or deterministic initials fallback. Supports size variants and status dots.">
                  <AvatarDemo />
                </Section>

                <FormKitShowcase />
                {/* ── Select ── */}
                <Section id="Select" title="Select" description="Searchable dropdown with keyboard navigation, portal rendering, multi-select, and clearable support.">
                  <SelectDemo />
                </Section>

              </div>
            </main>
          </div>
        </ToastProvider>
      </AdminLayout>
    </div>
  );
}
