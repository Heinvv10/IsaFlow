/**
 * Bulk accept of high-confidence suggestions, the READ half (audit WP6, Hein decision 2a.2): which lines of one bank
 * account would post if a person accepted every suggestion the categoriser is sure of, and the PREVIEW TOKEN that pins
 * exactly those lines.
 *
 * The token carries each line's id, its suggestion (GL account and VAT code) and a version (`updated_at` to the
 * microsecond). It is NOT a credential and needs no signature: confirm (bankBulkAcceptService) re-reads every line
 * under its row lock and posts it only when it still matches the token AND still passes the gate, so a forged or stale
 * token can at worst be refused. Nothing it names is posted from the token's say-so.
 *
 * "High confidence" is the auto-post gate's own ladder (`evaluate`), with the settings' enabled switches treated as on:
 * a person is choosing, so the switches do not apply, but the confidence floor, the amount caps, the LLM tier's own
 * thresholds and "a shared-pool suggestion is never bulk-posted" all do. Lines a confirm would PREDICTABLY refuse are not
 * listed as postable (./bankBulkAcceptEligibility).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { evaluate } from './autoPostGate';
import { getAutoPostSettings, type AutoPostSettings } from './autoPostSettingsService';
import { feedStateOf } from './bankFeedStateGuard';
import { screenCandidates, type ExcludedCounts, type NeedsAttention } from './bankBulkAcceptEligibility';

/**
 * The most lines one confirm posts. A request is one transaction and holds the company's journal-number lock from its first
 * post to its commit, so every other poster waits for it: measured on a loaded box, 25 lines hold it ~0.9 s, 50 ~1.2 s,
 * 100 ~3.1-3.5 s (superlinear), and three 100-line confirms on one company took 3.2 / 7.3 / 14.1 s. 25 keeps the hold
 * short; the preview lists the first page and the person confirms again for the rest.
 */
export const BULK_ACCEPT_MAX_LINES = 25;
/** A person may ask for more caution than the company's auto-post floor, never less than this. */
export const BULK_ACCEPT_MIN_CONFIDENCE_FLOOR = 0.8;
/** The preview reads candidates PAGE at a time (by id) until it has enough postable lines or has read SCAN_CAP rows. */
const SCAN_PAGE = 500;
export const BULK_ACCEPT_SCAN_CAP = 2000;
/** Held lines (importer / approval) listed; past this many the scan stops - the list is a hint, not the point. */
export const BULK_ACCEPT_HELD_CAP = 50;

export class BulkAcceptRefusal extends Error {
  readonly code = 'BULK_ACCEPT_REFUSED';
  constructor(message: string, readonly status: 400 | 404 | 409 | 429 = 400) {
    super(message);
    this.name = 'BulkAcceptRefusal';
  }
}
export const isBulkAcceptRefusal = (err: unknown): err is BulkAcceptRefusal =>
  err instanceof Error && (err as { code?: unknown }).code === 'BULK_ACCEPT_REFUSED';

export interface PreviewLine {
  id: string; date: string; description: string | null; amount: number;
  glAccountId: string; glAccountCode: string | null; glAccountName: string | null;
  vatCode: string | null; confidence: number; strategy: string | null; version: string;
  /** The VAT code that will actually post (the denial / no-supply guards applied) and the amounts under it. */
  effectiveVatCode: string; netAmount: number; vatAmount: number;
  /** The line's saved dimensions: they post on the journal's contra line and stay on the bank line. */
  cc1Id: string | null; cc2Id: string | null; buId: string | null;
  cc1Code: string | null; cc2Code: string | null; buCode: string | null;
}
export interface BulkAcceptPreview {
  bankAccountId: string; minConfidence: number;
  lines: PreviewLine[]; totalIn: number; totalOut: number;
  byAccount: Array<{ glAccountId: string; code: string | null; name: string | null; count: number; totalIn: number; totalOut: number }>;
  /** More lines qualified than one confirm posts: the first BULK_ACCEPT_MAX_LINES (by id) are listed. */
  truncated: boolean;
  /** How many postable lines were found: a LOWER BOUND when `truncated` or `scanTruncated` (the scan stops early). */
  totalEligibleAtLeast: number;
  /** Pass as `scanAfter` to a new preview to read on past the rows this one scanned; null when the scan reached the end. */
  nextScanAfter: string | null;
  /** The scan stopped at its row cap with candidates unread: there may be more postable lines than shown or counted. */
  scanTruncated: boolean;
  /** Lines that would be held, not posted: another member must allocate them, or a manual-journal rule needs approval. */
  needsAttention: NeedsAttention[];
  /** How many held lines the scan met (at least this many when it stopped at the cap); `needsAttention` lists the first few. */
  needsAttentionCount: number;
  /** How many candidates were left out because a confirm would refuse them, by reason. */
  excluded: ExcludedCounts;
  /** null when no line is listed: there is nothing to confirm. */
  previewToken: string | null;
}

/** One line of the token: id, GL account, VAT code, version, amount, date (the last two pinned beyond `updated_at`). */
export interface TokenLine { i: string; g: string; x: string | null; s: string; m: number; d: string }
export interface PreviewToken { v: 1; a: string; t: number; l: TokenLine[] }

