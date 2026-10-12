/**
 * Closes and VAT locks with no snapshot recorded after them — the automatic snapshot runs after COMMIT in the web
 * process, so a restart (or a caller with no after-commit owner) can lose it without a 'failed' row. A lock is
 * covered only by a row whose seal VERIFIES (a sealed snapshot, or an attempt under its attempt seal), of the same
 * kind, taken after the lock: a sealed or 'unchanged' one at the same or a later cutoff (it froze those books too), a
 * failed one at that very cutoff. Rows written past the app carry no seal that verifies, so they hide nothing.
 */
import { SNAPSHOT_SEAL_DOMAIN, SigningKeyMissingError, checkSeal, signingKey, type SigningKey } from './seal';
import { coveringCandidates, sealedChain, standingLocks, type UnrecordedLock } from './snapshotRead';
import { attemptSeal } from './documents';

export type { UnrecordedLock };

const sameKind = (lock: UnrecordedLock['trigger'], trigger: string) =>
  lock === 'vat_lock' ? trigger === 'vat_lock' : trigger === 'period_close' || trigger === 'year_close';

export async function unrecordedLocks(companyId: string): Promise<UnrecordedLock[]> {
  const locks = await standingLocks(companyId);
  if (locks.length === 0) return [];
  let key: SigningKey | null = null;
  try {
    key = signingKey();
  } catch (err) {
    // Without the key nothing can be vouched for: every lock reads unrecorded (the routes report the key problem).
    if (!(err instanceof SigningKeyMissingError)) throw err;
  }
  const links = new Map((await sealedChain(companyId)).map((l) => [l.id, l]));
  const since = locks.reduce((min, l) => (l.lockedAt < min ? l.lockedAt : min), locks[0]!.lockedAt);
  const covering = key ? (await coveringCandidates(companyId, since)).filter((s) => {
    if (s.status === 'sealed') {
      const l = links.get(s.id);
      return !!l && checkSeal(SNAPSHOT_SEAL_DOMAIN, { companyId, id: l.id, canonicalHash: l.canonicalHash, cutoff: l.cutoff,
        takenAt: l.takenAt, chain: { seq: l.seq, prevHmac: l.prevHmac } }, l.hmac, l.keyId, key!) === 'valid';
    }
    return attemptSeal(companyId, { ...s, failureReason: s.failureReason, sameAsSnapshotId: s.sameAsSnapshotId,
      checkRunId: s.checkRunId }, key!) === 'valid';
  }) : [];
  return locks.filter((lock) => !covering.some((s) => sameKind(lock.trigger, s.trigger) && s.takenAt >= lock.lockedAt
    && (s.status === 'failed' ? s.cutoff === lock.cutoff : s.cutoff >= lock.cutoff)));
}
