/**
 * Avatar — user/company avatar with image or deterministic initials fallback.
 * // WORKING: Initials derived from name, background color hashed from name string
 */

import { cn } from '@/utils/cn';

type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';
type AvatarStatus = 'online' | 'offline' | 'busy';

interface AvatarProps {
  src?: string;
  name?: string;
  size?: AvatarSize;
  status?: AvatarStatus;
  className?: string;
  alt?: string;
}

const SIZE_CLASSES: Record<AvatarSize, string> = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-12 w-12 text-base',
  xl: 'h-16 w-16 text-lg',
};

const STATUS_DOT_SIZE: Record<AvatarSize, string> = {
  sm: 'h-2 w-2',
  md: 'h-2.5 w-2.5',
  lg: 'h-3 w-3',
  xl: 'h-3.5 w-3.5',
};

const STATUS_COLOR: Record<AvatarStatus, string> = {
  online: 'bg-green-500',
  offline: 'bg-gray-400',
  busy: 'bg-amber-500',
};

// Palette of accessible background colors for initials avatars
const PALETTE = [
  'bg-teal-600',
  'bg-blue-600',
  'bg-violet-600',
  'bg-rose-600',
  'bg-amber-600',
  'bg-emerald-600',
  'bg-indigo-600',
  'bg-pink-600',
  'bg-cyan-600',
  'bg-orange-600',
];

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0] as string;
  if (words.length === 1) return first.charAt(0).toUpperCase();
  const last = words[words.length - 1] as string;
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

function getColorFromName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
    hash |= 0; // convert to 32-bit int
  }
  const index = Math.abs(hash) % PALETTE.length;
  return PALETTE[index] ?? 'bg-teal-600';
}

// WORKING: Avatar component
export function Avatar({
  src,
  name = '',
  size = 'md',
  status,
  className,
  alt,
}: AvatarProps) {
  const initials = getInitials(name);
  const bgColor = getColorFromName(name || 'default');
  const displayAlt = alt ?? name ?? 'Avatar';

  return (
    <div className={cn('relative inline-flex shrink-0', className)}>
      <div
        className={cn(
          'flex items-center justify-center rounded-full overflow-hidden',
          SIZE_CLASSES[size]
        )}
      >
        {src ? (
          <img
            src={src}
            alt={displayAlt}
            className="h-full w-full object-cover"
          />
        ) : (
          <div
            aria-label={displayAlt}
            className={cn(
              'flex h-full w-full items-center justify-center rounded-full font-semibold text-white',
              bgColor
            )}
          >
            {initials}
          </div>
        )}
      </div>

      {status && (
        <span
          aria-label={`Status: ${status}`}
          className={cn(
            'absolute bottom-0 right-0 block rounded-full ring-2 ring-white dark:ring-gray-900',
            STATUS_DOT_SIZE[size],
            STATUS_COLOR[status]
          )}
        />
      )}
    </div>
  );
}
