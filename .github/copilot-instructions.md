<!-- Copilot instructions auto-generated from CLAUDE.md by /portability. -->
<!-- Canonical source: CLAUDE.md — do not edit manually. -->

# GitHub Copilot Instructions — IsaFlow

## Tech Stack
- Next.js 14 (Pages Router) + TypeScript strict + React 19 + Tailwind
- Postgres on self-hosted Supabase (NOT Neon Serverless) — `@/lib/neon` is a legacy import path
- Auth: GoTrue (Supabase Auth) via `withAuth` from `@/lib/auth`
- Package manager: `bun@1.3.2`. Node `>=20.12.0`. Vitest 4 + Playwright.

## Code Standards
- 100% TypeScript coverage; no `any` outside Next.js patterns. Max 300 lines per file.
- No `console.log` — use `log` from `@/lib/logger`.
- No empty `catch` blocks.
- `sql` tagged template from `@/lib/neon` only — never string-concat queries.
- Every DB query MUST scope by `company_id`.

## Critical Rules
- ALWAYS create a working branch first (`git checkout -b <name>`); never edit on `master`.
- API handlers: `withAuth(withErrorHandler(handler as any))` (legacy `withCompany` is removed).
- Customer invoices: use `COALESCE(ci.client_id, ci.customer_id)` for joins.
- pg returns `Date` objects from timestamp columns — handle both `Date` and `string` shapes.
- Migrations: next unused 3-digit prefix, `IF NOT EXISTS` on every `CREATE`.
- No stub implementations to satisfy a typecheck — build the real thing.

## API Conventions
- Response helpers: `apiResponse.success / badRequest / notFound / methodNotAllowed` from `@/lib/apiResponse`.
- Clients always unwrap `json.data.<field>`.
- For role gates, compose `withRole` inside `withAuth`. Pure JWT routes use `withUserAuth`.

## Quality Gates
- `bun run lint` — ESLint
- `bun run type-check` — tsc --noEmit
- `bun run test:unit` — Vitest
- `bun run ci` — full CI gate (required before any PR)

## Module-level rules
49 sibling `.claude.md` / `AGENTS.md` files exist under `src/modules/*` and `pages/api/accounting/*`. Read the relevant one before editing a module.