export const writePreviewToken = (t: PreviewToken): string => Buffer.from(JSON.stringify(t)).toString('base64url');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function readPreviewToken(raw: unknown): PreviewToken {
  const bad = () => new BulkAcceptRefusal('The preview token is not valid. Preview again and confirm that.');
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64 * 1024) throw bad();
  let t: PreviewToken;
  try { t = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as PreviewToken; } catch { throw bad(); }
  if (t?.v !== 1 || typeof t.a !== 'string' || !UUID.test(t.a) || typeof t.t !== 'number' || !Array.isArray(t.l)) throw bad();
  if (t.l.length === 0 || t.l.length > BULK_ACCEPT_MAX_LINES) throw new BulkAcceptRefusal(`A confirm posts 1 to ${BULK_ACCEPT_MAX_LINES} lines.`);
  const seen = new Set<string>();
  for (const l of t.l) {
    if (typeof l?.i !== 'string' || !UUID.test(l.i) || typeof l.g !== 'string' || !UUID.test(l.g) || typeof l.s !== 'string'
      || (l.x !== null && typeof l.x !== 'string') || typeof l.m !== 'number' || !Number.isFinite(l.m) || typeof l.d !== 'string'
      || seen.has(l.i.toLowerCase())) throw bad();
    seen.add(l.i.toLowerCase());
  }
  return t;
}

/** The gate settings a person's bulk accept is judged by: the company's caps and thresholds, the switches on. */
export function bulkAcceptSettings(base: AutoPostSettings, minConfidence: number): AutoPostSettings {
  return { ...base, enabled: true, llmEnabled: true, minConfidence, llmMinConfidence: Math.max(minConfidence, base.llmMinConfidence) };
}

export function resolveMinConfidence(base: AutoPostSettings, requested: number | undefined): number {
  const wanted = requested ?? base.minConfidence;
  if (!Number.isFinite(wanted) || wanted > 1) throw new BulkAcceptRefusal('minConfidence must be a number from 0.80 to 1.');
  return Math.max(BULK_ACCEPT_MIN_CONFIDENCE_FLOOR, wanted);
}

const money = (n: number) => Math.round(n * 100) / 100;

export async function previewBulkAccept(companyId: string, userId: string, bankAccountId: string, requested?: number, scanAfter?: string): Promise<BulkAcceptPreview> {
  const base = await getAutoPostSettings(companyId);
  const minConfidence = resolveMinConfidence(base, requested);
  const settings = bulkAcceptSettings(base, minConfidence);
  const postable: Awaited<ReturnType<typeof screenCandidates>>['postable'] = [];
  const needsAttention: NeedsAttention[] = [];
  const excluded: ExcludedCounts = { badTarget: 0, reconciliationHeld: 0, periodClosed: 0, noPeriod: 0, vatLocked: 0, vatCode: 0 };
  let after = scanAfter ?? '00000000-0000-0000-0000-000000000000';
  let scanned = 0;
  let exhausted = false;
  // Every predicate that can be written in SQL is, so a run of ineligible rows cannot hide eligible ones behind a LIMIT;
  // the rest (period, VAT, importer, approval) is screened per page, and pages are read until MAX + 1 lines are found
  // (one more than shown, to know the preview is cut) or the scan cap is reached.
  let heldCapped = false;
  while (postable.length <= BULK_ACCEPT_MAX_LINES && scanned < BULK_ACCEPT_SCAN_CAP) {
    const rows = await readCandidates(companyId, bankAccountId, settings, after);
    if (rows.length === 0) { exhausted = true; break; }
    after = String(rows[rows.length - 1]!.id);
    scanned += rows.length;
    const gated = rows.filter((r) => feedStateOf(r) === 'posted' && evaluate(
      { status: String(r.status), amount: Number(r.amount), suggestedGlAccountId: String(r.gl) },
      Number(r.confidence), settings, r.strategy == null ? null : String(r.strategy)).outcome === 'post');
    // Screening stops at the row that makes MAX + 1 postable lines: the rest of the page is not paid for.
    const screened = await screenCandidates(companyId, userId, gated, BULK_ACCEPT_MAX_LINES + 1 - postable.length);
    postable.push(...screened.postable);
    needsAttention.push(...screened.needsAttention);
    for (const k of Object.keys(excluded) as Array<keyof ExcludedCounts>) excluded[k] += screened.excluded[k];
    if (screened.stoppedAt) after = screened.stoppedAt; // rows past it were not screened: a cursor must not skip them
    else if (rows.length < SCAN_PAGE) { exhausted = true; break; }
    if (needsAttention.length >= BULK_ACCEPT_HELD_CAP) { heldCapped = true; break; } // mostly held: stop paying for per-row checks
  }
  const scanTruncated = !exhausted && (postable.length <= BULK_ACCEPT_MAX_LINES || heldCapped);
  const eligible = postable;
  const chosen = eligible.slice(0, BULK_ACCEPT_MAX_LINES);
  const str = (v: unknown) => (v == null ? null : String(v));
  const lines: PreviewLine[] = chosen.map(({ row: r, effectiveVatCode, netAmount, vatAmount }) => ({
    id: String(r.id), date: String(r.date), description: str(r.description),
    amount: Number(r.amount), glAccountId: String(r.gl), glAccountCode: str(r.account_code),
    glAccountName: str(r.account_name), vatCode: str(r.vat),
    confidence: Number(r.confidence), strategy: str(r.strategy), version: String(r.version),
    effectiveVatCode, netAmount, vatAmount,
    cc1Id: str(r.cc1_id), cc2Id: str(r.cc2_id), buId: str(r.bu_id), cc1Code: str(r.cc1_code), cc2Code: str(r.cc2_code), buCode: str(r.bu_code),
  }));
  const groups = new Map<string, BulkAcceptPreview['byAccount'][number]>();
  let totalIn = 0;
  let totalOut = 0;
  for (const l of lines) {
    const g = groups.get(l.glAccountId) ?? { glAccountId: l.glAccountId, code: l.glAccountCode, name: l.glAccountName, count: 0, totalIn: 0, totalOut: 0 };
    g.count += 1;
    if (l.amount >= 0) { g.totalIn = money(g.totalIn + l.amount); totalIn = money(totalIn + l.amount); }
    else { g.totalOut = money(g.totalOut - l.amount); totalOut = money(totalOut - l.amount); }
    groups.set(l.glAccountId, g);
  }
  const token: PreviewToken = { v: 1, a: bankAccountId, t: minConfidence, l: lines.map((l) => ({ i: l.id, g: l.glAccountId, x: l.vatCode, s: l.version, m: l.amount, d: l.date })) };
  return {
    bankAccountId, minConfidence, lines, totalIn, totalOut, byAccount: [...groups.values()],
    truncated: eligible.length > chosen.length, totalEligibleAtLeast: eligible.length, scanTruncated,
    // A cut list continues after its LAST LISTED line (a refused head of 25 must be pageable past); a scan cut short, after the last row read.
    nextScanAfter: eligible.length > chosen.length ? lines[lines.length - 1]!.id : scanTruncated ? after : null,
    needsAttention: needsAttention.slice(0, BULK_ACCEPT_HELD_CAP), needsAttentionCount: needsAttention.length, excluded, previewToken: lines.length > 0 ? writePreviewToken(token) : null,
  };
}

