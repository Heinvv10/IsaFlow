/**
 * ToastDemo — showcase section for the Toast component.
 * Must be rendered inside a <ToastProvider>.
 */

import { useToast, Button } from '@/components/ui';

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

export function ToastDemo() {
  const { toast } = useToast();

  return (
    <div className="space-y-4">
      <Row label="Trigger a notification">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => toast.success('Invoice INV-0042 saved successfully.')}
        >
          Success
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => toast.error('Failed to sync with Sage — check your credentials.')}
        >
          Error
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => toast.warning('Invoice is overdue by 14 days.')}
        >
          Warning
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => toast.info('Sage sync completed. 42 records imported.')}
        >
          Info
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => toast.success('This one stays until dismissed.', { duration: 0 })}
        >
          Persistent (no auto-dismiss)
        </Button>
      </Row>
    </div>
  );
}
