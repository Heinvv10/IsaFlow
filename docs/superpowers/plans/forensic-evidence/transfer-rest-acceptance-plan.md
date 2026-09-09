# Actual transfer REST lifecycle

Base d5fe42c4c. Own new bankTransferRest.int.test.ts and bankTransferRestFixture.ts plus this plan only. Root owns production dispatch, inverse aliases and response contract.

Use actual Node apiResolver HTTP servers, withAuth cookie verification and CSRF, real database/approval services. Transfer creation must pass prepare_allocate with transfer/contraAccountId, requirements, request, independent cookie decision and allocate. GET both feed IDs must return the canonical original post intent. First inverse RED submits prepare_reverse using the saved opposite feed plus canonical original ID; success must return bankTransactionId of the canonical original, which requester uses with saved inverse intent/approval for execution. Late-link originalIntentId must canonicalize identically. Wrong owned/foreign bank and CSRF/current-rights refusals must not create effects or inverse intents.

Fresh synthetic tenant/pair per test; HTTP servers and fixture pools close per case, real auth pool closes after suite. No production access or endpoint mocks. Shared service proof is not substituted for HTTP success. No source edits. Serialized first RED then root implementation and final full acceptance.
