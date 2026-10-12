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
import { getCheckRun, getSnapshot, listSnapshots, snapshotRows, snapshotTb, type StoredRow } from './snapshotRead';

export interface SnapshotVerification {
  snapshotId: string;
  /** valid only when every part below holds. */
  status: 'valid' | 'invalid' | 'not_sealed' | 'unchanged';
  /** An 'unchanged' attempt: verify this snapshot instead. */
  sameAsSnapshotId?: string | null;
  canonicalHash: string | null;
  recomputedHash: string | null;
  seal: SealCheck | null;
  checkRun: { id: string; hashMatches: boolean; seal: SealCheck } | null;
  rowsChecked: { accounts: number; journals: number; lines: number };
  /**
   * Rows whose stored hash, id or filing column (a line's journal, a journal's date, a TB row's account) does not
   * match the sealed row (first 20). Packs and comparisons read those columns, so they are checked too.
   */
  rowMismatches: { kind: 'journal' | 'line' | 'account'; id: string }[];
  rowMismatchCount: number;
}

type Mismatch = SnapshotVerification['rowMismatches'][number];

function recompute(rows: StoredRow[], kind: 'journal' | 'line', bad: Mismatch[]) {
  return rows.map((r) => {
    const h = materialHash(r.row);
    const placed = kind === 'line' ? r.row.journal_id === r.journalId : r.row.entry_date === r.entryDate;
    if (h !== r.materialHash || r.row.id !== r.id || !placed) bad.push({ kind, id: r.id });
    return { id: r.id, hash: h };
  });
}

export async function verifySnapshot(companyId: string, id: string, key: SigningKey = signingKey()): Promise<SnapshotVerification | null> {
  const s = await getSnapshot(companyId, id);
  if (!s) return null;
  const empty = { accounts: 0, journals: 0, lines: 0 };
  if (s.status !== 'sealed') {
    return { snapshotId: id, status: s.status === 'unchanged' ? 'unchanged' : 'not_sealed', sameAsSnapshotId: s.sameAsSnapshotId,
      canonicalHash: null, recomputedHash: null, seal: null, checkRun: null, rowsChecked: empty, rowMismatches: [], rowMismatchCount: 0 };
  }
  const bad: Mismatch[] = [];
  const tb = await snapshotTb(companyId, id);
  for (const t of tb) if (t.row.account_id !== t.accountId) bad.push({ kind: 'account', id: t.accountId });
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
  const seal = checkSeal(SNAPSHOT_SEAL_DOMAIN, { companyId, id, canonicalHash: recomputedHash, cutoff: s.cutoff, takenAt: s.takenAt,
    chain: { seq: s.seq ?? 0, prevHmac: s.prevHmac } }, s.hmac ?? '', s.keyId ?? '', key);

  const runOk = !s.checkRunId || (run !== null && run.hashMatches && run.seal === 'valid');
  const tampered = bad.length > 0 || recomputedHash !== s.canonicalHash || (s.checkRunId !== null && (run === null || !run.hashMatches));
  const status = !tampered && seal === 'valid' && runOk ? 'valid' : 'invalid';
  return {
    snapshotId: id, status, canonicalHash: s.canonicalHash, recomputedHash, seal, checkRun: run,
    rowsChecked: { accounts: tb.length, journals: journals.length, lines: lines.length },
    rowMismatches: bad.slice(0, 20), rowMismatchCount: bad.length,
  };
}

export interface ChainVerification {
  /** valid: links 1..n, each naming the one before, every seal good. broken: a gap, a wrong link or a bad seal. */
  status: 'valid' | 'broken' | 'empty';
  length: number;
  head: { seq: number; snapshotId: string; hmac: string } | null;
  breaks: { seq: number | null; snapshotId: string; reason: string }[];
}

/**
 * The company's chain of sealed snapshots, link by link: seq 1, 2, 3, … with no gap, each prev_hmac the previous
 * snapshot's hmac, and each seal good over its STORED canonical hash and chain position (cheap: no rows are read —
 * whether a snapshot's rows match its hash is verifySnapshot's question). A removed or replaced snapshot inside the
 * chain breaks it; a removed LATEST one is visible only against the chain head the app logs on every seal.
 */
export async function verifyChain(companyId: string, key: SigningKey = signingKey()): Promise<ChainVerification> {
  const all = await listSnapshots(companyId, 10_000);
  const sealed = all.filter((s) => s.status === 'sealed').sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const breaks: ChainVerification['breaks'] = [];
  sealed.forEach((s, i) => {
    const expected = i + 1;
    if (s.seq !== expected) breaks.push({ seq: s.seq, snapshotId: s.id, reason: `expected seq ${expected} (a snapshot is missing before it)` });
    const prev = sealed[i - 1];
    if ((s.prevHmac ?? null) !== (prev?.hmac ?? null)) breaks.push({ seq: s.seq, snapshotId: s.id, reason: 'does not name the previous snapshot' });
    const seal = checkSeal(SNAPSHOT_SEAL_DOMAIN, { companyId, id: s.id, canonicalHash: s.canonicalHash ?? '', cutoff: s.cutoff,
      takenAt: s.takenAt, chain: { seq: s.seq ?? 0, prevHmac: s.prevHmac } }, s.hmac ?? '', s.keyId ?? '', key);
    if (seal === 'invalid') breaks.push({ seq: s.seq, snapshotId: s.id, reason: 'seal does not verify' });
  });
  const last = sealed[sealed.length - 1];
  return {
    status: sealed.length === 0 ? 'empty' : breaks.length > 0 ? 'broken' : 'valid',
    length: sealed.length, head: last ? { seq: last.seq ?? 0, snapshotId: last.id, hmac: last.hmac ?? '' } : null, breaks,
  };
}
