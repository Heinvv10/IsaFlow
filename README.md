# IsaFlow

Multi-tenant accounting SaaS built on Next.js 14 and TypeScript. Deployed at app.isaflow.co.za.

## Prerequisites

- Node.js >= 20.12.0 (see `.nvmrc`)
- Bun >= 1.3.0
- Supabase instance (self-hosted or cloud); connection string in `DATABASE_URL`

## Quickstart

```bash
nvm use
bun install
cp .env.example .env.local
# Fill in DATABASE_URL and other required vars in .env.local
bun run dev
```

The dev server starts on http://localhost:3200.

## Key commands

```bash
bun run dev          # Start dev server (port 3200)
bun run build        # Production build
bun run lint         # ESLint
bun run type-check   # TypeScript type check
bun run test:unit    # Vitest unit tests
bun run test:e2e     # Playwright E2E tests
bun run ci           # Full CI gate
bun run db:migrate   # Apply pending migrations
```

## Further reading

- [CLAUDE.md](CLAUDE.md) — architecture rules, coding standards, and agent guidelines
- [CHANGELOG.md](CHANGELOG.md) — release history
- [docs/](docs/) — module docs, PRDs, and ops runbooks
