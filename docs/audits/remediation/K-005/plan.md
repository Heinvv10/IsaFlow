# K005 WhatsApp destination routing

Baseline222eb799. Registration accepts canonical E164 for the current authorized company, deactivates its old inbox then inserts; schema uniqueness is company-local. Inbound strips whatsapp: from To and chooses LIMIT1 active match. RealSQL/signed-SDK webhook reproduction: second company claims same number (200 rather than409), and valid webhook materializes an expense-review event under an arbitrary company instead of rejecting ambiguity. Missingcredentials503 and invalidsignature403 controls pass. No outbound message was sent: acknowledgement and extraction are local test sinks.

Corrected source scope: external senders may submit documents to this inbound channel; text commands explicitly await human review rather than auto-posting. Mere absence of company_users sender membership is not established as a bug. The supported issue is duplicate destination routing. A separate newly retained R003 candidate concerns proof of number ownership at first registration; uniqueness cannot establish that proof.

## Correction

- Migration617 reserves trimmed WhatsApp destinations globally across active and retired rows. Duplicate legacy destinations stop migration for review, never pick a tenant automatically.
- New company-scoped configuration service requires existing request transaction, takes a company-keyed transaction advisory lock to serialize changes, claims the address with ON CONFLICT DO NOTHING, and only deactivates the previous number after successful claim/reactivation. A conflicting other-company number returnsnull/HTTP409 without losing the old destination. Same-company repeats/reactivation are idempotent.
- Inbound requires exactly one active trimmed match and rejects ambiguity before query-reply routing, capture writes, extraction or acknowledgements. Preserve signature gates.
- Verify real registration→signed-webhook→correct event company, duplicates, failed-change preservation, same-company repeats, retired reservation, concurrent company configuration and pre-upgrade ambiguity. Test617 refusal/clean repeat upgrade. Run capture regressions, named review, fullCI, draftPR.

No provider ownership claim or live Twilio send. Existing destination conflicts and reassignment need separate reviewed repair/ownership evidence. No production migration or data repair. Historical replay253 remains open.

Initial company-row locking failed the real manager control (500 instead of200), because company UPDATE RLS is narrower than this existing route role. Replaced with transaction advisory locking; workflow-initial.log preserves this regression.
