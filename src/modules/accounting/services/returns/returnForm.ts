import type { ReturnForm } from './returnVersionTypes';

/** The URL segment (`vat201` | `emp201`) as a form, or null. */
export function returnFormOf(segment: string | string[] | undefined): ReturnForm | null {
  if (segment === 'vat201') return 'VAT201';
  if (segment === 'emp201') return 'EMP201';
  return null;
}
