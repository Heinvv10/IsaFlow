/**
 * AvatarDemo — showcase section for the Avatar component.
 */

import { Avatar } from '@/components/ui';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
        {label}
      </p>
      <div className="flex flex-wrap items-center gap-4">{children}</div>
    </div>
  );
}

export function AvatarDemo() {
  return (
    <div className="space-y-4">
      <Row label="With image">
        <Avatar src="https://i.pravatar.cc/150?img=1" name="Alice Smith" size="sm" />
        <Avatar src="https://i.pravatar.cc/150?img=2" name="Bob Jones" size="md" />
        <Avatar src="https://i.pravatar.cc/150?img=3" name="Carol White" size="lg" />
        <Avatar src="https://i.pravatar.cc/150?img=4" name="David Brown" size="xl" />
      </Row>

      <Row label="Initials fallback (no image) — color hashed from name">
        <Avatar name="Hein van Vuuren" size="sm" />
        <Avatar name="Alice Smith" size="md" />
        <Avatar name="Bob Jones" size="lg" />
        <Avatar name="Britech Pty Ltd" size="xl" />
      </Row>

      <Row label="Sizes">
        <Avatar name="SM" size="sm" />
        <Avatar name="MD" size="md" />
        <Avatar name="LG" size="lg" />
        <Avatar name="XL" size="xl" />
      </Row>

      <Row label="Status dots">
        <Avatar name="Online User" status="online" />
        <Avatar name="Offline User" status="offline" />
        <Avatar name="Busy User" status="busy" />
        <Avatar src="https://i.pravatar.cc/150?img=5" name="With Image" status="online" size="lg" />
      </Row>
    </div>
  );
}
