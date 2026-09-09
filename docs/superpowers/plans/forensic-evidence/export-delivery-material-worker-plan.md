# Pure export delivery material

Base c6c5ec620, isolated mcp-forensic-export-delivery-material-20260909. Own auditExportDeliveryMaterial.ts, auditExportDeliveryValidation.ts, dedicated unit tests and this record only.

Async exportDeliveryRows(bundle, identity, permissions, options?) yields one authenticated header, then each file descriptor and its 256 KiB chunks. Identity includes tenant, snapshot/hash, job, lease and generation. Validate signed manifest and every actual byte before yielding header; reconstruct original authenticated snapshot from the mandatory JSON/seal files and derive exact permissions with existing source-family validation. Append full signed manifest.json, count all files and bytes against 100006/1 GiB. Preserve original fields and values without credential stripping.

Openers openExportDeliveryHeader(envelope, expectedIdentity), openExportDeliveryFile(envelope, brandedHeader, ordinal), openExportDeliveryChunk(envelope, brandedFile, ordinal) use export-specific shared crypto domains and immutable private brands. Compare complete identities and descriptors, exact chunk ordinal/length and canonical base64. Whole-file hash is authenticated in every chunk descriptor; consumers reconstruct and verify aggregate hash.

Detach input metadata through descriptors without invoking getters. Keep private verified byte copies to prevent mutation across generator yields. Copy/hash with cooperative timer checkpoints; never hold a second complete encrypted bundle. Plaintext copies do add memory to the already materialized renderer bundle; integrated worker memory/time acceptance remains root-owned and unverified here.

TDD: real rendered bundle reconstruction including multichunk UTF8/evidence/full manifest; wrong identity/hash/permissions; tampered last file before any header; envelope swap/generation/truncation; rejected accessors; native timer abort; post-header caller mutation; strict resource schemas. No SQL, scheduling, registry or production edits.

## Verification

- Tests-first b1b0bfa66: initial missing-module RED (2c5eff terminal1); no business assertions ran at that baseline. Initial implementation89005 ran five actual tests, three failed because the strict original snapshot verifier was passed the larger delivery identity; corrected to exact company/snapshot fields. This was an integration correction, not a business bypass RED.
- Initial five actual renderer/crypto tests90121 terminal0; expanded nine57534 terminal0; final strengthened byte-reconstruction/mutation tests14509 terminal0, nine passed. Includes complete PDF/CSV/JSON/original evidence and signed manifest reconstruction, zero-count payroll permission derivation, source-manifest consistency, no header before last-byte verification, cross-domain/brand/generation/chunk failures, native timer cancellation and intrinsic byte length.
- Exact 100006-file and 1 GiB descriptor boundaries exercised without allocating a gigabyte. This proves validation boundaries only, not a full-size export's completion or process memory budget.
- Source TypeScript40807 terminal0; scoped source ESLint48653 terminal0; git diff --check clean. No DB tests, registry edits or production operations. Heavy lease returned. Independent named review remains required before integration.
