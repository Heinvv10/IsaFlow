/**
 * What a report pack IS — (type, from, to) — and the canonical key it is filed
 * under.
 *
 * Neutral ground on purpose. `report_commentary` is written by the commentary
 * service and read by the shared-pack builder, and both file rows under this
 * hash. While it lived in `share/shareParams.ts` the commentary module had to
 * import from the share module to describe its own primary key, which said the
 * two are layered when they are peers. Nothing here knows about share links.
 *
 * `canonicalParamsHash` pulls in `node:crypto`, so this module is SERVER ONLY.
 * A browser component may import the type (`import type`) but never a value
 * from here — `tests/unit/components-bundle-safety/shareBundleSafety.test.ts`
 * walks the real import graph and fails the build's behalf if one does.
 */
import { createHash } from 'node:crypto';

export const PACK_TYPES = ['board', 'management', 'monthly'] as const;
export type SharePackType = (typeof PACK_TYPES)[number];

export interface SharePackParams {
  type: SharePackType;
  from: string;
  to: string;
}

/** sha256 over the fields in a fixed order — the key commentary is filed under,
 *  so the same pack for the same period always resolves the same commentary. */
export function canonicalParamsHash(p: SharePackParams): string {
  return createHash('sha256').update(`${p.type}|${p.from}|${p.to}`).digest('hex');
}
