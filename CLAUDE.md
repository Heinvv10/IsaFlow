# IsaFlow — CLAUDE.md

## Project

Next.js 14 + TypeScript accounting SaaS. Multi-tenant (every query scoped by `company_id`). Deployed to `app.isaflow.co.za`. Package manager: **bun**.

## Critical Rules (ALL code, ALL agents)

- **Multi-tenant**: ALWAYS add `company_id` to every DB query. Never return data across tenants.
- **DB**: Use `sql` tagged template from `@/lib/neon` — NEVER string concatenation.
- **API handlers**: Wrap with `withCompany(withErrorHandler(handler as any))`.
- **Responses**: Use `apiResponse.success()`, `.badRequest()`, `.notFound()` from `@/lib/apiResponse`.
- **Logging**: Use `log` from `@/lib/logger` — NEVER `console.log`.
- **Error handling**: No empty `catch` blocks.
- **Types**: 100% TypeScript coverage. No `any` except where required by Next.js patterns.
- **File size**: Max 300 lines per file.
- **Dates**: Neon returns `Date` objects — handle both `Date` and `string` shapes.
- **Customer invoices**: Use `COALESCE(ci.client_id, ci.customer_id)` — both columns exist.
- **Nav**: Update `accountingNavConfig.ts` for every new page.
- **Migrations**: `IF NOT EXISTS` on all `CREATE TABLE` / `CREATE INDEX`.
- **Migrations**: Use the next unused 3-digit prefix. Never reuse an existing prefix. Use `244b_` style suffix if inserting between existing numbers.

## Key Paths

| What | Where |
|------|-------|
| DB client | `src/lib/neon.ts` |
| API response helpers | `src/lib/apiResponse.ts` |
| Logger | `src/lib/logger.ts` |
| Auth middleware | `src/lib/withCompany.ts` |
| Services | `src/modules/accounting/services/` |
| API routes | `pages/api/accounting/` |
| UI pages | `pages/accounting/` |
| Migrations | `scripts/migrations/sql/` |
| Nav config | `src/components/layout/accountingNavConfig.ts` |
| Unit tests | `tests/unit/` |
| E2E tests | `tests/e2e/` |

## Commands

```bash
bun run dev          # Start dev server
bun run build        # Production build
bun run test:unit    # Vitest unit tests
bunx tsc --noEmit    # Type check
bash scripts/deploy.sh  # Deploy
```

## Testing

- Unit tests: Vitest in `tests/unit/services/`
- E2E: Playwright in `tests/e2e/`
- TDD enforced: tests FIRST, implementation second

## Plugins Active

- `/frontend-design` — bold/distinctive UI components (avoid generic AI aesthetics)
- `/superpowers` — git worktrees, TDD, parallel agents, debugging
- `context7` MCP — fetch live docs for Next.js, React, Neon, etc.
- `/code-review` — multi-agent PR code review
- `github` MCP — GitHub API (requires `GITHUB_PERSONAL_ACCESS_TOKEN`)
- `/skill-creator` — create/iterate new skills
- `/revise-claude-md` — update this file after sessions
- `typescript-lsp` — TS go-to-def, find-references, error checking
- `/review-pr` — comprehensive PR review with specialized agents
- `telegram` MCP — Telegram notifications (deploy alerts, etc.)
