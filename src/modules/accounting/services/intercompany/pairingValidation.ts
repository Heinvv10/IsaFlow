/** Request shapes of the pairing routes, checked before any id reaches a `::UUID` cast. Types and sizes only. */
import { isUuidParam } from '@/lib/validation';
import type { Parsed } from './connectionValidation';
import type { PairInput, PairingDirection } from './pairingTypes';

/** The most pairs one request confirms: the screen's page, not a bulk import. */
export const MAX_PAIRS = 200;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseDirection(raw: unknown): Parsed<{ direction: PairingDirection }> {
  if (raw !== 'ar' && raw !== 'ap') return { ok: false, error: "direction must be 'ar' or 'ap'" };
  return { ok: true, direction: raw };
}

/** { direction, pairs: [{ mineId, theirsId }] }: each document in at most one pair. */
export function parsePairsInput(body: unknown): Parsed<{ direction: PairingDirection; pairs: PairInput[] }> {
  if (!isObject(body)) return { ok: false, error: 'A JSON object body is required' };
  const extra = Object.keys(body).find((k) => k !== 'direction' && k !== 'pairs');
  if (extra) return { ok: false, error: `Unknown field: ${extra}` };
  const dir = parseDirection(body.direction);
  if (!dir.ok) return dir;
  if (!Array.isArray(body.pairs) || body.pairs.length === 0) return { ok: false, error: 'pairs must list at least one pair' };
  if (body.pairs.length > MAX_PAIRS) return { ok: false, error: `At most ${MAX_PAIRS} pairs can be confirmed at once` };
  const pairs: PairInput[] = [];
  const seen = new Set<string>();
  for (const p of body.pairs) {
    if (!isObject(p) || Object.keys(p).some((k) => k !== 'mineId' && k !== 'theirsId')) {
      return { ok: false, error: 'Each pair is { mineId, theirsId }' };
    }
    if (!isUuidParam(p.mineId) || !isUuidParam(p.theirsId)) return { ok: false, error: 'mineId and theirsId must be valid UUIDs' };
    const pair = { mineId: p.mineId.toLowerCase(), theirsId: p.theirsId.toLowerCase() };
    if (seen.has(pair.mineId) || seen.has(pair.theirsId)) return { ok: false, error: 'A document can be in one pair only' };
    seen.add(pair.mineId);
    seen.add(pair.theirsId);
    pairs.push(pair);
  }
  return { ok: true, direction: dir.direction, pairs };
}
