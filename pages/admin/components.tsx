/**
 * Component Showcase — ISAFlow living design system.
 * Renders all 15 UI primitives with every variant, size, and state.
 */

import { useState } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import {
  Button, Input, Badge, Card, Tooltip, LoadingSpinner, ToastProvider,
} from '@/components/ui';
import {
  Download, Plus, Trash2, Search, Mail, Eye,
  CheckCircle, Palette, Moon, Sun,
} from 'lucide-react';

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

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const TOTAL_BUILT = 16;
const TOTAL_PLANNED = 21; // Next target: Checkbox, RadioGroup, Switch, Alert, Table, Pagination

const NAV_SECTIONS = [
  { label: 'Primitives', items: ['Button', 'Input', 'Badge', 'Card', 'Tooltip', 'Loading'] },
  { label: 'Feedback', items: ['Modal', 'Toast', 'EmptyState', 'Skeleton', 'ProgressBar'] },
  { label: 'Navigation', items: ['Breadcrumb', 'Tabs', 'Drawer'] },
  { label: 'Data', items: ['Avatar', 'Select'] },
];

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function Section({ id, title, description, children }: {
  id: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-8">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</p>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
        {label}
      </p>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ComponentShowcasePage() {
  const [darkMode, setDarkMode] = useState(false);
  const [activeSection, setActiveSection] = useState('Button');
  const [loadingDemo, setLoadingDemo] = useState(false);

  const simulateLoading = () => {
    setLoadingDemo(true);
    setTimeout(() => setLoadingDemo(false), 2000);
  };

  return (
    <div className={darkMode ? 'dark' : ''}>
      <AdminLayout title="Component Library">
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
                    <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">
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
                    ISAFlow shared primitives — PRD-2026-04-003
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

                {/* ── Button ── */}
                <Section id="Button" title="Button" description="Primary interactive element. Supports variants, sizes, icons, and loading state.">
                  <Row label="Variants">
                    <Button variant="primary">Primary</Button>
                    <Button variant="secondary">Secondary</Button>
                    <Button variant="ghost">Ghost</Button>
                    <Button variant="danger">Danger</Button>
                  </Row>
                  <Row label="Sizes">
                    <Button size="sm">Small</Button>
                    <Button size="md">Medium</Button>
                    <Button size="lg">Large</Button>
                  </Row>
                  <Row label="With icons">
                    <Button leftIcon={Plus} size="sm">New Invoice</Button>
                    <Button rightIcon={Download}>Export</Button>
                    <Button variant="danger" leftIcon={Trash2}>Delete</Button>
                  </Row>
                  <Row label="States">
                    <Button disabled>Disabled</Button>
                    <Button loading={loadingDemo} onClick={simulateLoading}>
                      {loadingDemo ? 'Saving…' : 'Save (click me)'}
                    </Button>
                  </Row>
                </Section>

                {/* ── Input ── */}
                <Section id="Input" title="Input" description="Form text field with label, validation states, helper text, and icon slots.">
                  <Row label="Variants">
                    <div className="w-56"><Input label="Default" placeholder="Enter value" /></div>
                    <div className="w-56"><Input label="Error state" inputVariant="error" defaultValue="bad@" error="Invalid email address" /></div>
                    <div className="w-56"><Input label="Success state" inputVariant="success" defaultValue="valid@example.com" helperText="Email looks good" /></div>
                  </Row>
                  <Row label="Sizes">
                    <div className="w-44"><Input size="sm" placeholder="Small" /></div>
                    <div className="w-44"><Input size="md" placeholder="Medium" /></div>
                    <div className="w-44"><Input size="lg" placeholder="Large" /></div>
                  </Row>
                  <Row label="With icons">
                    <div className="w-56"><Input label="Search" leftIcon={Search} placeholder="Search invoices…" /></div>
                    <div className="w-56"><Input label="Email" leftIcon={Mail} rightIcon={Eye} placeholder="user@example.com" /></div>
                  </Row>
                </Section>

                {/* ── Badge ── */}
                <Section id="Badge" title="Badge" description="Status indicator pill. Used for invoice status, payment states, and flags.">
                  <Row label="Variants">
                    <Badge variant="default">Draft</Badge>
                    <Badge variant="success">Paid</Badge>
                    <Badge variant="warning">Pending</Badge>
                    <Badge variant="danger">Overdue</Badge>
                    <Badge variant="info">In Review</Badge>
                    <Badge variant="neutral">Archived</Badge>
                  </Row>
                  <Row label="With dot indicator">
                    <Badge variant="success" dot>Paid</Badge>
                    <Badge variant="danger" dot>Overdue</Badge>
                    <Badge variant="warning" dot>Pending</Badge>
                  </Row>
                  <Row label="Sizes">
                    <Badge size="sm">Small</Badge>
                    <Badge size="md">Medium</Badge>
                  </Row>
                </Section>

                {/* ── Card ── */}
                <Section id="Card" title="Card" description="Surface container with header, body, and footer slots. Supports hover variant.">
                  <Row label="Basic card">
                    <Card className="w-72" header={<p className="font-semibold text-gray-900 dark:text-gray-100">Invoice Summary</p>}>
                      <p className="text-sm text-gray-600 dark:text-gray-400">Total outstanding: R 12,450.00</p>
                    </Card>
                  </Row>
                  <Row label="With compound components">
                    <Card className="w-72" noPadding>
                      <Card.Header title="Sales Report" description="Last 30 days" action={<Badge variant="success">Live</Badge>} />
                      <Card.Body>
                        <p className="text-sm text-gray-600 dark:text-gray-400">Revenue: R 84,200</p>
                      </Card.Body>
                      <Card.Footer>
                        <p className="text-xs text-gray-400">Updated just now</p>
                      </Card.Footer>
                    </Card>
                  </Row>
                  <Row label="Hoverable">
                    <Card className="w-64" hoverable>
                      <p className="text-sm text-gray-700 dark:text-gray-300">Click me — I am hoverable</p>
                    </Card>
                  </Row>
                </Section>

                {/* ── Tooltip ── */}
                <Section id="Tooltip" title="Tooltip" description="CSS-only hover tooltip. No external dependencies. 300 ms reveal delay.">
                  <Row label="Positions">
                    <Tooltip content="Top tooltip" position="top"><Button variant="secondary" size="sm">Top</Button></Tooltip>
                    <Tooltip content="Bottom tooltip" position="bottom"><Button variant="secondary" size="sm">Bottom</Button></Tooltip>
                    <Tooltip content="Left tooltip" position="left"><Button variant="secondary" size="sm">Left</Button></Tooltip>
                    <Tooltip content="Right tooltip" position="right"><Button variant="secondary" size="sm">Right</Button></Tooltip>
                  </Row>
                  <Row label="On icon buttons">
                    <Tooltip content="Download report">
                      <Button variant="ghost" size="sm"><Download size={16} /></Button>
                    </Tooltip>
                    <Tooltip content="Mark as paid" position="right">
                      <Button variant="ghost" size="sm"><CheckCircle size={16} /></Button>
                    </Tooltip>
                  </Row>
                </Section>

                {/* ── LoadingSpinner ── */}
                <Section id="Loading" title="LoadingSpinner" description="Lightweight CSS spinner for async state indicators.">
                  <Row label="Sizes">
                    <LoadingSpinner size="sm" />
                    <LoadingSpinner size="md" />
                    <LoadingSpinner size="lg" />
                  </Row>
                </Section>

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
