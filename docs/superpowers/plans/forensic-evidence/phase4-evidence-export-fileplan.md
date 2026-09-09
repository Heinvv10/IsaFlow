# Retained audit evidence export — file plan

Base: 346ff7c0fead8015f11168e113bf8f6b2f42fa89. Isolated branch/worktree mcp-forensic-evidence-export-20260909. Root owns scheduling, storage, transport and integration.

## Proposed interface

`exportAuditEvidence(ctx: ControlTx, snapshotId: string): Promise<AuditEvidenceBundle>` calls the real `readRetainedAuditSnapshot` to enforce issued context, current reader source permissions, tenant identity, authenticated snapshot and exact retained bytes. No caller-supplied data/results/options/limits. Service returns detached `files: {path, mediaType, bytes: Uint8Array, sha256, byteLength}[]`, `snapshotId`, `companyId`, `canonicalSnapshotHash`, and authenticated `manifest` (version/keyId/canonicalData/canonicalHash/authentication). Manifest HMAC uses existing independent snapshot key with separate export domain and binds all file byte hashes, snapshot identity/hash, exact populations/check totals, missing sources and coverage. No recursive manifest self-hash: manifest is the bundle envelope; delivery serializes it as manifest.json alongside listed files.

Files: snapshot.json (exact canonical bytes), snapshot-seal.json (signature metadata; reconstruct original seal with exact snapshot.json canonicalData), records.csv (every record, identity/version and canonical data JSON), checks.csv (every complete check including findings/sourceVersions as canonical JSON), evidence.pdf (actual PDFKit PDF containing every canonical snapshot field/record/check, readable ASCII-escaped JSON to preserve all Unicode without missing font glyphs), and evidence/000001.bin etc (safe generated names mapped to original evidence IDs/media types in manifest). No source references replace bytes. CSV quoting preserves exact values; JSON-encoded arbitrary cells prevent spreadsheet formula execution without losing original values.

Complete export or explicit resource-limit refusal. Hard limits: canonical source100 MiB, retained evidence100 MiB, complete emitted bundle1 GiB, PDF600 MiB /25000 pages, render60seconds. The source bound remains identical to capture/seal. Output is separately bounded because canonical JSON, CSV quoting, Unicode escapes and PDF structure amplify retained material; no16MiB source restriction. Complete bundle cap allows roughly100MiB JSON +200MiB CSV +600MiB PDF +100MiB evidence with metadata headroom, with earlier incremental checks and explicit refusal for atypical amplification. The full seal avoids duplicating canonicalData. Check runtime and output budget incrementally; no truncation. Existing full retained read has its own100MiB source/100000record bound before stricter renderer budget. PDF rendered-byte hash independent from stable canonical snapshot hash; repeated PDF byte identity not promised.

## Owned files

- controls/auditEvidenceExportService.ts: authenticated retained load and orchestration, bundle assembly.
- controls/auditEvidenceExportMaterial.ts: CSV/full data serialization, manifest sealing/verification and artifact hashes, resource contract/types.
- controls/auditEvidenceExportPdf.ts: actual PDFKit complete rendering with page/time/output bounds.
- tests/unit/services/controls/auditEvidenceExport.test.ts: complete >1000 records; exact totals/unknown/missing evidence; actual PDF parse; CSV special characters; all artifact hashes; changed artifact rejection; detached and getter refusal; bounds.
- tests/integration/controls/auditEvidenceExport.int.test.ts (+ fixture file if300line limit requires): actual encrypted publication→export, current source permission revocation, foreign tenant refusal, retained bytes stable after original source changes, no writes to snapshot storage.

## Tests first

Record absent export capability RED before implementation. Actual PDF parser verifies first/last row and all row markers. PostgreSQL uses synthetic private fixture only after root lease. Unit/PDF tests precede sourceTS/scopedlint/PG; report exact handles and pool closure. No shared root files edited.

## Author verification

- Missing export module RED (terminal1), then3unitsGREEN including actual PDFParse with1002complete record markers and full unknown check/totals. Compact seal metadata regression RED (1/6failed), then6unitsGREEN. Tests verify manifest authentication, changed bytes, missing file/evidence, foreign expected identity, source detachment, accessor-envelope refusal and expired render deadline.
- Three actual PostgreSQL tests handle27502 terminal0/pool.end: retained publication/export after original journal description changes; current payroll source permission denial; foreign tenant and privileged retained-byte tamper refusal. Uses only645retained tables, does not rely oncaptured_documents.raw_bytes. Existing synthetic fixture used; no fresh full-schema reconstruction claimed.
- Source TypeScript33804 terminal0 (before compact seal refinement); finalsourceTS recorded below. Scoped source ESLint60784 terminal0. Test paths cannot be linted via existing project-service config because repositorytsconfigexcludes them; initial combined invocation reported only those2configuration errors.
- Actual large pure renderer88109 terminal0:100000records,27500342canonicalbytes (>16MiB),58314819outputbytes including4514195PDFbytes;9171msrender/bundle time; maxRSS1276564KiB (~1.22GiB). All100000records are passed to full PDF/CSV loops, no first-page fallback. The1002record actual PDF parser test independently checks every record marker. Large workload is a resource measurement, not a claim that every100MiB shape completes under60seconds. Overflow/time refusal remains explicit.
- Measurement source/output preserved in artifacts/export-100000-measure.ts and export-100000-measure.json. Peak memory is material; root asynchronous scheduling must isolate/limit heavy export concurrency. Transport/archive delivery remains root-owned.

Final verification: sourceTS43156 terminal0; final3PostgreSQL29309 terminal0, afterAllpool.end and process exit confirmed;6unit tests/scopedsourceESLint60784 terminal0. Allowned files below300lines. Both exclusiveDB/TSslots returned to root. No production changes, no HTTP/archive/job integration claim, no fresh full-schema proof.
