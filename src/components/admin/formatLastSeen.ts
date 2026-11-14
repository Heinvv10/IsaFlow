import { formatDisplayDate } from '@/utils/dateFormat';

/** A last-sign-in / last-active timestamp for the admin screens: "Never" when there is none, never a blank or dash. */
export function formatLastSeen(value: string | Date | null | undefined): string {
  return value ? formatDisplayDate(value) : 'Never';
}
