/**
 * SkeletonDemo — showcase section for the Skeleton component.
 */

import { Skeleton } from '@/components/ui';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
        {label}
      </p>
      <div className="w-full max-w-md space-y-2">{children}</div>
    </div>
  );
}

export function SkeletonDemo() {
  return (
    <div className="space-y-6">
      <Row label="Text (default)">
        <Skeleton variant="text" />
        <Skeleton variant="text" width="75%" />
        <Skeleton variant="text" width="50%" />
      </Row>

      <Row label="Heading">
        <Skeleton variant="heading" />
      </Row>

      <Row label="Avatar">
        <div className="flex items-center gap-3">
          <Skeleton variant="avatar" />
          <Skeleton variant="avatar" />
          <Skeleton variant="avatar" />
        </div>
      </Row>

      <Row label="Card">
        <Skeleton variant="card" />
      </Row>

      <Row label="Table row">
        <Skeleton variant="table-row" />
      </Row>

      <Row label="Group with count=3 (text lines)">
        <Skeleton.Group>
          <Skeleton variant="text" count={3} />
        </Skeleton.Group>
      </Row>
    </div>
  );
}
