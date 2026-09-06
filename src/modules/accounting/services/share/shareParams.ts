/**
 * Validation of the only thing a share link is allowed to point at.
 *
 * `parseSharePackParams` REBUILDS the object field by field rather than
 * validating in place. That is deliberate: a caller who posts
 * `{ type, from, to, companyId }` must not have `companyId` end up inside
 * `share_links.params`, where a later reader might trust it. The company on a
 * link comes from the authenticated session at creation and from the link row
 * at read time, never from params.
 *
 * The params type itself, and the hash commentary is filed under, live in
 * `@/modules/accounting/services/reports/packParamsHash` — neutral ground the
 * commentary module can import without importing the share module. This file
 * re-exports NOTHING: every caller imports what it needs from the module that
 * owns it, so there is one import path per symbol rather than two.
 */
import { PACK_TYPES, type SharePackParams } from '@/modules/accounting/services/reports/packParamsHash';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function parseSharePackParams(raw: unknown): SharePackParams | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const type = r.type;
  if (typeof type !== 'string' || !(PACK_TYPES as readonly string[]).includes(type)) return null;
  if (!isIsoDate(r.from) || !isIsoDate(r.to)) return null;
  if (r.from > r.to) return null;
  return { type: type as SharePackParams['type'], from: r.from, to: r.to };
}
