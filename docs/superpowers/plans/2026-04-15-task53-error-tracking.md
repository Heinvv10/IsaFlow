# Task #53 — Multi-Project Error Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up Bugsink (OSS Sentry-compatible error tracker) on Velocity and wire it into ISAFlow with tenant-aware tags, PII scrubbing, source maps, and Telegram alerts.

**Architecture:** One Bugsink Docker container behind nginx at `errors.isaflow.co.za`; three projects (isaflow, fibreflow, apexgeo) created server-side but only ISAFlow gets SDK integration in this task. ISAFlow uses `@sentry/nextjs` (Bugsink is Sentry-SDK compatible) with a `beforeSend` scrubbing hook, `company_id`/`user_id`/`request_id` tags, and source-map upload hooked into `scripts/deploy.sh`. Cutover is gated behind `SENTRY_ENABLED=true` so the SDK ships dark first.

**Tech Stack:** Bugsink (Docker), nginx, systemd, `@sentry/nextjs`, Next.js 14 pages-router, Vitest, bun.

**Spec:** `docs/superpowers/specs/2026-04-15-task53-error-tracking-design.md`

---

## File Structure

**New files (ISAFlow repo):**
- `src/lib/sentry/scrub.ts` — `beforeSend` hook, pure function, unit-testable
- `src/lib/sentry/tags.ts` — `setTenantTags(ctx)` helper; called from `withCompany`
- `tests/unit/sentry/scrub.test.ts` — scrub unit tests
- `tests/unit/sentry/tags.test.ts` — tag helper tests
- `sentry.server.config.ts` — server init (repo root, per Next.js convention)
- `sentry.edge.config.ts` — edge init
- `sentry.client.config.ts` — browser init
- `instrumentation.ts` — re-exports server/edge config per Sentry wizard output

**New files (Velocity server):**
- `/etc/systemd/system/bugsink.service`
- `/etc/nginx/sites-available/errors.isaflow.co.za`
- `/home/velo/bugsink/.env` (SECRET_KEY, BASE_URL, etc.)
- `/home/velo/bugsink/backup.sh` + crontab entry

**Modified files (ISAFlow repo):**
- `package.json` — add `@sentry/nextjs` dep
- `next.config.js` — wrap with `withSentryConfig`
- `src/lib/auth/withCompany.ts` — call `setTenantTags` after company resolved
- `src/lib/api-error-handler.ts` — call `setTenantTags({requestId})` in the try block
- `scripts/deploy.sh` — export `GIT_SHA`, run `sentry-cli releases` steps, fail-open
- `.env.example` — add `SENTRY_ENABLED`, `SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_URL`, `SENTRY_ORG`, `SENTRY_PROJECT`

**Modified files (Velocity server):**
- `/home/velo/isaflow/.env.local` — add Sentry env vars (manual step)

---

## Phase A — Bugsink server on Velocity

> These tasks run as SSH commands on the Velocity box (`100.96.203.105`). They do NOT touch the ISAFlow repo. Verify each step before moving on.

### Task A1: Create Bugsink working directory and env file

**Files:**
- Create: `/home/velo/bugsink/.env` (on Velocity)

- [ ] **Step 1: SSH to Velocity and create directory**

```bash
ssh velo@100.96.203.105
sudo -u velo mkdir -p /home/velo/bugsink
```

- [ ] **Step 2: Write `/home/velo/bugsink/.env`**

```bash
sudo -u velo tee /home/velo/bugsink/.env > /dev/null <<'EOF'
SECRET_KEY=__REPLACE_WITH_RANDOM__
BASE_URL=https://errors.isaflow.co.za
BEHIND_HTTPS_PROXY=true
CREATE_SUPERUSER=admin:__REPLACE_WITH_PASSWORD__
PORT=8000
EOF
sudo chmod 600 /home/velo/bugsink/.env
```

- [ ] **Step 3: Replace placeholders with real secrets**

```bash
SECRET=$(openssl rand -hex 32)
PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 20)
sudo -u velo sed -i "s|__REPLACE_WITH_RANDOM__|$SECRET|" /home/velo/bugsink/.env
sudo -u velo sed -i "s|__REPLACE_WITH_PASSWORD__|$PASS|" /home/velo/bugsink/.env
echo "Admin password (save this to 1Password NOW): $PASS"
```

- [ ] **Step 4: Verify .env file**

```bash
sudo cat /home/velo/bugsink/.env | grep -c "^[A-Z_]*=.\+"
```
Expected: `5` (five non-empty env vars)

### Task A2: Launch Bugsink container

**Files:**
- Create: `/etc/systemd/system/bugsink.service` (on Velocity)

- [ ] **Step 1: Write systemd unit**

