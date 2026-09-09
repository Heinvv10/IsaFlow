# Pure export delivery material

Base c6c5ec620, isolated mcp-forensic-export-delivery-material-20260909. Own auditExportDeliveryMaterial.ts, auditExportDeliveryValidation.ts, dedicated unit tests and this record only.

Async exportDeliveryRows(bundle, identity, permissions, options?) yields one authenticated header, then each file descriptor and its 256 KiB chunks. Identity includes tenant, snapshot/hash, job, lease and generation. Validate signed manifest and every actual byte before yielding header; reconstruct original authenticated snapshot from the mandatory JSON/seal files and derive exact permissions with existing source-family validation. Append full signed manifest.json, count all files and bytes against 100006/1 GiB. Preserve original fields and values without credential stripping.

Openers openExportDeliveryHeader(envelope, expectedIdentity), openExportDeliveryFile(envelope, brandedHeader, ordinal), openExportDeliveryChunk(envelope, brandedFile, ordinal) use export-specific shared crypto domains and immutable private brands. Compare complete identities and descriptors, exact chunk ordinal/length and canonical base64. Whole-file hash is authenticated in every chunk descriptor; consumers reconstruct and verify aggregate hash.

Detach input metadata through descriptors without invoking getters. Keep private verified byte copies to prevent mutation across generator yields. Copy/hash with cooperative timer checkpoints; never hold a second complete encrypted bundle. Plaintext copies do add memory to the already materialized renderer bundle; integrated worker memory/time acceptance remains root-owned and unverified here.

TDD: real rendered bundle reconstruction including multichunk UTF8/evidence/full manifest; wrong identity/hash/permissions; tampered last file before any header; envelope swap/generation/truncation; rejected accessors; native timer abort; post-header caller mutation; strict resource schemas. No SQL, scheduling, registry or production edits.
