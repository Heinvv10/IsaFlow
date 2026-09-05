/**
 * The only thing a share link is allowed to point at, and the canonical key
 * commentary is filed under.
 *
 * `parseSharePackParams` REBUILDS the object field by field rather than
 * validating in place. That is deliberate: a caller who posts
 * `{ type, from, to, companyId }` must not have `companyId` end up inside
 * `share_links.params`, where a later reader might trust it. The company on a
 * link comes from the authenticated session at creation and from the link row
 * at read time, never from params.
 */
import { createHash } from 'node:crypto';

const PACK_TYPES = ['board', 'management', 'monthly'] as const;
export type SharePackType = (typeof PACK_TYPES)[number];

export interface SharePackParams {
  type: SharePackType;
  from: string;
  to: string;
}

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
  return { type: type as SharePackType, from: r.from, to: r.to };
}

/** sha256 over the fields in a fixed order — the key commentary is filed under,
 *  so the same pack for the same period always resolves the same commentary. */
export function canonicalParamsHash(p: SharePackParams): string {
  return createHash('sha256').update(`${p.type}|${p.from}|${p.to}`).digest('hex');
}
