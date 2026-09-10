# Platform import persisted approval PostgreSQL evidence

Owner: platform_approval_pg. Exact base: ae8e5542d. Owned files are platformImportApproval.int.test.ts and platformImportApprovalFixture.ts under tests/integration/controls, plus this document. Root owns all implementation and migration 674.

The fixture uses validated disposable PostgreSQL, a real platform_admin transaction and privately issued platform-import context. The maker is an active global administrator with zero tenant memberships. Reviewer transactions use actual app_user and existing member-cookie service authority. This suite does not test HTTP authentication or browser rendering; A1 actual middleware evidence is separate, and final admin REST/UI lifecycle remains required.

File-level scenarios: retain exact normalized synthetic CSV JSON original bytes; prepare full 2023 AR/AP groups; request persisted approval; independent current tenant administrator reviews; execute concurrently and retry with exact net 1000, VAT 150, gross 1150, one journal and document/effect; keep original period closed. Additional tests cover same-person member/token review, revoked maker/reviewer before effects and replay, changed account/source, mismatched retention/preparation target, and ordinary journal approval refusal.

Status: tests written first; actual PostgreSQL RED run queued behind root full CI. No pass or capability claim. The normalized upload is synthetic retained evidence, not authenticated Sage export provenance.
