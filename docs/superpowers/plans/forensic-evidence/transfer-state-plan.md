# Fixed transfer state

Own bankAllocationTransferState.ts, backward-compatible authority option in transfer sources, exact-current-occupant option in candidate queries, and dedicated state tests. Before execution bind full candidate observation to saved choice; after execution query only saved identities, preserving late-arrival stability. Read authority is sufficient for material review; callers retain independent write guards. Existing candidate proof remains strict by default. Synthetic retained receipt fixtures prove state validation only, not producer completion.

Tests first: missing-module unit and PG collection RED recorded before implementation. Seven PG scenarios cover saved choice, fixed post state, late arrivals, imported reversed state, foreign/sign mismatch, exact occupied link provenance, tamper, and current read authority. No schema changes.

Implemented explicit read/write authority options with default write behavior preserved. Post-execution link proof permits exactly one destination occupant, the current saved bank row, with exact journal/line/reciprocal metadata. Original post state deliberately does not require allocated status because inverse validation also reads this fixed state. Parent owns economic-state checks and actual posting/reversal.

Initial seven actual PG cases passed (6c7cc2, pools closed); ten state/proof units and scoped lint passed (30418); source TypeScript passed (33452). Journal-tamper assertion subsequently strengthened with a valid occupied baseline; final state/helper regression passed all 17 actual PG assertions (ce52bf terminal 0, all pools closed). No actual transfer producer success claim.
