# Transfer reversal acceptance

Base 6559af16d, independently reviewed producer. Own only new bankTransferReversal.int.test.ts, small dedicated fixture and this plan. Reuse real transferControlFixture producer and actual requirements/request/independent cookie approval; no fabricated post receipts. Root owns all source and migrations.

1. First RED: prepare an inverse of an actual approved transfer post. Existing source still performs candidate discovery and requires imported status, so this must fail before correction.
2. Both signs: exactly one inverse journal with exact swapped bank legs; clear original and initially saved opposite bank pointers and reciprocal transfer metadata. Preserve original journal/intent/effect/history. No payment or invoice mutation.
3. Late link: prepare through actual link intent ID, persist canonical original post intent ID, inverse original and verified late-linked feed only. New unlinked matching arrivals remain imported and untouched.
4. Approved retry returns one inverse effect; competing approved inverses yield at most one contra.
5. Changed source, opposite, original journal or current posting permission refuses with unchanged storage.
6. Inject exact synthetic-company bank reset failure inside actual execution; catch inside request transaction and verify savepoint rollback of bank/journal/event/effect/approval state. Retry after removing fixture trigger succeeds.

Shared-service acceptance does not establish feed-ID reader/adapter resolution or legacy auto-link safety. Tests use only the validated synthetic localhost fixture, with serialized database lease. Every fixture closes its pool.
