/**
 * The app-wide keyboard shortcuts: Ctrl+K, "?" and the "G then <key>" navigation sequences.
 * Registers them and returns the list, which the shortcut help overlay renders.
 */
import { useMemo } from 'react';
import { useRouter } from 'next/router';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import type { ShortcutConfig } from '@/lib/keyboard-shortcuts';

interface GlobalShortcutHandlers {
  openCommandPalette: () => void;
  openShortcutHelp: () => void;
}

/** "G then <key>" → page. Press G then the second key within 1 second. */
const GO_TO: Array<{ key: string; name: string; href: string }> = [
  { key: 'd', name: 'Dashboard', href: '/accounting' },
  { key: 's', name: 'Sales', href: '/accounting/customers' },
  { key: 'p', name: 'Purchases', href: '/accounting/suppliers' },
  { key: 'i', name: 'Inventory', href: '/accounting/items' },
  { key: 'b', name: 'Banking', href: '/accounting/bank-transactions' },
  { key: 'a', name: 'Accounting', href: '/accounting/chart-of-accounts' },
  { key: 'r', name: 'Reports', href: '/accounting/reports/income-statement' },
  { key: 't', name: 'Tax', href: '/accounting/sars/vat201' },
];

export function useGlobalShortcuts({ openCommandPalette, openShortcutHelp }: GlobalShortcutHandlers): ShortcutConfig[] {
  const router = useRouter();
  const shortcuts = useMemo<ShortcutConfig[]>(() => [
    { key: 'ctrl+k', label: 'Ctrl+K', description: 'Open command palette', category: 'global', action: openCommandPalette },
    { key: '?', label: '?', description: 'Show keyboard shortcuts', category: 'global', action: openShortcutHelp },
    ...GO_TO.map(({ key, name, href }) => ({
      key: `g ${key}`,
      label: `G then ${key.toUpperCase()}`,
      description: `Go to ${name}`,
      category: 'navigation' as const,
      action: () => { void router.push(href); },
    })),
  ], [router, openCommandPalette, openShortcutHelp]);

  useKeyboardShortcuts(shortcuts);
  return shortcuts;
}