```bash
sudo tee /etc/systemd/system/bugsink.service > /dev/null <<'EOF'
[Unit]
Description=Bugsink error tracker
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=simple
Restart=on-failure
RestartSec=5s
ExecStartPre=-/usr/bin/docker rm -f bugsink
ExecStart=/usr/bin/docker run --rm --name bugsink \
  --env-file /home/velo/bugsink/.env \
  -p 127.0.0.1:8200:8000 \
  -v bugsink-data:/data \
  bugsink/bugsink:latest
ExecStop=/usr/bin/docker stop bugsink

[Install]
WantedBy=multi-user.target
EOF
```

- [ ] **Step 2: Enable and start**

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bugsink
sleep 10
sudo systemctl status bugsink --no-pager | head -15
```
Expected: `active (running)` in the status output.

- [ ] **Step 3: Verify HTTP response locally**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8200/
```
Expected: `200` or `302` (redirect to login).

### Task A3: Nginx vhost with Let's Encrypt

**Files:**
- Create: `/etc/nginx/sites-available/errors.isaflow.co.za` (on Velocity)

- [ ] **Step 1: Add DNS A record**

Manual step outside the box: in the DNS provider for `isaflow.co.za`, create:
```
errors.isaflow.co.za.  A  <velocity public IP>  TTL 300
```
Verify: `dig +short errors.isaflow.co.za` returns the IP.

- [ ] **Step 2: Write nginx vhost (HTTP-only bootstrap for certbot)**

```bash
sudo tee /etc/nginx/sites-available/errors.isaflow.co.za > /dev/null <<'EOF'
server {
  listen 80;
  server_name errors.isaflow.co.za;

  location /.well-known/acme-challenge/ {
    root /var/www/html;
  }

  location / {
    proxy_pass http://127.0.0.1:8200;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 10m;
  }
}
EOF
sudo ln -sf /etc/nginx/sites-available/errors.isaflow.co.za /etc/nginx/sites-enabled/errors.isaflow.co.za
sudo nginx -t && sudo systemctl reload nginx
```
Expected: `nginx: configuration file ... test is successful`.

- [ ] **Step 3: Obtain Let's Encrypt cert**

```bash
sudo certbot --nginx -d errors.isaflow.co.za --non-interactive --agree-tos -m hein@velocityfibre.co.za
```
Expected: cert installed; certbot rewrites the vhost to listen on 443.

- [ ] **Step 4: Verify HTTPS end-to-end**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://errors.isaflow.co.za/
```
Expected: `200` or `302`.

### Task A4: Create Bugsink projects via UI

- [ ] **Step 1: Log in to Bugsink**

Open `https://errors.isaflow.co.za` in a browser; log in with `admin` + the password saved in Task A1 Step 3.

- [ ] **Step 2: Create team**

UI: Teams → New Team → name `isaflow-platform`.

- [ ] **Step 3: Create 3 projects**

For each of `isaflow`, `fibreflow`, `apexgeo`:
- UI: Projects → New Project → platform `javascript-nextjs` → team `isaflow-platform` → name as above.
- Copy the DSN shown on the next screen — there will be three DSNs.

- [ ] **Step 4: Record DSNs**

Save in 1Password (or wherever secrets live) under `Bugsink DSNs`:
- `SENTRY_DSN_ISAFLOW` = ...
- `SENTRY_DSN_FIBREFLOW` = ...
- `SENTRY_DSN_APEXGEO` = ...

### Task A5: Nightly backup cron

**Files:**
- Create: `/home/velo/bugsink/backup.sh` (on Velocity)

- [ ] **Step 1: Write backup script**

```bash
sudo -u velo tee /home/velo/bugsink/backup.sh > /dev/null <<'EOF'
#!/bin/bash
set -e
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT=/home/velo/bugsink/backups
mkdir -p "$OUT"
docker run --rm \
  -v bugsink-data:/data:ro \
  -v "$OUT":/backup \
  alpine tar czf "/backup/bugsink-$TS.tar.gz" -C /data .
find "$OUT" -name 'bugsink-*.tar.gz' -mtime +14 -delete
EOF
sudo chmod +x /home/velo/bugsink/backup.sh
```

- [ ] **Step 2: Install crontab entry**

```bash
( sudo -u velo crontab -l 2>/dev/null; echo "15 2 * * * /home/velo/bugsink/backup.sh >> /home/velo/bugsink/backup.log 2>&1" ) | sudo -u velo crontab -
sudo -u velo crontab -l | grep bugsink
```
Expected: the new cron line is visible.

- [ ] **Step 3: Dry-run the backup now**

```bash
sudo -u velo /home/velo/bugsink/backup.sh
ls -lh /home/velo/bugsink/backups/
```
Expected: one `bugsink-*.tar.gz` file, non-zero size.

