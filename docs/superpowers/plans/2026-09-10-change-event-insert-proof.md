# Mandatory change INSERT retention

Base 1b3c9c973, isolated mcp-change-insert-proof-20260910. Root froze ownership to changeEventService.ts and dedicated actual PostgreSQL tests; no schema, contracts, registry or merge source changes.

The shared writer checks the version CAS but currently does not verify protected-evidence or event INSERT results. Scoped BEFORE INSERT RETURN NULL triggers will exercise both actual tables independently. The event case is a candidate silent bypass; protected-row suppression may already fail through the event foreign key, but must fail at its own insertion boundary instead of depending on that later constraint. The test checks that a caller catching the refusal cannot commit the prior account mutation, version, evidence or event. A positive case verifies the returned actual event identity and opens the complete encrypted values.

After genuine PG RED, add RETURNING id to both INSERTs and require exactly the server-generated expected ID. Keep current controlWriteFailed catch and transaction poison behavior. Preserve existing RAISE failure coverage through the current control suite. No new crypto, permission, publication, or event schema is introduced.

Actual tests and source/dedicated TypeScript run only under the root's serialized resource lease. Merge WIP is preserved separately at 71a4f91ff and is not verified or integrated.
