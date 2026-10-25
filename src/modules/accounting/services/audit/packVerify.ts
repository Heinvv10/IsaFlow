/**
 * Checking a stored audit pack (forensic-controls step 4), for `?verify=1` and before every download:
 *  1. the ZIP's own seal — zip_hmac over company | export | zip_sha256 (PACK_ZIP_SEAL_DOMAIN) — and the bytes'
 *     SHA-256: a row re-pointed at any other bytes fails here, whatever a ZIP parser would make of them;
 *  2. the raw central directory holds exactly the manifest's files plus manifest.json and manifest.sig.json, each
 *     once, none a directory (a shadow entry one parser skips and another extracts is refused);
 *  3. the manifest's seal (bound to this export id), every file against the manifest, and the cited snapshot.
 * A retired key vouches only for a pack built before it was retired, by the database's built_at. Entries are
 * inflated a chunk at a time and never past their cap.
 */
import JSZip from 'jszip';
import { z } from 'zod';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { downloadCapturedDocument } from '@/lib/supabaseStorage';
import { getExport, type AuditExport } from '@/modules/accounting/services/capture/auditTrailExportService';
import { sha256Hex } from './canonical';
import { PACK_SEAL_DOMAIN, PACK_ZIP_SEAL_DOMAIN, checkSeal, type SealCheck } from './seal';
import { getSnapshot } from './snapshotRead';
import { verifySnapshot } from './snapshotVerify';
import { PackRefusedError } from './packExport';

const Manifest = z.object({
  period: z.object({ end: z.string() }),
  snapshot: z.object({ id: z.string(), canonical_hash: z.string(), taken_at: z.string() }),
  files: z.array(z.object({ name: z.string(), sha256: z.string(), bytes: z.number().int().nonnegative() })),
});
const Sig = z.object({ hmac: z.string(), key_id: z.string() });

/** The manifest and its seal are small; anything larger is not one of ours and is not inflated. */
const MANIFEST_MAX_BYTES = 1024 * 1024;
const SIG_MAX_BYTES = 4096;

/** A verify holds a whole-ledger slot: the stored ZIP must arrive within this, or the verify fails. */
export const PACK_DOWNLOAD_TIMEOUT_MS = 60_000;

function parsed<T>(schema: z.ZodType<T>, text: string | undefined): T | null {
  if (!text) return null;
  try {
    const r = schema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch (err) {
    log.warn('audit pack: unreadable manifest', { error: err instanceof Error ? err.message : String(err) }, 'audit');
    return null;
  }
}

/** An entry's bytes, inflated a chunk at a time and abandoned past `cap` (null), whatever its header claims. */
function readCapped(zip: JSZip, name: string, cap: number): Promise<Buffer | null> {
  const entry = zip.file(name);
  if (!entry) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const stream = entry.nodeStream('nodebuffer');
    stream.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > cap) { done = true; stream.pause(); resolve(null); return; }
      chunks.push(chunk);
    });
    stream.on('error', (err: Error) => { if (!done) { done = true; reject(err); } });
    stream.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
  });
}

/** The entry count the ZIP's end-of-central-directory record declares (null when there is none). */
function centralDirectoryCount(buf: Buffer): number | null {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return buf.readUInt16LE(i + 10);
  }
  return null;
}

