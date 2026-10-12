/**
 * The audit pack built FROM a sealed snapshot (forensic-controls step 4): a
 * ZIP of manifest.json, the snapshot's trial balance, journals, lines, checks
 * and findings as CSV (cells formula-neutralised), an optional comparison
 * with today's books, and the existing audit-pack PDF rendered from the
 * snapshot's own rows (not from today's books). The manifest cites the
 * snapshot's canonical hash, HMAC and key id, and the SHA-256 of every file.
 *
 * The manifest is sealed too (manifest.sig.json: HMAC over the manifest's SHA-256, export id, cutoff and
 * taken_at), so an edited file with a recomputed manifest does not verify without the key.
 *
 * A pack is built only from a snapshot that verifies valid. verifyPack
 * re-reads the stored ZIP: the manifest's seal, every file's hash against the manifest, and the
 * snapshot the manifest cites verified from its stored rows.
 */
import JSZip from 'jszip';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { downloadCapturedDocument, uploadCapturedDocument } from '@/lib/supabaseStorage';
import { buildPdf, getExport, type AuditExport, type JEForExport } from '@/modules/accounting/services/capture/auditTrailExportService';
import { sha256Hex } from './canonical';
import { PACK_SEAL_DOMAIN, checkSeal, sign, signingKey, type SealCheck } from './seal';
import { toCsv } from './csv';
import type { Comparison } from './comparisonService';
import { getCheckRun, getSnapshot, snapshotRows, snapshotTb, type SnapshotRecord, type StoredRow } from './snapshotRead';
import { verifySnapshot } from './snapshotVerify';

export const PACK_FORMAT = 'isaflow-audit-pack/v1';

export class PackRefusedError extends Error {
  constructor(message: string) { super(message); this.name = 'PackRefusedError'; }
}

const J = ['entry_number', 'entry_date', 'source', 'status', 'description', 'reference', 'created_by', 'created_at', 'posted_by',
  'posted_at', 'reversed_by', 'reversed_at', 'reversal_of_id', 'source_document_id', 'source_document_hash'];
const L = ['journal_id', 'account_id', 'debit', 'credit', 'description', 'vat_type', 'cc1_id',
  'cc2_id', 'bu_id', 'project_id', 'source_document_line_id'];
const TB = ['account_id', 'account_code', 'account_name', 'account_type', 'opening', 'debit', 'credit', 'closing'];

function pdfEntries(s: SnapshotRecord, periodStart: string, journals: StoredRow[], lines: StoredRow[]): JEForExport[] {
  const byJournal = new Map<string, StoredRow[]>();
  for (const l of lines) {
    const list = byJournal.get(l.journalId);
    if (list) list.push(l); else byJournal.set(l.journalId, [l]);
  }
  return journals.filter((j) => (j.row.entry_date ?? '') >= periodStart && (j.row.entry_date ?? '') <= s.cutoff).map((j) => ({
    id: j.id, entryNumber: j.row.entry_number ?? '', entryDate: j.row.entry_date ?? '', description: j.row.description ?? '',
    source: j.row.source ?? '', postingAgent: j.row.posting_agent ?? null, sourceDocumentId: j.row.source_document_id ?? null,
    documentFileName: null, documentVendorName: null,
    documentReference: j.row.source_document_hash ? `sha256 ${j.row.source_document_hash.slice(0, 16)}…` : null,
    lines: (byJournal.get(j.id) ?? []).map((l) => ({
      glAccountCode: l.account?.code ?? '', glAccountName: l.account?.name ?? '',
      debit: Number(l.row.debit ?? 0), credit: Number(l.row.credit ?? 0), description: l.row.description ?? null,
    })),
  }));
}

function comparisonCsv(c: Comparison): string {
  const rows: unknown[][] = [];
  const add = (category: string, list: Comparison['changed']) => {
    for (const j of list) {
      const base = [category, j.id, j.entryNumber, j.entryDate, j.createdBy, j.createdAt, j.postedBy, j.postedAt];
      if (j.fields.length === 0) rows.push([...base, '', '', '']);
      for (const f of j.fields) rows.push([...base, f.field, f.before, f.after]);
      for (const lc of j.lines.changed) for (const f of lc.fields) rows.push([...base, `line ${lc.id}.${f.field}`, f.before, f.after]);
    }
  };
  add('backdated', c.backdated);
  add('added', c.added);
  add('changed', c.changed);
  add('removed', c.removed);
  for (const t of c.tb) rows.push(['tb_movement', t.accountId, t.code, '', '', '', '', '', 'closing', t.before, t.after]);
  return toCsv(['category', 'id', 'entry_number', 'entry_date', 'created_by', 'created_at', 'posted_by', 'posted_at', 'field', 'before', 'after'], rows);
}

