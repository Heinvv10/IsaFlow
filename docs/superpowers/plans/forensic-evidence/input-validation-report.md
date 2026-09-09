# MCP central input validation evidence

Baseline: `34751e31`. Isolated branch: `feat/mcp-forensic-input-validation-20260909`.
This task adds a pure validator and contract fixtures; registry integration remains the root task.

## Contract

`validateToolArguments(tool, args)` returns `{ ok: true, args }` preserving raw arguments, or `{ ok: false, message }` with no argument values in errors. It executes no handlers, authentication, metering, approvals or SQL.

The validator covers every keyword used by the frozen 131-tool schema inventory: `type`, `description`, `properties`, `additionalProperties`, `required`, `format` (calendar date), `enum`, `minimum`, `maximum`, `exclusiveMinimum`, `items`, `minItems`, `maxItems`, and `maxLength`. Unknown schema keywords fail closed, including unused optional branches. It validates nested required fields, unions, finite numbers, safe integers, bounds, real dates and Unicode codepoint string lengths. It rejects malformed roots, extra properties, sparse/decorated arrays, accessors, hidden/symbol properties, cycles and non-JSON values. Depth/node limits bound argument traversal.

Writes require a nonblank idempotency key and allow the existing top-level `company_id` assertion (UUID, or existing null/undefined ignore behavior). The registry must still compare tenant identity. No authority fields are added. Any supplied `dry_run`, including false, is rejected when the tool does not advertise it.

`inputCompatibility.ts` explicitly records named numeric-string conversions, nullable defaults, and 32 existing limit clamps, with baseline source references. Compatible raw arguments are preserved so the existing adapters perform their original conversion/default/floor/clamp. This is not global numeric coercion: unlisted numeric fields remain strict, and booleans, empty numeric strings and nonfinite values are rejected. Semantic financial checks beyond the declared schema, including money precision, unannotated IDs and field combinations, remain adapter responsibilities.

## Proof and limits

The two focused files pass **302 tests**: 38 validator cases and 264 matrix cases. The matrix checks all 131 actual tool schemas against the frozen inventory, all nested required paths, scope/write/post/per-user-idempotency flags, representative full-property schema samples, unsupported authority arguments, dry-run advertisement, and the actual existing registry's scope/post/idempotency/company fences. Write cases also check replay and hash conflicts with synthetic handlers. SQL fragments may be constructed during module imports, but executing financial SQL throws in the test mock. Financial handlers never run.

These are schema and mocked registry authorization/replay proofs, not successful financial workflows or persisted live permission proofs. Phase 5 financial workflow validation remains pending. Root's forthcoming current-permission registry gate will require explicit test dependency setup and additional integration proof.

TDD evidence: the initial run failed because the validator module did not exist. A subsequent concrete adversarial regression failed because a proxy-thrown error could echo a secret; the validator now returns a generic error for untrusted exceptions, and the regression passes. An array test tuple-shape issue caught by TypeScript was corrected to exercise actual empty and oversized arrays.

Verification on 2026-09-09, Node 22.23.1:

- Focused Vitest suite: 2 files, 302 passed, 10.47 seconds (`/tmp/forensic-input-green.log`).
- Focused TypeScript project covering both sources and tests: exit 0 (`/tmp/forensic-input-types.log`).
- ESLint on both source files: exit 0 (`/tmp/forensic-input-lint.log`).
- Concrete failing privacy regression: 1 failed, 37 passed before correction (`/tmp/forensic-input-red-privacy.log`).
- All four code files are below 300 lines.

No new dependencies, database operations, build, full CI, deployment or registry edits were performed. Existing dependencies were reused after verifying the worktree lockfile matched the dependency-owning worktree.

## Integration handoff

Resolve the tool and retain authentication/scope/post fences, then validate unknown arguments before accessing fields, hashing, charging or invoking a handler. Use successful result arguments. Keep authenticated company/person/grant identity and company-assertion matching in the registry/context boundary. Future schema vocabulary additions must extend the bounded validator and fixtures before being accepted.
