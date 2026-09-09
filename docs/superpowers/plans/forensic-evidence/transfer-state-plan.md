# Fixed transfer state

Own bankAllocationTransferState.ts, backward-compatible authority option in transfer sources, exact-current-occupant option in candidate queries, and dedicated state tests. Before execution bind full candidate observation to saved choice; after execution query only saved identities, preserving late-arrival stability. Read authority is sufficient for material review; callers retain independent write guards. Existing candidate proof remains strict by default. Synthetic retained receipt fixtures prove state validation only, not producer completion.

Tests first: missing-module unit and PG collection RED recorded before implementation. Seven PG scenarios cover saved choice, fixed post state, late arrivals, imported reversed state, foreign/sign mismatch, exact occupied link provenance, tamper, and current read authority. No schema changes.