export interface BuiltPack { zip: Buffer; sha256: string; manifest: Record<string, unknown>; pdfSha256: string; jeCount: number;
  lineCount: number; documentCount: number; totalDebits: number; totalCredits: number }

/** Builds the ZIP for `exportRow` from snapshot `snapshotId` (read under the caller's RLS). */
export async function buildSnapshotPack(exportRow: AuditExport, snapshotId: string, companyName: string,
  comparison: Comparison | null): Promise<BuiltPack> {
  const companyId = exportRow.companyId;
  const s = await getSnapshot(companyId, snapshotId);
  if (!s || s.status !== 'sealed') throw new PackRefusedError('An audit pack is built only from a sealed snapshot.');
  const verification = await verifySnapshot(companyId, snapshotId);
  if (verification?.status !== 'valid') throw new PackRefusedError(`The snapshot does not verify (${verification?.status}); no pack was built.`);
  const [tb, journals, lines, run] = [await snapshotTb(companyId, s.id), await snapshotRows(companyId, s.id, 'journals'),
    await snapshotRows(companyId, s.id, 'lines'), s.checkRunId ? await getCheckRun(companyId, s.checkRunId) : null];
  const entries = pdfEntries(s, exportRow.periodStart, journals, lines);
  const sealNote = `Built from audit snapshot ${s.id} (cutoff ${s.cutoff}, taken ${s.takenAt}). Canonical SHA-256 ${s.canonicalHash}; `
    + `HMAC-SHA256 ${s.hmac} (key ${s.keyId}). ${s.caveat}`;
  const pdf = await buildPdf(companyName, exportRow, entries, sealNote);
  const files: Record<string, Buffer> = {
    'trial_balance.csv': Buffer.from(toCsv(TB, tb.map((t) => TB.map((k) => t.row[k] ?? null)))),
    'journals.csv': Buffer.from(toCsv(['journal_id', ...J, 'material_hash'], journals.map((j) => [j.id, ...J.map((k) => j.row[k] ?? null), j.materialHash]))),
    'journal_lines.csv': Buffer.from(toCsv(['line_id', ...L, 'account_code', 'account_type', 'material_hash'],
      lines.map((l) => [l.id, ...L.map((k) => l.row[k] ?? null), l.account?.code ?? null, l.account?.type ?? null, l.materialHash]))),
    'checks.csv': Buffer.from(toCsv(['check_id', 'family', 'version', 'status', 'population', 'finding_count'],
      (run?.results ?? []).map((r) => [r.checkId, r.family, r.version, r.status, r.population, r.findingCount]))),
    'findings.csv': Buffer.from(toCsv(['check_id', 'finding_key', 'refs', 'detail'],
      (run?.results ?? []).flatMap((r) => r.findings.map((f) => [r.checkId, f.key, f.refs.join(';'), JSON.stringify(f.detail)])))),
    'audit-pack.pdf': pdf.buffer,
  };
  if (comparison) files['comparison.csv'] = Buffer.from(comparisonCsv(comparison));
  const manifest = {
    format: PACK_FORMAT, export_id: exportRow.id, company_id: companyId,
    period: { start: exportRow.periodStart, end: s.cutoff },
    snapshot: { id: s.id, cutoff: s.cutoff, taken_at: s.takenAt, taken_by: s.takenBy, trigger: s.trigger,
      canonical_hash: s.canonicalHash, hmac: s.hmac, key_id: s.keyId, check_run_id: s.checkRunId, caveat: s.caveat,
      verified_at_build: verification.status },
    comparison: comparison ? { against: comparison.against, counts: comparison.counts } : null,
    files: Object.entries(files).map(([name, b]) => ({ name, sha256: sha256Hex(b), bytes: b.length })),
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  const seal = sign(PACK_SEAL_DOMAIN, { companyId, id: exportRow.id, canonicalHash: sha256Hex(manifestText), cutoff: s.cutoff,
    takenAt: s.takenAt }, signingKey());
  const zip = new JSZip();
  const date = new Date(s.takenAt);
  zip.file('manifest.json', manifestText, { date });
  zip.file('manifest.sig.json', JSON.stringify({ domain: PACK_SEAL_DOMAIN, manifest_sha256: sha256Hex(manifestText),
    hmac: seal.hmac, key_id: seal.keyId }, null, 2), { date });
  for (const [name, b] of Object.entries(files)) zip.file(name, b, { date });
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const sum = (k: 'debit' | 'credit') => entries.reduce((t, e) => t + e.lines.reduce((x, l) => x + l[k], 0), 0);
  return { zip: buf, sha256: sha256Hex(buf), manifest, pdfSha256: pdf.sha, jeCount: entries.length,
    lineCount: entries.reduce((n, e) => n + e.lines.length, 0),
    documentCount: new Set(entries.map((e) => e.sourceDocumentId).filter(Boolean)).size,
    totalDebits: sum('debit'), totalCredits: sum('credit') };
}

/** Uploads the pack and marks the export ready, citing the snapshot. */
export async function storePack(exportRow: AuditExport, snapshotId: string, pack: BuiltPack): Promise<void> {
  const upload = await uploadCapturedDocument(exportRow.companyId, `audit-${exportRow.id}.zip`, pack.zip, 'application/zip');
  await sql`
    UPDATE audit_trail_exports
    SET status = 'ready', snapshot_id = ${snapshotId}::UUID, period_end = ${String((pack.manifest.period as { end: string }).end)}::DATE,
        je_count = ${pack.jeCount}, line_count = ${pack.lineCount}, document_count = ${pack.documentCount},
        total_debits = ${pack.totalDebits}, total_credits = ${pack.totalCredits}, pdf_sha256 = ${pack.pdfSha256},
        zip_storage_bucket = ${upload.bucket}, zip_storage_path = ${upload.path}, zip_sha256 = ${pack.sha256}, built_at = NOW()
    WHERE id = ${exportRow.id}::UUID AND company_id = ${exportRow.companyId}::UUID
  `;
  log.info('audit pack built from snapshot', { exportId: exportRow.id, snapshotId, sha256: pack.sha256 }, 'audit');
}

export interface PackVerification {
  status: 'valid' | 'invalid' | 'unknown_key'; zipMatches: boolean; files: { name: string; ok: boolean }[];
  snapshotId: string | null; snapshotStatus: string | null; manifestCitesSnapshot: boolean;
  /** The manifest's own seal; `missing` for a ZIP without manifest.json or manifest.sig.json. */
  manifestSeal: SealCheck | 'missing';
}

export async function verifyPack(companyId: string, exportId: string): Promise<PackVerification | null> {
  const e = await getExport(exportId, companyId);
  if (!e || !e.zipStoragePath || !e.snapshotId) return null;
  const buf = await downloadCapturedDocument(e.zipStorageBucket ?? 'captured-documents', e.zipStoragePath);
  const zipMatches = sha256Hex(buf) === e.zipSha256;
  const zip = await JSZip.loadAsync(buf);
  const manifestText = await zip.file('manifest.json')?.async('string');
  const sigText = await zip.file('manifest.sig.json')?.async('string');
  const snapshotStatus = (await verifySnapshot(companyId, e.snapshotId))?.status ?? null;
  if (!manifestText || !sigText) {
    return { status: 'invalid', zipMatches, files: [], snapshotId: e.snapshotId, snapshotStatus, manifestCitesSnapshot: false,
      manifestSeal: 'missing' };
  }
  const manifest = JSON.parse(manifestText) as {
    period: { end: string }; snapshot: { id: string; canonical_hash: string; taken_at: string }; files: { name: string; sha256: string }[] };
  const sig = JSON.parse(sigText) as { hmac: string; key_id: string };
  const manifestSeal = checkSeal(PACK_SEAL_DOMAIN, { companyId, id: exportId, canonicalHash: sha256Hex(manifestText),
    cutoff: manifest.period.end, takenAt: manifest.snapshot.taken_at }, String(sig.hmac), String(sig.key_id));
  const files = await Promise.all(manifest.files.map(async (f) => {
    const b = await zip.file(f.name)?.async('nodebuffer');
    return { name: f.name, ok: !!b && sha256Hex(b) === f.sha256 };
  }));
  const snap = await getSnapshot(companyId, e.snapshotId);
  const cites = manifest.snapshot.id === e.snapshotId && manifest.snapshot.canonical_hash === snap?.canonicalHash;
  const intact = zipMatches && cites && files.every((f) => f.ok) && snapshotStatus !== 'invalid' && manifestSeal !== 'invalid';
  const status = !intact ? 'invalid'
    : manifestSeal === 'unknown_key' || snapshotStatus === 'unknown_key' ? 'unknown_key'
      : manifestSeal === 'valid' && snapshotStatus === 'valid' ? 'valid' : 'invalid';
  return { status, zipMatches, files, snapshotId: e.snapshotId, snapshotStatus, manifestCitesSnapshot: cites, manifestSeal };
}
