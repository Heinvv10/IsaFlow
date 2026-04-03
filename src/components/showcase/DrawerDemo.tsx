/**
 * DrawerDemo — showcase section for the Drawer component.
 */

import { useState } from 'react';
import { Drawer, Button } from '@/components/ui';

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

type DrawerWidth = 'sm' | 'md' | 'lg';

export function DrawerDemo() {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState<DrawerWidth>('md');

  function openWith(w: DrawerWidth) {
    setWidth(w);
    setOpen(true);
  }

  return (
    <div className="space-y-4">
      <Row label="Widths">
        <Button variant="secondary" size="sm" onClick={() => openWith('sm')}>Narrow (320px)</Button>
        <Button variant="secondary" size="sm" onClick={() => openWith('md')}>Medium (480px)</Button>
        <Button variant="secondary" size="sm" onClick={() => openWith('lg')}>Wide (640px)</Button>
      </Row>

      <Drawer open={open} onClose={() => setOpen(false)} title="Invoice Details" width={width}>
        <div className="space-y-4 text-sm text-gray-700 dark:text-gray-300">
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Client</p>
            <p className="font-medium">Britech (Pty) Ltd</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Invoice</p>
            <p className="font-medium">INV-0042</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Amount</p>
            <p className="font-medium text-teal-600">R 12,450.00</p>
          </div>
          <hr className="border-gray-200 dark:border-gray-700" />
          <p className="text-xs text-gray-400">
            Press <kbd className="rounded bg-gray-100 dark:bg-gray-700 px-1 py-0.5 font-mono">ESC</kbd> or
            click the backdrop to close.
          </p>
        </div>
      </Drawer>
    </div>
  );
}