---

## Phase B — PII scrub module (TDD, code-only, not wired yet)

> From here on, all work is in the ISAFlow repo. Land B and C merged-but-dark (`SENTRY_ENABLED=false`) before any runtime call to `Sentry.init`.

### Task B1: Scrub module — failing test first

**Files:**
- Create: `tests/unit/sentry/scrub.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/sentry/scrub.test.ts
import { describe, it, expect } from 'vitest';
import { scrubEvent } from '@/lib/sentry/scrub';
import type { Event } from '@sentry/nextjs';

describe('scrubEvent', () => {
  it('redacts password/token/secret keys in request data', () => {
    const event: Event = {
      request: {
        data: { email: 'foo@bar.com', password: 'hunter2', csrf_token: 'abc', otp: '123456' },
      },
    };
    const out = scrubEvent(event);
    const data = out!.request!.data as Record<string, unknown>;
    expect(data.password).toBe('[REDACTED]');
    expect(data.csrf_token).toBe('[REDACTED]');
    expect(data.otp).toBe('[REDACTED]');
    expect(data.email).toBe('foo@bar.com');
  });

  it('redacts bank/iban/account_number keys', () => {
    const event: Event = {
      request: {
        data: { bank_account_number: '1234567890', iban: 'GB82WEST', account_number: '9999' },
      },
    };
    const out = scrubEvent(event);
    const data = out!.request!.data as Record<string, unknown>;
    expect(data.bank_account_number).toBe('[REDACTED]');
    expect(data.iban).toBe('[REDACTED]');
    expect(data.account_number).toBe('[REDACTED]');
  });

  it('drops cookie, authorization, x-csrf-token headers', () => {
    const event: Event = {
      request: {
        headers: {
          cookie: 'session=xxx',
          authorization: 'Bearer zzz',
          'x-csrf-token': 'yyy',
          'user-agent': 'Mozilla/5.0',
        },
      },
    };
    const out = scrubEvent(event);
    const headers = out!.request!.headers as Record<string, string>;
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-csrf-token']).toBeUndefined();
    expect(headers['user-agent']).toBe('Mozilla/5.0');
  });

  it('redacts sensitive keys inside query strings', () => {
    const event: Event = {
      request: {
        query_string: 'email=a@b.com&token=secret123&company_id=uuid',
      },
    };
    const out = scrubEvent(event);
    expect(out!.request!.query_string).toBe('email=a@b.com&token=%5BREDACTED%5D&company_id=uuid');
  });

  it('hashes local-part of request.data.email', () => {
    const event: Event = {
      request: { data: { email: 'hein@velocityfibre.co.za' } },
    };
    const out = scrubEvent(event);
    const email = (out!.request!.data as Record<string, string>).email;
    expect(email).toMatch(/^[a-f0-9]{8}@velocityfibre\.co\.za$/);
  });

  it('returns null when given null (drops the event)', () => {
    expect(scrubEvent(null as unknown as Event)).toBeNull();
  });

  it('is idempotent on already-scrubbed events', () => {
    const event: Event = { request: { data: { password: 'hunter2' } } };
    const once = scrubEvent(event);
    const twice = scrubEvent(once!);
    expect((twice!.request!.data as Record<string, string>).password).toBe('[REDACTED]');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bunx vitest run tests/unit/sentry/scrub.test.ts`
Expected: FAIL — `Cannot find module '@/lib/sentry/scrub'`.

### Task B2: Implement scrub module

**Files:**
- Create: `src/lib/sentry/scrub.ts`

- [ ] **Step 1: Write implementation**

```typescript
// src/lib/sentry/scrub.ts
import type { Event } from '@sentry/nextjs';
import { createHash } from 'crypto';

const SENSITIVE_KEY_RE = /pass|token|secret|otp|bank|iban|account.*number/i;
const DROP_HEADERS = new Set(['cookie', 'authorization', 'x-csrf-token']);
const REDACTED = '[REDACTED]';

function redactObject(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map(redactObject);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = REDACTED;
    } else if (v && typeof v === 'object') {
      out[k] = redactObject(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function redactQueryString(qs: string): string {
  return qs
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const k = pair.slice(0, eq);
      return SENSITIVE_KEY_RE.test(k) ? `${k}=${encodeURIComponent(REDACTED)}` : pair;
    })
    .join('&');
}

function hashEmailLocalPart(email: string): string {
  const at = email.indexOf('@');
  if (at === -1) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const h = createHash('sha256').update(local).digest('hex').slice(0, 8);
  return `${h}${domain}`;
}

export function scrubEvent(event: Event | null): Event | null {
  if (!event) return null;
  const req = event.request;
  if (!req) return event;

  // Drop sensitive headers
  if (req.headers) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers as Record<string, string>)) {
      if (!DROP_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
    req.headers = headers;
  }

  // Redact body
  if (req.data && typeof req.data === 'object') {
    const data = redactObject(req.data) as Record<string, unknown>;
    if (typeof data.email === 'string') {
      data.email = hashEmailLocalPart(data.email);
    }
    req.data = data;
  }

  // Redact query string
  if (typeof req.query_string === 'string') {
    req.query_string = redactQueryString(req.query_string);
  }

  return event;
}
```

