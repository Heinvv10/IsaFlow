/**
 * ProgressBarDemo — showcase section for the ProgressBar component.
 */

import { ProgressBar } from '@/components/ui';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
        {label}
      </p>
      <div className="w-full max-w-md space-y-3">{children}</div>
    </div>
  );
}

export function ProgressBarDemo() {
  return (
    <div className="space-y-6">
      <Row label="Values">
        <ProgressBar value={25} label="25% complete" showPercentage />
        <ProgressBar value={50} label="50% complete" showPercentage />
        <ProgressBar value={75} label="75% complete" showPercentage />
        <ProgressBar value={100} label="100% complete" showPercentage />
      </Row>

      <Row label="Colors">
        <ProgressBar value={60} label="Teal (default)" color="teal" showPercentage />
        <ProgressBar value={60} label="Green" color="green" showPercentage />
        <ProgressBar value={60} label="Amber" color="amber" showPercentage />
        <ProgressBar value={60} label="Red" color="red" showPercentage />
        <ProgressBar value={60} label="Blue" color="blue" showPercentage />
      </Row>

      <Row label="Sizes">
        <ProgressBar value={55} size="sm" label="Small (h-1.5)" />
        <ProgressBar value={55} size="md" label="Medium (h-2.5)" />
        <ProgressBar value={55} size="lg" label="Large (h-4)" />
      </Row>

      <Row label="Without percentage label">
        <ProgressBar value={38} label="Loading assets…" />
        <ProgressBar value={80} />
      </Row>
    </div>
  );
}
