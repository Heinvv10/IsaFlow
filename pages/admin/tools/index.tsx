/**
 * Admin Tools Landing Page
 * Overview of available platform tools with navigation cards.
 */

import Link from 'next/link';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { Megaphone, Download, UserCog, Zap, ExternalLink } from 'lucide-react';

interface ToolCard {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action: { label: string; href: string; external?: boolean } | null;
  note?: string;
}

const TOOLS: ToolCard[] = [
  {
    icon: Megaphone,
    title: 'Announcements',
    description:
      'Create and manage platform-wide announcements. Target all users, specific plans, or individual companies. Schedule start/end times and mark messages as dismissible.',
    action: { label: 'Manage Announcements', href: '/admin/tools/announcements' },
  },
  {
    icon: Download,
    title: 'Data Export',
    description:
      'Export all accounting data for any company as a structured JSON file. Includes chart of accounts, customers, suppliers, invoices, journal entries, and bank transactions.',
    action: null,
    note: 'Navigate to Company Detail → click "Export Data" button to download.',
  },
  {
    icon: UserCog,
    title: 'Impersonation',
    description:
      'View the application as a specific company for debugging and support. Generates a 30-minute impersonation token that switches company context in the customer app.',
    action: null,
    note: 'Navigate to Company Detail → click "Impersonate" button to generate a session.',
  },
  {
    icon: Zap,
    title: 'Sage Auto-Import',
    description:
      'Trigger a full Sage Accounting data import for any company. Pulls chart of accounts, customers, suppliers, invoices, and journal entries via the internal REST API.',
    action: {
      label: 'Open Sage Import',
      href: '/accounting/migration/sage-auto',
      external: true,
    },
    note: 'Opens in the customer app — you must be logged in to a company.',
  },
];

export default function AdminToolsPage() {
  return (
    <AdminLayout title="Admin Tools">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Admin Tools</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Platform management tools for super_admin use only.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {TOOLS.map((tool) => {
            const Icon = tool.icon;
            return (
              <div
                key={tool.title}
                className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 flex flex-col gap-3"
              >
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-teal-500/10 rounded-lg">
                    <Icon className="w-5 h-5 text-teal-600 dark:text-teal-400" />
                  </div>
                  <h2 className="text-base font-semibold text-gray-900 dark:text-white">
                    {tool.title}
                  </h2>
                </div>

                <p className="text-sm text-gray-600 dark:text-gray-400 flex-1">
                  {tool.description}
                </p>

                {tool.note && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-3 py-2">
                    {tool.note}
                  </p>
                )}

                {tool.action && (
                  tool.action.external ? (
                    <a
                      href={tool.action.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-sm font-medium text-teal-600 dark:text-teal-400 hover:underline"
                    >
                      {tool.action.label}
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  ) : (
                    <Link
                      href={tool.action.href}
                      className="inline-flex items-center gap-1.5 text-sm font-medium text-teal-600 dark:text-teal-400 hover:underline"
                    >
                      {tool.action.label}
                    </Link>
                  )
                )}
              </div>
            );
          })}
        </div>
      </div>
    </AdminLayout>
  );
}
