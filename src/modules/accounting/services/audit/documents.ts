/**
 * The canonical documents whose SHA-256 is a snapshot's or a check run's
 * canonical hash. Built from the same values at take time and on
 * verification (from the stored rows), so the two can only agree when nothing
 * was changed. Arrays are ordered here, never by the caller.
 */
import { canonicalJson, sha256Hex } from './canonical';
import { ATTEMPT_SEAL_DOMAIN, checkSeal, type SealCheck, type SigningKey } from './seal';
import type { CheckResult } from './checks/checkTypes';
import type { CanonicalRow } from './snapshotRows';

/**
 * The document version a NEW snapshot or check run is sealed under. 2: journal and line rows freeze the VAT /
 * intercompany / evidence columns too (breaker r1 F2). Each document stores its own version in its sealed totals
 * (`document_version`) and is always rebuilt under THAT version, so bumping this never touches an earlier seal.
 */
export const DOCUMENT_VERSION = 2;

/** The version a document was sealed under, as its totals record it (null when they don't: it then cannot verify). */
export function documentVersion(totals: Record<string, unknown>): number | null {
  const v = totals.document_version;
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}
export const SNAPSHOT_CAVEAT = 'Current values of records dated on or before the cutoff, as at taken_at — not the historical database state.';

export interface CheckRunHeader {
  id: string; companyId: string; asAt: string; periodStart: string; takenAt: string; takenBy: string;
  purpose: 'standalone' | 'snapshot'; totals: Record<string, unknown>;
}

const byKey = <T>(key: (t: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

const resultsDoc = (results: CheckResult[]) => [...results].sort(byKey((r) => r.checkId)).map((r) => ({
  check_id: r.checkId, check_version: r.version, family: r.family, status: r.status, population: r.population,
  finding_count: r.findingCount, findings: r.findings,
}));

export function checkRunHash(h: CheckRunHeader, results: CheckResult[]): string {
  return sha256Hex(canonicalJson({
    kind: 'audit_check_run', version: documentVersion(h.totals), id: h.id, company_id: h.companyId, as_at: h.asAt,
    period_start: h.periodStart, taken_at: h.takenAt, taken_by: h.takenBy, purpose: h.purpose, totals: h.totals,
    results: resultsDoc(results),
  }));
}

export interface SnapshotHeader {
  id: string; companyId: string; cutoff: string; takenAt: string; takenBy: string; trigger: string; caveat: string;
  masterDataHighWater: string | null; totals: Record<string, unknown>;
  checkRun: { id: string; canonicalHash: string } | null;
}

export function snapshotHash(h: SnapshotHeader, tb: { accountId: string; row: CanonicalRow }[],
  journals: { journalId: string; materialHash: string }[], lines: { lineId: string; materialHash: string }[]): string {
  return sha256Hex(canonicalJson({
    kind: 'audit_snapshot', version: documentVersion(h.totals), id: h.id, company_id: h.companyId, cutoff: h.cutoff,
    taken_at: h.takenAt, taken_by: h.takenBy, trigger: h.trigger, caveat: h.caveat,
    master_data_high_water: h.masterDataHighWater, totals: h.totals,
    check_run: h.checkRun ? { id: h.checkRun.id, canonical_hash: h.checkRun.canonicalHash } : null,
    trial_balance: [...tb].sort(byKey((t) => t.accountId)).map((t) => t.row),
    journals: [...journals].sort(byKey((j) => j.journalId)).map((j) => [j.journalId, j.materialHash]),
    lines: [...lines].sort(byKey((l) => l.lineId)).map((l) => [l.lineId, l.materialHash]),
  }));
}

/**
 * The books a snapshot freezes, in one hash: every journal's and line's material hash, the trial balance and the
 * ageing and control totals. Sealed in the snapshot's totals (`content_fingerprint`); an automatic snapshot whose
 * books hash the same is recorded as 'unchanged' with a check run of its own — the checks read state the books do
 * not (a period's status, bank lines), so they are always frozen afresh.
 */
export function contentFingerprint(tb: { accountId: string; row: CanonicalRow }[], journals: { journalId: string; materialHash: string }[],
  lines: { lineId: string; materialHash: string }[], books: Record<string, unknown>): string {
  return sha256Hex(canonicalJson({
    version: DOCUMENT_VERSION,
    tb: [...tb].sort(byKey((t) => t.accountId)).map((t) => t.row),
    journals: [...journals].sort(byKey((j) => j.journalId)).map((j) => j.materialHash),
    lines: [...lines].sort(byKey((l) => l.lineId)).map((l) => l.materialHash),
    books,
  }));
}

/** Exact decimal sum of two-place amounts (no float drift), as a two-place string. */
export function sumMoney(values: (string | null | undefined)[]): string {
  let cents = 0n;
  for (const v of values) {
    if (!v) continue;
    const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(v);
    if (!m) throw new Error(`sumMoney: not a decimal amount: ${v}`);
    const c = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
    cents += m[1] ? -c : c;
  }
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** What an attempt (failed / unchanged) records, in one hash: its status, trigger and reason, or its twin and run. */
export function attemptHash(a: { status: string; trigger: string; failureReason: string | null; sameAsSnapshotId: string | null;
  checkRunId: string | null }): string {
  return sha256Hex(canonicalJson({ kind: 'audit_snapshot_attempt', status: a.status, trigger: a.trigger,
    failure_reason: a.failureReason, same_as_snapshot_id: a.sameAsSnapshotId, check_run_id: a.checkRunId }));
}

/** Whether an attempt row's seal verifies over what the row records (recomputed, never the stored hash). */
export function attemptSeal(companyId: string, a: { id: string; cutoff: string; takenAt: string; status: string; trigger: string;
  failureReason: string | null; sameAsSnapshotId: string | null; checkRunId: string | null; hmac: string | null; keyId: string | null },
key: SigningKey): SealCheck {
  if (!a.hmac || !a.keyId) return 'invalid';
  return checkSeal(ATTEMPT_SEAL_DOMAIN, { companyId, id: a.id, canonicalHash: attemptHash(a), cutoff: a.cutoff, takenAt: a.takenAt },
    a.hmac, a.keyId, key);
}