- [ ] **Step 2: Install type-only dep so the import type-checks**

```bash
cd /home/hein/Workspace/IsaFlow
bun add -d @sentry/nextjs
```

- [ ] **Step 3: Run tests**

Run: `bunx vitest run tests/unit/sentry/scrub.test.ts`
Expected: all 7 tests PASS.

- [ ] **Step 4: Type-check**

Run: `bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sentry/scrub.ts tests/unit/sentry/scrub.test.ts package.json bun.lockb
git commit -m "feat(BL-53): add Sentry PII scrub module with tests"
```

### Task B3: Tag helper — failing test first

**Files:**
- Create: `tests/unit/sentry/tags.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/sentry/tags.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const setTag = vi.fn();
const setUser = vi.fn();

vi.mock('@sentry/nextjs', () => ({
  setTag: (...args: unknown[]) => setTag(...args),
  setUser: (...args: unknown[]) => setUser(...args),
}));

import { setTenantTags } from '@/lib/sentry/tags';

describe('setTenantTags', () => {
  beforeEach(() => {
    setTag.mockReset();
    setUser.mockReset();
  });

  it('sets company_id, user_id, request_id, and route tags when all provided', () => {
    setTenantTags({ companyId: 'c-1', userId: 'u-1', requestId: 'r-1', route: '/api/x' });
    expect(setTag).toHaveBeenCalledWith('company_id', 'c-1');
    expect(setTag).toHaveBeenCalledWith('request_id', 'r-1');
    expect(setTag).toHaveBeenCalledWith('route', '/api/x');
    expect(setUser).toHaveBeenCalledWith({ id: 'u-1' });
  });

  it('skips fields that are undefined', () => {
    setTenantTags({ requestId: 'r-2' });
    expect(setTag).toHaveBeenCalledWith('request_id', 'r-2');
    expect(setTag).not.toHaveBeenCalledWith('company_id', expect.anything());
    expect(setUser).not.toHaveBeenCalled();
  });

  it('is a no-op when SENTRY_ENABLED is not true', () => {
    process.env.SENTRY_ENABLED = 'false';
    setTenantTags({ companyId: 'c-1' });
    expect(setTag).not.toHaveBeenCalled();
    process.env.SENTRY_ENABLED = 'true';
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bunx vitest run tests/unit/sentry/tags.test.ts`
Expected: FAIL — module not found.

### Task B4: Implement tag helper

**Files:**
- Create: `src/lib/sentry/tags.ts`

- [ ] **Step 1: Write implementation**

```typescript
// src/lib/sentry/tags.ts
import * as Sentry from '@sentry/nextjs';

export interface TenantTagContext {
  companyId?: string;
  userId?: string;
  requestId?: string;
  route?: string;
}

export function setTenantTags(ctx: TenantTagContext): void {
  if (process.env.SENTRY_ENABLED !== 'true') return;
  if (ctx.companyId) Sentry.setTag('company_id', ctx.companyId);
  if (ctx.requestId) Sentry.setTag('request_id', ctx.requestId);
  if (ctx.route) Sentry.setTag('route', ctx.route);
  if (ctx.userId) Sentry.setUser({ id: ctx.userId });
}
```

- [ ] **Step 2: Run tests**

Run: `SENTRY_ENABLED=true bunx vitest run tests/unit/sentry/tags.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/sentry/tags.ts tests/unit/sentry/tags.test.ts
git commit -m "feat(BL-53): add tenant-aware Sentry tag helper"
```

---

## Phase C — Sentry SDK wiring (shipped dark)

> These changes install `@sentry/nextjs` as a runtime dep and add the three config files. `Sentry.init` is gated on `process.env.SENTRY_ENABLED === 'true'` so production stays quiet until Task F1 flips it.

### Task C1: Promote @sentry/nextjs to a runtime dep

- [ ] **Step 1: Move dep from devDependencies to dependencies**

```bash
cd /home/hein/Workspace/IsaFlow
bun remove -d @sentry/nextjs
bun add @sentry/nextjs
```

- [ ] **Step 2: Verify package.json**

