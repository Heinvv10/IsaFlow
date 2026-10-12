/**
 * Verifying a snapshot from what is stored — nothing is taken on trust:
 *  1. every journal and line row's material hash is recomputed from the row
 *     itself (and the row must be the id it is filed under);
 *  2. the check run's canonical hash is recomputed from its results and its
 *     seal checked with that recomputed hash;
 *  3. the snapshot's canonical hash is recomputed from the header, the trial
 *     balance, the recomputed row hashes and the recomputed run hash, and the
 *     seal is checked against THAT — so neither an edited row nor an edited
 *     hash column can verify without the signing key.
 */
import { materialHash } from './canonical';
import { CHECK_RUN_SEAL_DOMAIN, SNAPSHOT_SEAL_DOMAIN, checkSeal, signingKey, type SealCheck, type SigningKey } from './seal';
import { checkRunHash, snapshotHash } from './documents';
import { getCheckRun, getSnapshot, snapshotRows, snapshotTb, type StoredRow } from './snapshotRead';

export interface SnapshotVerification {
  snapshotId: string;
  /** valid only when every part below holds. */
  status: 'valid' | 'invalid' | 'unknown_key' | 'not_sealed';
  canonicalHash: string | null;
  recomputedHash: string | null;
  seal: SealCheck | null;
  checkRun: { id: string; hashMatches: boolean; seal: SealCheck } | null;
  rowsChecked: { accounts: number; journals: number; lines: number };
  /** Rows whose stored material hash or id does not match the row (first 20). */
  rowMismatches: { kind: 'journal' | 'line'; id: string }[];
  rowMismatchCount: number;
}

function recompute(rows: StoredRow[], kind: 'journal' | 'line', bad: { kind: 'journal' | 'line'; id: string }[]) {
  return rows.map((r) => {
    const h = materialHash(r.row);
    if (h !== r.materialHash || r.row.id !== r.id) bad.push({ kind, id: r.id });
    return { id: r.id, hash: h };
  });
}

export async function verifySnapshot(companyId: string, id: string, key: SigningKey = signingKey()): Promise<SnapshotVerification | null> {
  const s = await getSnapshot(companyId, id);
  if (!s) return null;
  const empty = { accounts: 0, journals: 0, lines: 0 };
  if (s.status !== 'sealed') {
    return { snapshotId: id, status: 'not_sealed', canonicalHash: null, recomputedHash: null, seal: null, checkRun: null,
      rowsChecked: empty, rowMismatches: [], rowMismatchCount: 0 };
  }
  const bad: { kind: 'journal' | 'line'; id: string }[] = [];
  const tb = await snapshotTb(companyId, id);
  const journals = recompute(await snapshotRows(companyId, id, 'journals'), 'journal', bad);
  const lines = recompute(await snapshotRows(companyId, id, 'lines'), 'line', bad);

  let run: SnapshotVerification['checkRun'] = null;
  let runHash: string | null = null;
  if (s.checkRunId) {
    const r = await getCheckRun(companyId, s.checkRunId);
    if (r) {
      runHash = checkRunHash(r, r.results);
      run = { id: r.id, hashMatches: runHash === r.canonicalHash, seal: checkSeal(CHECK_RUN_SEAL_DOMAIN,
        { companyId, id: r.id, canonicalHash: runHash, cutoff: r.asAt, takenAt: r.takenAt }, r.hmac, r.keyId, key) };
    }
  }
  const recomputedHash = snapshotHash({
    id: s.id, companyId, cutoff: s.cutoff, takenAt: s.takenAt, takenBy: s.takenBy, trigger: s.trigger, caveat: s.caveat,
    masterDataHighWater: s.masterDataHighWater, totals: s.totals,
    checkRun: s.checkRunId ? { id: s.checkRunId, canonicalHash: runHash ?? 'missing' } : null,
  }, tb, journals.map((j) => ({ journalId: j.id, materialHash: j.hash })), lines.map((l) => ({ lineId: l.id, materialHash: l.hash })));
  const seal = checkSeal(SNAPSHOT_SEAL_DOMAIN, { companyId, id, canonicalHash: recomputedHash, cutoff: s.cutoff, takenAt: s.takenAt },
    s.hmac ?? '', s.keyId ?? '', key);

  const runOk = !s.checkRunId || (run !== null && run.hashMatches && run.seal === 'valid');
  const status = seal === 'unknown_key' || run?.seal === 'unknown_key' ? 'unknown_key'
    : seal === 'valid' && recomputedHash === s.canonicalHash && runOk && bad.length === 0 ? 'valid' : 'invalid';
  return {
    snapshotId: id, status, canonicalHash: s.canonicalHash, recomputedHash, seal, checkRun: run,
    rowsChecked: { accounts: tb.length, journals: journals.length, lines: lines.length },
    rowMismatches: bad.slice(0, 20), rowMismatchCount: bad.length,
  };
}