/** One page of candidates after `after` (by id): everything the gate would test that SQL can say, in SQL. */
async function readCandidates(companyId: string, bankAccountId: string, settings: AutoPostSettings, after: string): Promise<DbRow[]> {
  return (await sql`
    SELECT bt.id::TEXT AS id, bt.transaction_date::TEXT AS date, bt.description, bt.amount, bt.status, bt.feed_state,
           bt.bank_account_id::TEXT AS bank_account_id, bt.reconciliation_id, bt.import_batch_id, bt.bank_feed_connection_id,
           bt.suggested_gl_account_id::TEXT AS gl, bt.suggested_confidence AS confidence, bt.suggested_vat_code AS vat,
           bt.suggested_strategy AS strategy, ga.account_code, ga.account_name, ga.account_subtype,
           bt.cc1_id::TEXT AS cc1_id, bt.cc2_id::TEXT AS cc2_id, bt.bu_id::TEXT AS bu_id,
           c1.code AS cc1_code, c2.code AS cc2_code, bu.code AS bu_code,
           to_char(bt.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS version
    FROM bank_transactions bt
    JOIN gl_accounts ga ON ga.id = bt.suggested_gl_account_id AND ga.company_id = bt.company_id AND ga.is_active = true
    LEFT JOIN cost_centres c1 ON c1.id = bt.cc1_id AND c1.company_id = bt.company_id
    LEFT JOIN cost_centres c2 ON c2.id = bt.cc2_id AND c2.company_id = bt.company_id
    LEFT JOIN business_units bu ON bu.id = bt.bu_id AND bu.company_id = bt.company_id
    WHERE bt.company_id = ${companyId}::UUID AND bt.bank_account_id = ${bankAccountId}::UUID
      AND bt.id > ${after}::UUID
      AND bt.status = 'imported' AND bt.feed_state = 'posted' AND bt.suggested_gl_account_id IS NOT NULL
      AND bt.suggested_strategy IS DISTINCT FROM 'shared_pool'
      AND ((bt.suggested_strategy IS DISTINCT FROM 'llm'
            AND bt.suggested_confidence >= ${settings.minConfidence}::NUMERIC
            AND (${settings.amountCap}::NUMERIC = 0 OR ABS(bt.amount) <= ${settings.amountCap}::NUMERIC))
        OR (bt.suggested_strategy = 'llm'
            AND bt.suggested_confidence >= ${settings.llmMinConfidence}::NUMERIC
            AND (${settings.llmAmountCap}::NUMERIC = 0 OR ABS(bt.amount) <= ${settings.llmAmountCap}::NUMERIC)))
    ORDER BY bt.id
    LIMIT ${SCAN_PAGE}`) as DbRow[];
}