async function download(companyId: string, bucket: string, path: string): Promise<Buffer> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the stored pack did not download within ${PACK_DOWNLOAD_TIMEOUT_MS / 1000} s`)), PACK_DOWNLOAD_TIMEOUT_MS);
  });
  try {
    return await Promise.race([downloadCapturedDocument(bucket, path, companyId), late]);
  } finally {
    clearTimeout(timer);
  }
}

export interface PackVerification {
  status: 'valid' | 'invalid'; zipMatches: boolean; files: { name: string; ok: boolean }[];
  snapshotId: string | null; snapshotStatus: string | null; manifestCitesSnapshot: boolean;
  /** The ZIP bytes' own seal (zip_hmac); `missing` for a pack recorded without one. */
  zipSeal: SealCheck | 'missing';
  /** The manifest's own seal; `missing` for a ZIP without a readable manifest.json or manifest.sig.json. */
  manifestSeal: SealCheck | 'missing';
}

type FileCheck = Omit<PackVerification, 'status' | 'snapshotId' | 'snapshotStatus'> & { intact: boolean };

async function checkPackFile(companyId: string, e: AuditExport, buf: Buffer): Promise<FileCheck> {
  const zipMatches = sha256Hex(buf) === e.zipSha256;
  // The row's seal fields at full precision (the mapped export's built_at is a Date's toString, to the second).
  const [row] = (await sql`
    SELECT to_char(e.built_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS built_at, e.zip_hmac, e.zip_key_id,
           e.period_end::TEXT AS period_end, to_char(s.taken_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS taken_at
    FROM audit_trail_exports e
    LEFT JOIN audit_snapshots s ON s.id = e.snapshot_id AND s.company_id = e.company_id
    WHERE e.id = ${e.id}::UUID AND e.company_id = ${companyId}::UUID`) as {
      built_at: string | null; zip_hmac: string | null; zip_key_id: string | null; period_end: string; taken_at: string | null }[];
  const builtAt = row?.built_at ?? '';
  const zipSeal: FileCheck['zipSeal'] = !row?.zip_hmac || !row.zip_key_id ? 'missing'
    : checkSeal(PACK_ZIP_SEAL_DOMAIN, { companyId, id: e.id, canonicalHash: e.zipSha256 ?? '', cutoff: row.period_end,
      takenAt: row.taken_at ?? '' }, row.zip_hmac, row.zip_key_id, undefined, builtAt);
  const missing: FileCheck = { zipMatches, zipSeal, files: [], manifestCitesSnapshot: false, manifestSeal: 'missing', intact: false };
  // Bytes the seal does not vouch for are not parsed past this point.
  if (zipSeal !== 'valid' || !zipMatches) return missing;
  try {
    const zip = await JSZip.loadAsync(buf);
    const manifestText = (await readCapped(zip, 'manifest.json', MANIFEST_MAX_BYTES))?.toString('utf8');
    const manifest = parsed(Manifest, manifestText);
    const sig = parsed(Sig, (await readCapped(zip, 'manifest.sig.json', SIG_MAX_BYTES))?.toString('utf8'));
    if (!manifestText || !manifest || !sig) return missing;
    const manifestSeal = checkSeal(PACK_SEAL_DOMAIN, { companyId, id: e.id, canonicalHash: sha256Hex(manifestText),
      cutoff: manifest.period.end, takenAt: manifest.snapshot.taken_at }, sig.hmac, sig.key_id, undefined, builtAt);
    const snap = e.snapshotId ? await getSnapshot(companyId, e.snapshotId) : null;
    const cites = manifest.snapshot.id === e.snapshotId && !!snap && manifest.snapshot.canonical_hash === snap.canonicalHash;
    if (manifestSeal !== 'valid') return { ...missing, manifestCitesSnapshot: cites, manifestSeal };
    // Exactly these entries, each once, none a directory: what one parser skips, another extracts.
    const expected = new Set([...manifest.files.map((f) => f.name), 'manifest.json', 'manifest.sig.json']);
    const entries = Object.values(zip.files);
    const files = [];
    for (const f of manifest.files) {
      const b = await readCapped(zip, f.name, f.bytes);
      files.push({ name: f.name, ok: !!b && b.length === f.bytes && sha256Hex(b) === f.sha256 });
    }
    for (const x of entries) if (x.dir || !expected.has(x.name)) files.push({ name: x.name, ok: false });
    if (centralDirectoryCount(buf) !== expected.size || entries.length !== expected.size) files.push({ name: '(central directory)', ok: false });
    const intact = cites && files.length > 0 && files.every((f) => f.ok);
    return { zipMatches, zipSeal, files, manifestCitesSnapshot: cites, manifestSeal, intact };
  } catch (err) {
    log.warn('audit pack: unreadable ZIP', { exportId: e.id, error: err instanceof Error ? err.message : String(err) }, 'audit');
    return missing;
  }
}

export async function verifyPack(companyId: string, exportId: string): Promise<PackVerification | null> {
  const e = await getExport(exportId, companyId);
  if (!e || !e.zipStoragePath || !e.snapshotId) return null;
  const { intact, ...file } = await checkPackFile(companyId, e, await download(companyId, e.zipStorageBucket ?? 'captured-documents', e.zipStoragePath));
  const snapshotStatus = (await verifySnapshot(companyId, e.snapshotId))?.status ?? null;
  // Fail closed: valid only when every part is.
  return { status: intact && snapshotStatus === 'valid' ? 'valid' : 'invalid', ...file, snapshotId: e.snapshotId, snapshotStatus };
}

/** The stored ZIP of a ready snapshot pack, served only when it proves itself (no ledger read). */
export async function verifiedPackZip(companyId: string, e: AuditExport): Promise<Buffer> {
  if (!e.zipStoragePath) throw new PackRefusedError('This export has no pack ZIP.');
  const buf = await download(companyId, e.zipStorageBucket ?? 'captured-documents', e.zipStoragePath);
  const check = await checkPackFile(companyId, e, buf);
  if (!check.intact) {
    log.warn('audit pack: refused to serve a pack that does not verify', { exportId: e.id, zipMatches: check.zipMatches,
      zipSeal: check.zipSeal, manifestSeal: check.manifestSeal, cites: check.manifestCitesSnapshot }, 'audit');
    throw new PackRefusedError('This audit pack does not verify (its file or sealed manifest does not match what was built); it is not served.');
  }
  return buf;
}