Run: `node -e "console.log(require('./package.json').dependencies['@sentry/nextjs'])"`
Expected: a version string like `^8.x.x` or `^9.x.x`, not `undefined`.

### Task C2: Add Sentry env vars to .env.example

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Append Sentry block**

Add at the end of `.env.example`:
```
# --- Error tracking (Bugsink) ---
# Set to 'true' to enable Sentry.init. Defaults to off so the SDK is dark.
SENTRY_ENABLED=false
# Per-project DSN issued by Bugsink at https://errors.isaflow.co.za
SENTRY_DSN=
# Source-map upload (build-time only) — leave empty locally
SENTRY_AUTH_TOKEN=
SENTRY_URL=https://errors.isaflow.co.za
SENTRY_ORG=isaflow-platform
SENTRY_PROJECT=isaflow
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "chore(BL-53): document Sentry env vars in .env.example"
```

### Task C3: Server-side Sentry config

**Files:**
- Create: `sentry.server.config.ts`

- [ ] **Step 1: Write config**

```typescript
// sentry.server.config.ts
import * as Sentry from '@sentry/nextjs';
import { scrubEvent } from './src/lib/sentry/scrub';

if (process.env.SENTRY_ENABLED === 'true' && process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    release: process.env.GIT_SHA || undefined,
    tracesSampleRate: 0,
    includeLocalVariables: false,
    beforeSend: (event) => scrubEvent(event),
  });
  Sentry.setTag('runtime', 'node');
}
```

### Task C4: Edge-runtime Sentry config

**Files:**
- Create: `sentry.edge.config.ts`

- [ ] **Step 1: Write config**

```typescript
// sentry.edge.config.ts
import * as Sentry from '@sentry/nextjs';
import { scrubEvent } from './src/lib/sentry/scrub';

if (process.env.SENTRY_ENABLED === 'true' && process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    release: process.env.GIT_SHA || undefined,
    tracesSampleRate: 0,
    beforeSend: (event) => scrubEvent(event),
  });
  Sentry.setTag('runtime', 'edge');
}
```

### Task C5: Browser Sentry config

**Files:**
- Create: `sentry.client.config.ts`

- [ ] **Step 1: Write config**

```typescript
// sentry.client.config.ts
import * as Sentry from '@sentry/nextjs';
import { scrubEvent } from './src/lib/sentry/scrub';

if (
  typeof window !== 'undefined' &&
  process.env.NEXT_PUBLIC_SENTRY_ENABLED === 'true' &&
  process.env.NEXT_PUBLIC_SENTRY_DSN
) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_GIT_SHA || undefined,
    tracesSampleRate: 0,
    integrations: [],
    beforeSend: (event) => scrubEvent(event),
  });
  Sentry.setTag('runtime', 'browser');
}
```

> Note: browser SDK needs `NEXT_PUBLIC_*` env vars because anything referenced client-side must be inlined at build time. Add `NEXT_PUBLIC_SENTRY_ENABLED` and `NEXT_PUBLIC_SENTRY_DSN` to `.env.example` now (same file you touched in Task C2) with the same values as the server-side ones.

- [ ] **Step 2: Append NEXT_PUBLIC_* to .env.example**

Add to the Sentry block in `.env.example`:
```
# Browser SDK (must mirror server vars; NEXT_PUBLIC_* are inlined at build time)
NEXT_PUBLIC_SENTRY_ENABLED=false
NEXT_PUBLIC_SENTRY_DSN=
NEXT_PUBLIC_GIT_SHA=
```

### Task C6: Create instrumentation.ts

**Files:**
- Create: `instrumentation.ts` (repo root)

- [ ] **Step 1: Write file**

```typescript
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}
```

### Task C7: Wrap next.config.js with withSentryConfig

**Files:**
- Modify: `next.config.js`

- [ ] **Step 1: Edit next.config.js — replace `module.exports = nextConfig;` with wrapped export**

Find line `module.exports = nextConfig;` at the end of `next.config.js` and replace with:

```javascript
const { withSentryConfig } = require('@sentry/nextjs');

module.exports = withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  url: process.env.SENTRY_URL,
  silent: !process.env.CI,
  // Only upload source maps when auth token is present (prod deploys); skip locally
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
  },
  // Hide source maps from the deployed bundle after upload
  hideSourceMaps: true,
  disableLogger: true,
});
```

- [ ] **Step 2: Also set `productionBrowserSourceMaps: true`**

Change `productionBrowserSourceMaps: false,` (line 11) to `productionBrowserSourceMaps: true,` so browser source maps are generated for Sentry to upload. `hideSourceMaps: true` above strips the `//# sourceMappingURL` reference from the served JS, so public users still can't fetch them.

- [ ] **Step 3: Verify the build still runs**

