# K-004 email inbox identity and routing

Baseline de4d3d62. generateInboxAddress truncates4 random bytes to6hex (24bits). Current schema unique(company_id,channel,address) permits the same email address in multiple companies. inboundEmailService resolves one exact address with LIMIT1 on privileged pool. Three realSQL regression failures before app changes: entropy format mismatch; two companies got identical cap-111111 address; ambiguous legacy destination stored an invoice/event under one arbitrarily selected company. Storage only is a local sink; routing/event/document SQL is real. See red.log.

## Correction and verification plan

- Generate16 random bytes rendered as32hex (128bits), preserving prefix/domain and existing addresses until authorized rotation.
- Add next unused migration616: global case-insensitive unique email-address index covering active AND retired addresses, so old recipients cannot be reassigned to another company. Existing duplicate normalized addresses abort migration without deleting/rotating records; require reviewed remediation. Other channels unchanged.
- INSERT ON CONFLICT DO NOTHING with bounded5 retries. Do not catch a PostgreSQL unique exception and retry in an aborted request transaction. Non-conflict database errors propagate.
- Inbound lookup matches lower(address), reads at most2active email matches and rejects ambiguity before storage/doc/event writes. This protects a pre-migration legacy database too.
- Verify migration duplicate refusal without data change, clean upgrade and repeat apply, case-insensitive/retired uniqueness, actual transaction retry, mint→rotate→ingest tenant identity and unknown/ambiguous destination denial. Maintain existing sender-domain checks. Run capture regression/fullCI, named review and draft PR.

No production migration, automatic rotation, message or historical repair authorized. Existing short unique addresses remain live until an owner-approved rotation plan informs senders. Existing collisions need scoped impact review, not arbitrary winner selection. Historical captured documents may need provenance review; no claim that future uniqueness repairs old attribution. Rollback must consider index protection and retained addresses, not only code revert. Historical pristine replay253 stays open; migration616 tested separately on empty current-schema fixture.
