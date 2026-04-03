/**
 * ModalDemo — interactive showcase section for the Modal component.
 */

import { useState } from 'react';
import {
  Modal,
  Button,
  type ModalSize,
} from '@/components/ui';

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

export function ModalDemo() {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState<ModalSize>('md');

  function openWith(s: ModalSize) {
    setSize(s);
    setOpen(true);
  }

  return (
    <div className="space-y-4">
      <Row label="Sizes">
        <Button variant="secondary" size="sm" onClick={() => openWith('sm')}>Small</Button>
        <Button variant="secondary" size="sm" onClick={() => openWith('md')}>Medium</Button>
        <Button variant="secondary" size="sm" onClick={() => openWith('lg')}>Large</Button>
        <Button variant="secondary" size="sm" onClick={() => openWith('xl')}>Extra Large</Button>
      </Row>

      <Modal open={open} onClose={() => setOpen(false)} title={`Modal — ${size.toUpperCase()}`} size={size}>
        <Modal.Body>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            This is the modal body. Content scrolls independently when it overflows.
            Try pressing <kbd className="rounded bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-xs font-mono">ESC</kbd> or
            clicking the backdrop to close.
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => setOpen(false)}>Confirm</Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
}