Run: `bunx next build`
Expected: build succeeds; near the end you should see a Sentry log line like `> [@sentry/nextjs] Skipping source map upload — auth token not provided.`

- [ ] **Step 4: Commit Phase C**

```bash
git add sentry.server.config.ts sentry.edge.config.ts sentry.client.config.ts \
        instrumentation.ts next.config.js .env.example package.json bun.lockb
git commit -m "feat(BL-53): wire @sentry/nextjs (gated off by SENTRY_ENABLED)"
```

---

## Phase D — Tag enrichment in middleware

### Task D1: Add setTenantTags call in withCompany

**Files:**
- Modify: `src/lib/auth/withCompany.ts`

- [ ] **Step 1: Import setTenantTags at top of withCompany.ts**

Find the import block (lines 7-10) and append:

```typescript
import { setTenantTags } from '@/lib/sentry/tags';
```

- [ ] **Step 2: Add tag call after each of the three company-resolution branches**

There are three places where `(req as CompanyApiRequest).companyId = ...` is set (header branch, default-company branch, and for super_admin). Immediately BEFORE each `return handler(req, res);` that follows a successful company resolution, add:

```typescript
setTenantTags({
  companyId: (req as CompanyApiRequest).companyId,
  userId,
  route: req.url,
});
```

Concrete example for the first branch (around lines 45-48 in the current file):

```typescript
if (authReq.user.role === 'super_admin') {
  (req as CompanyApiRequest).companyId = companyId;
  (req as CompanyApiRequest).companyRole = 'owner';
  setTenantTags({ companyId, userId, route: req.url });
  return handler(req, res);
}
```

Repeat the `setTenantTags(...)` line immediately before every successful `return handler(req, res)` inside `withCompany`. Do NOT add it on the error branches (403, 400).

- [ ] **Step 3: Type-check**

Run: `bunx tsc --noEmit`
Expected: no errors.

### Task D2: Thread request_id through api-error-handler

**Files:**
- Modify: `src/lib/api-error-handler.ts`

- [ ] **Step 1: Import crypto and setTenantTags at top**

After line 4 (`import { apiLogger } ...`) add:

```typescript
import { randomUUID } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { setTenantTags } from '@/lib/sentry/tags';
```

- [ ] **Step 2: Generate request ID and tag it at the top of the try block**

Inside the `try {` block (around line 55, right after `const startTime = Date.now();` and before the CORS block), add:

```typescript
const requestId = randomUUID();
res.setHeader('X-Request-Id', requestId);
setTenantTags({ requestId, route: req.url });
```

- [ ] **Step 3: Report unhandled errors to Sentry explicitly**

Inside the `catch (error)` block, after `apiLogger.error({...})` (around line 111) and BEFORE the `if (res.headersSent)` check, add:

```typescript
if (process.env.SENTRY_ENABLED === 'true' && error instanceof Error) {
  Sentry.captureException(error);
}
```

- [ ] **Step 4: Write a smoke test**

Create `tests/unit/sentry/error-handler-integration.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const captureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...a: unknown[]) => captureException(...a),
  setTag: vi.fn(),
  setUser: vi.fn(),
}));

import { withErrorHandler } from '@/lib/api-error-handler';

function makeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    statusCode: 200,
    headersSent: false,
    setHeader: (k: string, v: string) => { headers[k] = v; },
    status(code: number) { this.statusCode = code; return this; },
    json: vi.fn(),
    end: vi.fn(),
  } as unknown as NextApiResponse & { headers: Record<string, string> };
}

describe('withErrorHandler + Sentry', () => {
  it('sets X-Request-Id header on every request', async () => {
    const res = makeRes() as NextApiResponse & { headers: Record<string, string> };
    const handler = withErrorHandler(async () => {});
    await handler({ method: 'GET', url: '/api/x', headers: {} } as unknown as NextApiRequest, res);
    expect(res.headers['X-Request-Id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('calls Sentry.captureException when SENTRY_ENABLED=true and handler throws', async () => {
    process.env.SENTRY_ENABLED = 'true';
    captureException.mockReset();
    const res = makeRes();
    const handler = withErrorHandler(async () => { throw new Error('boom'); });
    await handler({ method: 'GET', url: '/api/x', headers: {} } as unknown as NextApiRequest, res);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0]![0]).toBeInstanceOf(Error);
    process.env.SENTRY_ENABLED = 'false';
  });

  it('does NOT call Sentry.captureException when SENTRY_ENABLED=false', async () => {
    process.env.SENTRY_ENABLED = 'false';
    captureException.mockReset();
    const res = makeRes();
    const handler = withErrorHandler(async () => { throw new Error('boom'); });
    await handler({ method: 'GET', url: '/api/x', headers: {} } as unknown as NextApiRequest, res);
    expect(captureException).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Run tests**

Run: `bunx vitest run tests/unit/sentry/`
Expected: all scrub + tags + error-handler-integration tests PASS.

- [ ] **Step 6: Commit Phase D**

```bash
git add src/lib/auth/withCompany.ts src/lib/api-error-handler.ts \
        tests/unit/sentry/error-handler-integration.test.ts
