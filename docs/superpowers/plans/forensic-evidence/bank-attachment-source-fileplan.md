# Retained bank attachment source

Base da95b5add. Owned new files: bankAttachmentEvidenceStorage.ts, bankAttachmentEvidenceSource.ts, focused unit/PG tests and this fileplan.

Actual contract: migration250b creates parent-scoped bank_transaction_attachments with inline file_url, file_size and no recorded hash. bankTxAttachmentService, REST bank-tx-attachments and capture/query-reply writers all store data:<mime>;base64,<bytes>, bounded2MiB. No external storage namespace exists for this store. Arbitrary HTTP/other URLs are unsupported metadata, never fetched.

Source interface: loadOwnedBankAttachmentEvidence(ctx,id,signal) returns null for missing/foreign parent, otherwise {id,parentId,...result}. Result is status available with actual bytes, computed sha256, mediaType, recordedHashVerified:false, or status unavailable with safe explicit reason. Issued context/current read:bank-tx and owned parent locking precede decoding. SQL returns bounded file_url only. No authority or SQL exception conversion.

TDD: actual writer-format bytes, local HTTP trap zero requests, canonical base64/size/resource/cancellation, changed same-size bytes remain historical-authenticity unknown. PostgreSQL: actual shared upload and retained-read roundtrip, explicit URL unsupported, dual-member foreign parent refusal, current permission revocation, missing/cancelled source. Root owns migrations/retention coordinator and serialization leases.
