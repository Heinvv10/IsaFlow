/**
 * QuickActionsWidget — Grid of action buttons for common accounting tasks.
 * // WORKING: Navigation-only widget, no data fetch needed.
 */

import Link from 'next/link';
import { FileText, Receipt, CreditCard, BookOpen, Upload, Users } from 'lucide-react';
import { Card } from '@/components/ui/Card';

interface QuickAction {
  label: string;
  href: string;
  icon: React.ElementType;
  color: string;
  bg: string;
}

const ACTIONS: QuickAction[] = [
  {
    label: 'New Invoice',
    href: '/accounting/customer-invoices/new',
    icon: FileText,
    color: 'text-teal-600 dark:text-teal-400',
    bg: 'bg-teal-50 dark:bg-teal-900/20 hover:bg-teal-100 dark:hover:bg-teal-900/40',
  },
  {
    label: 'New Bill',
    href: '/accounting/supplier-invoices/new',
    icon: Receipt,
    color: 'text-orange-600 dark:text-orange-400',
    bg: 'bg-orange-50 dark:bg-orange-900/20 hover:bg-orange-100 dark:hover:bg-orange-900/40',
  },
  {
    label: 'Record Payment',
    href: '/accounting/supplier-payments/new',
    icon: CreditCard,
    color: 'text-blue-600 dark:text-blue-400',
    bg: 'bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/40',
  },
  {
    label: 'New Journal',
    href: '/accounting/journal-entries/new',
    icon: BookOpen,
    color: 'text-purple-600 dark:text-purple-400',
    bg: 'bg-purple-50 dark:bg-purple-900/20 hover:bg-purple-100 dark:hover:bg-purple-900/40',
  },
  {
    label: 'Import Statement',
    href: '/accounting/bank-transactions',
    icon: Upload,
    color: 'text-green-600 dark:text-green-400',
    bg: 'bg-green-50 dark:bg-green-900/20 hover:bg-green-100 dark:hover:bg-green-900/40',
  },
  {
    label: 'New Contact',
    href: '/accounting/contacts/new',
    icon: Users,
    color: 'text-pink-600 dark:text-pink-400',
    bg: 'bg-pink-50 dark:bg-pink-900/20 hover:bg-pink-100 dark:hover:bg-pink-900/40',
  },
];

export function QuickActionsWidget() {
  return (
    <Card
      header={
        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Quick Actions</span>
      }
    >
      <div className="grid grid-cols-3 gap-2">
        {ACTIONS.map(action => {
          const Icon = action.icon;
          return (
            <Link
              key={action.href}
              href={action.href}
              className={`flex flex-col items-center gap-2 rounded-lg p-3 transition-colors ${action.bg}`}
            >
              <Icon className={`h-5 w-5 ${action.color}`} />
              <span className={`text-xs font-medium text-center leading-tight ${action.color}`}>
                {action.label}
              </span>
            </Link>
          );
        })}
      </div>
    </Card>
  );
}