git commit -m "feat(BL-53): enrich Sentry events with company/user/request tags"
```

---

## Phase E — Source-map upload in deploy script

### Task E1: Extend scripts/deploy.sh with GIT_SHA and source-map upload

**Files:**
- Modify: `scripts/deploy.sh`

- [ ] **Step 1: Insert GIT_SHA export before the build step**

Replace lines 11-18 (from `echo "Installing dependencies..."` through `NODE_ENV=production $BUN run build`) with:

```bash
# Capture git SHA for Sentry release tagging
export GIT_SHA=$(git rev-parse --short HEAD)
export SENTRY_RELEASE="$GIT_SHA"
export NEXT_PUBLIC_GIT_SHA="$GIT_SHA"
echo "Release SHA: $GIT_SHA"

echo "Installing dependencies..."
cd "$REPO_DIR"
$BUN install

echo "Building production bundle..."
NODE_ENV=production $BUN run build
```

- [ ] **Step 2: Add a Sentry release-finalize step after the service restart**

After the final `echo "App: https://app.isaflow.co.za"` line, append:

```bash
# 8. Finalize Sentry release (fail-open — never block a deploy)
if [ -n "$SENTRY_AUTH_TOKEN" ] && command -v sentry-cli >/dev/null 2>&1; then
  echo "Finalizing Sentry release $GIT_SHA..."
  sentry-cli releases finalize "$GIT_SHA" || echo "WARN: sentry-cli finalize failed (non-fatal)"
  sentry-cli releases deploys "$GIT_SHA" new -e production \
    || echo "WARN: sentry-cli deploys failed (non-fatal)"
else
  echo "Skipping Sentry release finalize (no SENTRY_AUTH_TOKEN or sentry-cli)"
fi
```

- [ ] **Step 3: Shellcheck**

Run: `shellcheck scripts/deploy.sh || true`
Expected: no new errors vs. the baseline (the `|| true` makes the step informational).

- [ ] **Step 4: Install sentry-cli on Velocity**

SSH to Velocity:
```bash
curl -sL https://sentry.io/get-cli/ | bash
which sentry-cli
```
Expected: `/usr/local/bin/sentry-cli`.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy.sh
git commit -m "feat(BL-53): export GIT_SHA + Sentry release finalize in deploy.sh"
```

---

## Phase F — Cutover

> At this point everything is merged but `SENTRY_ENABLED=false`. We flip the flag, trigger a test error, verify every acceptance criterion, then enable alerts 24 h later.

### Task F1: Populate production .env.local

- [ ] **Step 1: SSH to Velocity and edit env file**

```bash
ssh velo@100.96.203.105
sudo -u velo vim /home/velo/isaflow/.env.local
```

Append:
```
# Error tracking
SENTRY_ENABLED=true
SENTRY_DSN=<isaflow DSN from Task A4>
NEXT_PUBLIC_SENTRY_ENABLED=true
NEXT_PUBLIC_SENTRY_DSN=<same isaflow DSN>
SENTRY_AUTH_TOKEN=<generate in Bugsink UI: Admin → API tokens → scope: project:releases>
SENTRY_URL=https://errors.isaflow.co.za
SENTRY_ORG=isaflow-platform
SENTRY_PROJECT=isaflow
```

- [ ] **Step 2: Deploy a fresh build so NEXT_PUBLIC_* get inlined**

From laptop:
```bash
cd /home/hein/Workspace/IsaFlow
bash scripts/deploy.sh
```
Expected: build succeeds, service restarts, Sentry release finalize runs (or skip message if token missing).

### Task F2: Trigger a deliberate test error

- [ ] **Step 1: Add a one-shot debug route**

Create `pages/api/_debug/throw.ts`:

```typescript
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCompany, type CompanyApiRequest } from '@/lib/auth/withCompany';

export default withCompany(
  withErrorHandler(async (_req: CompanyApiRequest, _res: NextApiResponse) => {
    throw new Error('BL-53 smoke test — safe to ignore');
  })
);
```

Deploy this file (same `bash scripts/deploy.sh`) and hit it once as an authenticated user:

```bash
curl -sS -b "$ISAFLOW_SESSION_COOKIE" https://app.isaflow.co.za/api/_debug/throw
```
Expected: 500 response with code `INTERNAL_SERVER_ERROR`.

