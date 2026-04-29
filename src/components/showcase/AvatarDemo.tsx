/**
 * AvatarDemo — showcase section for the Avatar component.
 */

import { Avatar } from '@/components/ui';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-400 dark:text-gray-500">
        {label}
      </p>
      <div className="flex flex-wrap items-center gap-4">{children}</div>
    </div>
  );
}

export function AvatarDemo() {
  return (
    <div className="space-y-4">
      {/* Gravatar /avatar/<hash> normally takes an MD5 of an email; passing
          an integer always misses real accounts so the d=identicon fallback
          paints a deterministic geometric tile per integer. That's the
          intent — these are showcase placeholders, not lookups for a real
          user. Gravatar is in the project CSP img-src allow-list. */}
      <Row label="With image">
        <Avatar src="https://www.gravatar.com/avatar/1?d=identicon&s=150" name="Alice Smith" size="sm" />
        <Avatar src="https://www.gravatar.com/avatar/2?d=identicon&s=150" name="Bob Jones" size="md" />
        <Avatar src="https://www.gravatar.com/avatar/3?d=identicon&s=150" name="Carol White" size="lg" />
        <Avatar src="https://www.gravatar.com/avatar/4?d=identicon&s=150" name="David Brown" size="xl" />
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
        <Avatar src="https://www.gravatar.com/avatar/5?d=identicon&s=150" name="With Image" status="online" size="lg" />
      </Row>
    </div>
  );
}