- [ ] **Step 2: Verify the event in Bugsink UI**

Open `https://errors.isaflow.co.za`, project `isaflow`. Confirm within 60 seconds:
- [ ] Event appears.
- [ ] Stack frame points to a **TypeScript** line (source-mapped), not minified JS.
- [ ] Tags panel shows `company_id=<uuid>`, `user_id=<uuid>`, `request_id=<uuid>`, `route=/api/_debug/throw`, `runtime=node`, `release=<git-sha>`.

- [ ] **Step 3: Remove the debug route**

```bash
cd /home/hein/Workspace/IsaFlow
git rm pages/api/_debug/throw.ts
git commit -m "chore(BL-53): remove BL-53 smoke-test route"
bash scripts/deploy.sh
```

### Task F3: PII scrubbing live verification

- [ ] **Step 1: Trigger an error with sensitive body fields**

Use `curl` to POST a deliberately-broken payload to a real CSRF-exempt test route (or add a one-shot `pages/api/_debug/throw-body.ts` that echoes `req.body` and then throws). Body:
```json
{ "password": "hunter2", "bank_account_number": "1234567890", "csrf_token": "abc" }
```

- [ ] **Step 2: Inspect the event in Bugsink UI**

In the event detail → Request → Body, confirm every sensitive field shows `[REDACTED]`. `email` (if included) shows a sha256-prefixed form.

- [ ] **Step 3: Remove debug route (if added)**

Same process as F2 Step 3.

### Task F4: Wait 24 h, then enable Telegram webhook

> This is a scheduled gate, not an immediate task. The goal is to triage the initial flood of latent exceptions in the UI before firing them at Telegram.

- [ ] **Step 1: 24 h triage window**

Wait 24 hours after Task F2 completes. Review the issues list in Bugsink; resolve or ignore anything that's a known-latent bug.

- [ ] **Step 2: Create a Telegram webhook integration**

In Bugsink UI → project `isaflow` → Integrations → Webhooks → New:
- URL: `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/sendMessage?chat_id=<TELEGRAM_CHAT_ID>&parse_mode=Markdown`
- Triggers: **new issue only** (not every event)
- Payload template (Bugsink-flavored, adapt to actual Bugsink webhook body shape — confirm from UI preview):
  ```
  text=🚨 *New issue in isaflow*
  {{ issue.title }}
  {{ issue.environment }}
  {{ issue.web_url }}
  ```

- [ ] **Step 3: Smoke-test**

Trigger one new (unseen) error via a temporary debug route; confirm a Telegram message lands in the deploy channel within 1 minute. Remove the debug route.

### Task F5: Close out BL-53 and open follow-ups

- [ ] **Step 1: Update phase4b-closeout.md**

Edit `docs/audits/2026-04-15/phase4b-closeout.md` — in the `Phase 4C — Observability` list, mark item 3 (Error tracking / Sentry integration) as ✅ done with a link to this plan.

- [ ] **Step 2: Open follow-up issues**

Create GitHub issues (or equivalent tracker entries) for:
- **#54** — Wire Bugsink into FibreFlow (`/home/hein/Workspace/FF_Next.js`). Reuse this plan's Phase B–F, skipping Phase A (server already running). DSN: `SENTRY_DSN_FIBREFLOW` from Task A4.
- **#55** — Wire Bugsink into ApexGEO (`/home/hein/Workspace/ApexGEO`). Same as #54 but DSN `SENTRY_DSN_APEXGEO`.

- [ ] **Step 3: Commit closeout**

```bash
git add docs/audits/2026-04-15/phase4b-closeout.md
git commit -m "docs(BL-53): mark Phase 4C item 3 (error tracking) complete"
```

---

## Acceptance criteria (maps to spec)

- [ ] `errors.isaflow.co.za` serves the Bugsink UI over HTTPS (Task A3) and survives a reboot (systemd unit, Task A2).
- [ ] Three projects (isaflow, fibreflow, apexgeo) exist in the UI with working DSNs (Task A4).
- [ ] Deliberate error in an ISAFlow API route produces a Sentry event with source-mapped TS stack, `company_id`, `user_id`, `request_id`, `release` tags (Task F2).
- [ ] Posting `password` / `bank_account_number` / `csrf_token` in an error body produces `[REDACTED]` in the UI (Task F3).
- [ ] Telegram webhook fires on first occurrence of a new issue (Task F4).
- [ ] `scripts/deploy.sh` finalizes a Sentry release per deploy and a failed upload does not block the deploy (Task E1 Step 2).
- [ ] FibreFlow & ApexGEO DSNs provisioned but SDK integration deferred to #54/#55 (Task A4 + Task F5).
