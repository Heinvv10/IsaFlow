# Plan 6 — Client Portal + Signum Integration (REVISED)
**Date:** 2026-04-16  
**Revised:** 2026-04-16 (fixes JWT blocker, migration numbering, status flow, FK, author_type, import paths; updated 2026-04-16 with real Signum API shape)  
**Status:** Ready for implementation  
**Depends on:** Plans 1–5 complete — types at `@/modules/accounting/services/afs/afsTypes.ts`  
**Scope:** Portal contacts, magic-link auth, client portal pages, Signum e-signature integration, webhook handler

---

## Overview

Plan 6 adds the client-facing layer on top of the AFS document engine built in Plans 1–5. It delivers:

- A portal contacts CRUD system (directors, CFOs, shareholders, auditors) with role-based access rules
- Magic-link authentication for portal contacts (no passwords, 15-minute single-use tokens)
- A `withPortalAuth` middleware for portal API routes, separate from staff `withCompany`
- Portal-specific JWT functions (`signPortalToken` / `verifyPortalToken`) with a dedicated `PORTAL_JWT_SECRET`
- Signum integration — upload AFS PDF to Signum, distribute signing emails, receive webhook on completion
- A signing page that embeds Signum in an iframe with full ISaFlow branding
- Client portal pages: login, dashboard, document viewer, annotation
- Portal notification service (email + in-app) for key lifecycle events

**What is NOT in scope:** Management pack delivery (Plan 7), compliance checker (Plan 8), DOCX/Caseware export (Plan 4), review workflow internal UI (Plan 5).

---

## Prerequisites

### Signum Setup Prerequisites (One-Time Manual Steps)

Before this plan can go live, two manual Signum admin steps must be completed. These are done once by the Signum administrator — ISaFlow code never calls these at runtime.

**Step 1 — Create an API key:**
Log in to the Signum admin console and create an API key (`sk_live_...`). Copy it into `.env.local` and the production systemd drop-in as `SIGNUM_API_KEY`.

**Step 2 — Register the ISaFlow webhook:**
In the Signum admin console, register:
- URL: `https://app.isaflow.co.za/api/accounting/afs/webhook/signum`
- Events: `document.signed`, `document.declined`, `document.cancelled`, `document.expired`
- Signing secret: generate a 64-char hex secret, copy it as `SIGNUM_WEBHOOK_SECRET`

ISaFlow does **not** register the webhook from code — there is no `registerSignumWebhook` call at runtime. The previous `registerSignumWebhook` function described in the original plan is removed.

### Signum Embed Mode

Signum's `/sign/[token]` route must support `?embed=true` to:
- Remove Signum's own nav chrome when rendered in an ISaFlow iframe
- Fire `postMessage({ type: 'signum:signed' })` on completion so the parent page can show a success screen

### Plan 5 Migration Requirement

Plan 5's migration `338_afs_section_comments.sql` must include an `author_type` column to distinguish staff comments from portal contact comments:

```sql
-- Add to 338_afs_section_comments.sql (Plan 5):
ALTER TABLE afs_section_comments
  ADD COLUMN IF NOT EXISTS author_type text NOT NULL DEFAULT 'staff'
  CHECK (author_type IN ('staff', 'portal'));
```

If Plan 5's migration has already shipped without `author_type`, add this as a separate migration **before** Plan 6's migrations (e.g. `340_add_author_type_to_comments.sql`). Plan 6's annotate handler depends on this column.

---

## Environment Variables Required

```
SIGNUM_API_URL=https://signum.velocityfibre.co.za/api/v1   # Signum base API URL (server-side only)
SIGNUM_API_KEY=sk_live_...                                   # API key from Signum admin console
SIGNUM_WEBHOOK_SECRET=<64-char-hex>                          # HMAC secret — used to verify X-Signum-Signature header
SIGNUM_CALLBACK_BASE_URL=https://app.isaflow.co.za/sign      # Passed to Signum per-document; also used server-side for iframe src via getServerSideProps
SIGNUM_EXPIRES_IN_DAYS=14                                    # How many days before signing links expire
PORTAL_JWT_SECRET=<32-byte-hex>                              # Signs portal_session cookies — SEPARATE from JWT_SECRET
```

Add all six to `.env.local` (dev) and the production systemd environment drop-in.

**Note on client-side iframe src:** `SIGNUM_CALLBACK_BASE_URL` is server-side only (no `NEXT_PUBLIC_` prefix). The signing page (`pages/accounting/afs/sign/[token].tsx`) receives this URL via `getServerSideProps` as a prop and builds the iframe `src` server-side. This avoids leaking the URL to non-signing pages while keeping it out of the browser bundle.

---

## 1. Migrations

### `scripts/migrations/sql/341_portal_contacts.sql`

```sql
-- Migration 341: Portal contacts for client portal access
-- Stores directors, CFOs, shareholders, and auditors who access the client portal.

CREATE TABLE IF NOT EXISTS portal_contacts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  email       text        NOT NULL,
  role        text        NOT NULL CHECK (role IN ('director', 'cfo', 'shareholder_readonly', 'external_auditor')),
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, email)
);

CREATE INDEX IF NOT EXISTS idx_portal_contacts_company_id
  ON portal_contacts(company_id);

CREATE INDEX IF NOT EXISTS idx_portal_contacts_email
  ON portal_contacts(email);
```

**Notes:**
- `REFERENCES companies(id) ON DELETE CASCADE` — deleting a company cascades to portal contacts.
- `UNIQUE (company_id, email)` prevents duplicate contacts per tenant.
- `role` is an inline CHECK rather than a separate enum — easier to add roles later without a migration.
- `active = false` soft-deletes a contact without breaking foreign keys in `portal_magic_links`.

---

### `scripts/migrations/sql/342_portal_magic_links.sql`

```sql
-- Migration 342: Magic link tokens for portal authentication
-- Single-use, 15-minute expiry tokens sent to portal contacts by email.

CREATE TABLE IF NOT EXISTS portal_magic_links (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id  uuid        NOT NULL REFERENCES portal_contacts(id) ON DELETE CASCADE,
  token       text        NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portal_magic_links_token
  ON portal_magic_links(token);

CREATE INDEX IF NOT EXISTS idx_portal_magic_links_contact_id
  ON portal_magic_links(contact_id);

CREATE INDEX IF NOT EXISTS idx_portal_magic_links_company_id
  ON portal_magic_links(company_id);
```

**Notes:**
- `ON DELETE CASCADE` on `contact_id` — deactivating + deleting a contact revokes all outstanding tokens.
- `ON DELETE CASCADE` on `company_id` — deleting a company cleans up tokens.
- `token` has a `UNIQUE` index for fast O(1) lookup at verification time.
- `used_at` is set atomically on first use; subsequent uses are rejected.

---

### `scripts/migrations/sql/343_afs_signum_columns.sql`

```sql
-- Migration 343: Signum integration columns on afs_documents
-- Adds signum_document_id, signed_pdf_path, and signing_requested_at.

ALTER TABLE afs_documents ADD COLUMN IF NOT EXISTS signum_document_id text;
ALTER TABLE afs_documents ADD COLUMN IF NOT EXISTS signed_pdf_path text;
ALTER TABLE afs_documents ADD COLUMN IF NOT EXISTS signing_requested_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_afs_documents_signum_document_id
  ON afs_documents(signum_document_id)
  WHERE signum_document_id IS NOT NULL;
```

**Notes:**
- `signum_document_id` — the ID returned by Signum after upload.
- `signed_pdf_path` — local filesystem path to the downloaded signed PDF.
- `signing_requested_at` — set when the document is sent for signing. Used to track signing state while `status` remains `'partner_review'`. Webhook sets `status = 'signed_off'` when all signatures are collected.

---

## 2. Type Definitions

All new types live in `src/modules/accounting/services/afs/afsTypes.ts` (augment the existing file from Plan 1). Append to the end of that file:

```typescript
// ── Client Portal Types ────────────────────────────────────────────────────────

export type PortalRole = 'director' | 'cfo' | 'shareholder_readonly' | 'external_auditor';

export interface PortalContact {
  id: string;
  companyId: string;
  name: string;
  email: string;
  role: PortalRole;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MagicLink {
  id: string;
  companyId: string;
  contactId: string;
  token: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface PortalSession {
  contactId: string;
  companyId: string;
  role: PortalRole;
  expiresAt: string; // ISO string — stored in signed cookie
}

// Document access rules by portal role
export const PORTAL_ACCESS_RULES: Record<PortalRole, {
  documentTypes: Array<'afs' | 'management_pack'>;
  statuses: string[]; // empty array = all statuses
  canAnnotate: boolean;
}> = {
  director: {
    documentTypes: ['afs', 'management_pack'],
    statuses: [], // all
    canAnnotate: true,
  },
  cfo: {
    documentTypes: ['afs', 'management_pack'],
    statuses: [], // all
    canAnnotate: true,
  },
  shareholder_readonly: {
    documentTypes: ['afs'],
    statuses: ['signed_off', 'filed'],
    canAnnotate: false,
  },
  external_auditor: {
    documentTypes: ['afs'],
    statuses: [], // all
    canAnnotate: false,
  },
};
```

**Removed from the original plan:** `SignumUploadResult` and `PortalDocumentView` — these were unused standalone types. `sendForSigning` returns `{ signumDocumentId: string }` directly. Document list queries return raw row-mapped objects.

---

## 3. Portal JWT Module (JWT BLOCKER FIX)

### `src/lib/auth/portalJwt.ts`

The existing `signToken(user: AuthUser, sessionId: string)` and `verifyToken(token: string)` in `src/lib/auth/jwt.ts` are tightly coupled to staff auth — they require `AuthUser`, `sessionId`, and use the staff `JWT_SECRET`. They do NOT accept custom secrets or arbitrary payloads.

**Solution:** Create a dedicated portal JWT module that uses `PORTAL_JWT_SECRET` and operates on `PortalSession` payloads. This avoids modifying the existing auth functions.

```typescript
// src/lib/auth/portalJwt.ts
import { SignJWT, jwtVerify } from 'jose';
import { log } from '@/lib/logger';
import type { PortalSession } from '@/modules/accounting/services/afs/afsTypes';

const PORTAL_TOKEN_EXPIRY = '8h';

function getPortalSecret(): Uint8Array {
  const secret = process.env.PORTAL_JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('PORTAL_JWT_SECRET must be set and at least 32 characters');
  }
  return new TextEncoder().encode(secret);
}

/**
 * Sign a portal session token.
 * Uses PORTAL_JWT_SECRET — completely separate from staff JWT_SECRET.
 */
export async function signPortalToken(
  payload: PortalSession,
  expiresIn: string = PORTAL_TOKEN_EXPIRY,
): Promise<string> {
  const secret = getPortalSecret();
  const token = await new SignJWT({
    contactId: payload.contactId,
    companyId: payload.companyId,
    role: payload.role,
    expiresAt: payload.expiresAt,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.contactId)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);
  return token;
}

/**
 * Verify and decode a portal session token.
 * Returns PortalSession or null if invalid/expired.
 */
export async function verifyPortalToken(token: string): Promise<PortalSession | null> {
  try {
    const secret = getPortalSecret();
    const { payload } = await jwtVerify(token, secret);

    if (!payload.contactId || !payload.companyId || !payload.role) {
      return null;
    }

    return {
      contactId: payload.contactId as string,
      companyId: payload.companyId as string,
      role: payload.role as PortalSession['role'],
      expiresAt: payload.expiresAt as string,
    };
  } catch (err) {
    log.warn('Portal token verification failed', { error: err instanceof Error ? err.message : String(err) }, 'portalJwt');
    return null;
  }
}
```

**Why not modify `signToken`/`verifyToken`?** Those functions are used throughout the staff auth pipeline (`middleware.ts`, `withCompany.ts`, `session.ts`). Changing their signatures would require updating every callsite and could introduce subtle auth bugs. A separate module is safer.

---

## 4. Services

### 4.1 `src/modules/accounting/services/afs/portalContactService.ts`

CRUD for portal contacts. All queries tenant-scoped by `company_id`.

**Exports:**

```typescript
export async function listPortalContacts(companyId: string): Promise<PortalContact[]>
export async function createPortalContact(
  companyId: string,
  input: { name: string; email: string; role: PortalRole }
): Promise<PortalContact>
export async function updatePortalContact(
  companyId: string,
  contactId: string,
  input: Partial<{ name: string; role: PortalRole; active: boolean }>
): Promise<PortalContact>
export async function deletePortalContact(companyId: string, contactId: string): Promise<void>
export async function getPortalContactByEmail(companyId: string, email: string): Promise<PortalContact | null>
```

**Implementation:**

```typescript
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PortalContact, PortalRole } from './afsTypes';

export async function listPortalContacts(companyId: string): Promise<PortalContact[]> {
  const rows = await sql`
    SELECT id, company_id, name, email, role, active, created_at, updated_at
    FROM portal_contacts
    WHERE company_id = ${companyId}::UUID AND active = true
    ORDER BY name ASC
  `;
  return rows.map(mapRow);
}

export async function createPortalContact(
  companyId: string,
  input: { name: string; email: string; role: PortalRole },
): Promise<PortalContact> {
  const validRoles: PortalRole[] = ['director', 'cfo', 'shareholder_readonly', 'external_auditor'];
  if (!validRoles.includes(input.role)) {
    throw new Error('INVALID_ROLE');
  }
  try {
    const rows = await sql`
      INSERT INTO portal_contacts (company_id, name, email, role)
      VALUES (${companyId}::UUID, ${input.name}, ${input.email}, ${input.role})
      RETURNING id, company_id, name, email, role, active, created_at, updated_at
    `;
    log.info('Portal contact created', { companyId, email: input.email, role: input.role }, 'portalContactService');
    return mapRow(rows[0]!);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('unique')) {
      throw new Error('DUPLICATE_EMAIL');
    }
    throw err;
  }
}

export async function updatePortalContact(
  companyId: string,
  contactId: string,
  input: Partial<{ name: string; role: PortalRole; active: boolean }>,
): Promise<PortalContact> {
  // IDOR guard: verify the contact belongs to this company
  const existing = await sql`
    SELECT id FROM portal_contacts
    WHERE id = ${contactId}::UUID AND company_id = ${companyId}::UUID
  `;
  if (existing.length === 0) {
    throw new Error('CONTACT_NOT_FOUND');
  }

  const rows = await sql`
    UPDATE portal_contacts
    SET name       = COALESCE(${input.name ?? null}, name),
        role       = COALESCE(${input.role ?? null}, role),
        active     = COALESCE(${input.active ?? null}, active),
        updated_at = now()
    WHERE id = ${contactId}::UUID AND company_id = ${companyId}::UUID
    RETURNING id, company_id, name, email, role, active, created_at, updated_at
  `;
  log.info('Portal contact updated', { companyId, contactId }, 'portalContactService');
  return mapRow(rows[0]!);
}

export async function deletePortalContact(companyId: string, contactId: string): Promise<void> {
  await sql`
    UPDATE portal_contacts
    SET active = false, updated_at = now()
    WHERE id = ${contactId}::UUID AND company_id = ${companyId}::UUID
  `;
  log.info('Portal contact soft-deleted', { companyId, contactId }, 'portalContactService');
}

export async function getPortalContactByEmail(
  companyId: string,
  email: string,
): Promise<PortalContact | null> {
  const rows = await sql`
    SELECT id, company_id, name, email, role, active, created_at, updated_at
    FROM portal_contacts
    WHERE company_id = ${companyId}::UUID AND email = ${email} AND active = true
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return mapRow(rows[0]!);
}

function mapRow(row: Record<string, unknown>): PortalContact {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    name: String(row.name),
    email: String(row.email),
    role: row.role as PortalRole,
    active: Boolean(row.active),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(String(row.updated_at)),
  };
}
```

**Notes:**
- `getPortalContactByEmail` now accepts `companyId` to scope the lookup (fixes the original plan's unscoped query).
- The magic link auth flow (Section 6.5) calls a different function that looks up by `contact_id` from the magic link record — not by email globally.
- `deletePortalContact` is a soft delete: `active = false`. Preserves audit trail and magic link history.

---

### 4.2 `src/modules/accounting/services/afs/magicLinkService.ts`

Generate and verify single-use magic link tokens for portal contacts.

**Exports:**

```typescript
export async function generateMagicLink(
  companyId: string,
  contactId: string,
): Promise<{ token: string; expiresAt: Date }>

export async function verifyMagicLink(
  token: string,
): Promise<{ contact: PortalContact; companyId: string } | null>

export async function cleanupExpiredMagicLinks(): Promise<void>
```

**Implementation:**

```typescript
import crypto from 'crypto';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PortalContact, PortalRole } from './afsTypes';

const MAGIC_LINK_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

export async function generateMagicLink(
  companyId: string,
  contactId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString('hex'); // 64 hex chars, 256-bit entropy
  const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY_MS);

  // Invalidate any existing unused tokens for the same contact
  await sql`
    UPDATE portal_magic_links
    SET used_at = now()
    WHERE contact_id = ${contactId}::UUID
      AND company_id = ${companyId}::UUID
      AND used_at IS NULL
      AND expires_at > now()
  `;

  // Insert new token
  await sql`
    INSERT INTO portal_magic_links (company_id, contact_id, token, expires_at)
    VALUES (${companyId}::UUID, ${contactId}::UUID, ${token}, ${expiresAt.toISOString()}::TIMESTAMPTZ)
  `;

  log.info('Magic link generated', { companyId, contactId }, 'magicLinkService');
  return { token, expiresAt };
}

export async function verifyMagicLink(
  token: string,
): Promise<{ contact: PortalContact; companyId: string } | null> {
  // Step 1: Find the token (unused, not expired)
  const links = await sql`
    SELECT id, company_id, contact_id
    FROM portal_magic_links
    WHERE token = ${token}
      AND used_at IS NULL
      AND expires_at > now()
    LIMIT 1
  `;
  if (links.length === 0) return null;

  const link = links[0] as { id: string; company_id: string; contact_id: string };

  // Step 2: Atomically mark as used (race condition guard)
  const updated = await sql`
    UPDATE portal_magic_links
    SET used_at = now()
    WHERE id = ${link.id}::UUID AND used_at IS NULL
    RETURNING id
  `;
  if (updated.length === 0) {
    log.warn('Magic link consumed by concurrent request', { linkId: link.id }, 'magicLinkService');
    return null;
  }

  // Step 3: Load the portal contact
  const contacts = await sql`
    SELECT id, company_id, name, email, role, active, created_at, updated_at
    FROM portal_contacts
    WHERE id = ${link.contact_id}::UUID
      AND company_id = ${link.company_id}::UUID
      AND active = true
    LIMIT 1
  `;
  if (contacts.length === 0) {
    log.warn('Magic link verified but contact inactive or missing', { contactId: link.contact_id }, 'magicLinkService');
    return null;
  }

  const row = contacts[0]!;
  const contact: PortalContact = {
    id: String(row.id),
    companyId: String(row.company_id),
    name: String(row.name),
    email: String(row.email),
    role: row.role as PortalRole,
    active: Boolean(row.active),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(String(row.updated_at)),
  };

  log.info('Magic link verified', { contactId: contact.id, companyId: link.company_id }, 'magicLinkService');
  return { contact, companyId: String(link.company_id) };
}

export async function cleanupExpiredMagicLinks(): Promise<void> {
  await sql`
    DELETE FROM portal_magic_links
    WHERE expires_at < now() - INTERVAL '7 days'
  `;
  log.info('Expired magic links cleaned up', {}, 'magicLinkService');
}
```

**Notes:**
- `verifyMagicLink` does NOT accept `companyId` — the token itself is the auth. The `company_id` is read from the magic link record.
- The contact lookup in step 3 cross-validates `company_id` from the link matches the contact's `company_id`.
- Race condition guard: `RETURNING id` on the UPDATE confirms this request consumed the token.

---

### 4.3 `src/modules/accounting/services/afs/signumIntegrationService.ts`

Calls the Signum API to upload PDFs, track signing status, and download signed copies.

**Exports:**

```typescript
export async function sendForSigning(
  documentId: string,
  companyId: string,
  html: string,
  title: string,
  signers: Array<{ email: string; name: string }>,
): Promise<{ signumDocumentId: string; signingTokens: Array<{ email: string; signingToken: string }> }>

export async function downloadSignedPdf(signumDocumentId: string): Promise<Buffer>

export function verifySignumWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean
```

**Note:** `registerSignumWebhook` has been removed. Webhook registration is a one-time manual step in the Signum admin console (see Prerequisites). It is NOT called at runtime.

**`sendForSigning` implementation:**

The real Signum endpoint is `POST ${SIGNUM_API_URL}/documents/from-html` and accepts **JSON**, not multipart form data. It takes rendered HTML directly — no PDF generation required before calling Signum.

```typescript
import crypto from 'crypto';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

export async function sendForSigning(
  documentId: string,
  companyId: string,
  html: string,
  title: string,
  signers: Array<{ email: string; name: string }>,
): Promise<{ signumDocumentId: string; signingTokens: Array<{ email: string; signingToken: string }> }> {
  const apiUrl = process.env.SIGNUM_API_URL;
  const apiKey = process.env.SIGNUM_API_KEY;
  const callbackBaseUrl = process.env.SIGNUM_CALLBACK_BASE_URL;
  const expiresInDays = Number(process.env.SIGNUM_EXPIRES_IN_DAYS ?? 14);
  if (!apiUrl || !apiKey || !callbackBaseUrl) {
    throw new Error('SIGNUM_API_URL, SIGNUM_API_KEY, and SIGNUM_CALLBACK_BASE_URL must all be set');
  }

  const res = await fetch(`${apiUrl}/documents/from-html`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      html,
      title,
      senderEmail: 'accounts@isaflow.co.za',
      signers,
      callbackBaseUrl,
      expiresInDays,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Signum create failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as {
    documentId: string;
    signers: Array<{ email: string; signingToken: string }>;
  };

  // Store signumDocumentId + signing_requested_at on the afs_document record.
  // Status stays 'partner_review' — webhook will move it to 'signed_off'.
  await sql`
    UPDATE afs_documents
    SET signum_document_id = ${json.documentId},
        signing_requested_at = now(),
        updated_at = now()
    WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('Signum document created', { documentId, signumDocumentId: json.documentId }, 'signumIntegrationService');
  return { signumDocumentId: json.documentId, signingTokens: json.signers };
}
```

**`downloadSignedPdf` implementation:**

```typescript
export async function downloadSignedPdf(signumDocumentId: string): Promise<Buffer> {
  const apiUrl = process.env.SIGNUM_API_URL;
  const apiKey = process.env.SIGNUM_API_KEY;
  if (!apiUrl || !apiKey) throw new Error('SIGNUM_API_URL and SIGNUM_API_KEY must be set');

  const res = await fetch(`${apiUrl}/documents/${signumDocumentId}/download`, {
    headers: { 'x-api-key': apiKey },
  });
  if (!res.ok) throw new Error(`Signum download failed: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
```

**`verifySignumWebhookSignature` implementation:**

The `X-Signum-Signature` header format is `sha256=<hex>` — the function must strip the prefix before comparing.

```typescript
export function verifySignumWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  const secret = process.env.SIGNUM_WEBHOOK_SECRET;
  if (!secret) throw new Error('SIGNUM_WEBHOOK_SECRET not configured');
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = signatureHeader.slice(7); // strip 'sha256='
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch {
    return false; // length mismatch throws in timingSafeEqual
  }
}
```

**Document status flow:**
- When `sendForSigning` is called, `status` stays `'partner_review'`. The `signing_requested_at` timestamp is set to track that signing is in progress.
- The `'awaiting_signatures'` status does NOT exist in `DocumentStatus` — do not use it.
- Webhook sets `status = 'signed_off'` when all signatures are collected.

**Known unknown — signed PDF delivery:**
The mechanism by which Signum delivers the signed PDF is not yet confirmed. Two possibilities:
1. The webhook payload includes a download URL for the signed PDF.
2. A follow-up `GET ${SIGNUM_API_URL}/documents/${documentId}` returns a document object with a download link.

The webhook handler currently calls `downloadSignedPdf` which uses a `/download` path. This **must be verified against the real Signum API** before implementation. If the signed PDF URL is in the webhook body instead, `downloadSignedPdf` can be replaced with a direct fetch to that URL.

**TODO:** Confirm with Signum whether `GET /documents/{id}/download` exists, or whether the signed PDF URL is embedded in the `document.signed` webhook payload.

---

### 4.4 `src/modules/accounting/services/afs/portalNotificationService.ts`

Sends portal notifications via email for key events. Uses the existing `sendEmail` from `@/modules/accounting/services/core/emailService` (nodemailer SMTP).

**Exports:**

```typescript
export async function notifyMagicLinkRequested(
  contact: PortalContact,
  magicLinkUrl: string,
): Promise<void>

export async function notifySigningRequested(
  contact: PortalContact,
  documentId: string,
  signingUrl: string,
): Promise<void>

export async function notifyDocumentSignedOff(
  companyId: string,
  documentId: string,
): Promise<void>

export async function notifyAnnotationReceived(
  companyId: string,
  sectionId: string,
  authorName: string,
): Promise<void>
```

**Implementation:**

```typescript
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { sendEmail } from '@/modules/accounting/services/core/emailService';
import { emailLayout, ctaButton } from '@/lib/email-templates-shared';
import type { PortalContact } from './afsTypes';

export async function notifyMagicLinkRequested(
  contact: PortalContact,
  magicLinkUrl: string,
): Promise<void> {
  try {
    const html = emailLayout(`
      <h2>ISaFlow Portal — Sign-in Link</h2>
      <p>Hi ${contact.name},</p>
      <p>Click the button below to access your financial documents. This link expires in 15 minutes.</p>
      ${ctaButton('Sign In to Portal', magicLinkUrl)}
      <p style="font-size:12px;color:#94a3b8;">If you did not request this link, you can safely ignore this email.</p>
    `);
    await sendEmail({
      to: contact.email,
      subject: 'ISaFlow Portal — Your sign-in link',
      html,
      _log: { companyId: contact.companyId, emailType: 'other', sentBy: null },
    });
    log.info('Magic link email sent', { contactId: contact.id, email: contact.email }, 'portalNotificationService');
  } catch (err) {
    log.error('Failed to send magic link email', { contactId: contact.id, error: err instanceof Error ? err.message : String(err) }, 'portalNotificationService');
    // Never throw — notification failure must not break the auth flow
  }
}

export async function notifySigningRequested(
  contact: PortalContact,
  documentId: string,
  signingUrl: string,
): Promise<void> {
  try {
    const html = emailLayout(`
      <h2>Annual Financial Statements — Signature Required</h2>
      <p>Hi ${contact.name},</p>
      <p>The annual financial statements for your company are ready for your signature.</p>
      ${ctaButton('Review & Sign', signingUrl)}
      <p style="font-size:12px;color:#94a3b8;">This signing link expires in 30 days.</p>
    `);
    await sendEmail({
      to: contact.email,
      subject: 'Annual Financial Statements — Signature Required',
      html,
      _log: { companyId: contact.companyId, emailType: 'other', sentBy: null },
    });
    log.info('Signing request email sent', { contactId: contact.id, documentId }, 'portalNotificationService');
  } catch (err) {
    log.error('Failed to send signing request email', { contactId: contact.id, error: err instanceof Error ? err.message : String(err) }, 'portalNotificationService');
  }
}

export async function notifyDocumentSignedOff(
  companyId: string,
  documentId: string,
): Promise<void> {
  try {
    const contacts = await sql`
      SELECT id, company_id, name, email, role, active, created_at, updated_at
      FROM portal_contacts
      WHERE company_id = ${companyId}::UUID
        AND active = true
        AND role IN ('director', 'cfo')
    `;
    for (const row of contacts) {
      const html = emailLayout(`
        <h2>Annual Financial Statements — Signed Off</h2>
        <p>Hi ${String(row.name)},</p>
        <p>All signatures have been collected. The signed document is now available in your portal.</p>
        ${ctaButton('View in Portal', `https://app.isaflow.co.za/accounting/afs/portal/dashboard`)}
      `);
      await sendEmail({
        to: String(row.email),
        subject: 'Annual Financial Statements — Signed Off',
        html,
        _log: { companyId, emailType: 'other', sentBy: null },
      });
    }
    log.info('Signed-off notification sent', { companyId, documentId, recipientCount: contacts.length }, 'portalNotificationService');
  } catch (err) {
    log.error('Failed to send signed-off notification', { companyId, error: err instanceof Error ? err.message : String(err) }, 'portalNotificationService');
  }
}

export async function notifyAnnotationReceived(
  companyId: string,
  sectionId: string,
  authorName: string,
): Promise<void> {
  try {
    log.info('Annotation notification (email not implemented yet)', { companyId, sectionId, authorName }, 'portalNotificationService');
    // TODO: email the reviewing accountant that a client annotation was received
  } catch (err) {
    log.error('Failed to send annotation notification', { companyId, error: err instanceof Error ? err.message : String(err) }, 'portalNotificationService');
  }
}
```

**Notes:**
- Uses `sendEmail` from `@/modules/accounting/services/core/emailService` — same SMTP/nodemailer stack as the rest of ISaFlow.
- Uses `emailLayout` and `ctaButton` from `@/lib/email-templates-shared` for consistent branding.
- Never throws on email failure — catches, logs, and returns silently.

---

## 5. Portal Auth Middleware

### `src/lib/portalAuth.ts`

HTTP-only cookie-based session, signed with `PORTAL_JWT_SECRET`. Uses the portal-specific JWT functions from `portalJwt.ts`.

```typescript
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { signPortalToken, verifyPortalToken } from '@/lib/auth/portalJwt';
import type { PortalSession } from '@/modules/accounting/services/afs/afsTypes';

export const PORTAL_COOKIE_NAME = 'portal_session';
export const PORTAL_SESSION_TTL_HOURS = 8;

export interface PortalApiRequest extends NextApiRequest {
  portalSession: PortalSession;
}

export type PortalApiHandler = (
  req: PortalApiRequest,
  res: NextApiResponse,
) => Promise<void> | void;

export function withPortalAuth(handler: PortalApiHandler): NextApiHandler {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const cookie = req.cookies[PORTAL_COOKIE_NAME];
    if (!cookie) {
      return apiResponse.unauthorized(res, 'Portal session required');
    }

    const session = await verifyPortalToken(cookie);
    if (!session) {
      log.warn('Invalid portal session token', {}, 'portalAuth');
      return apiResponse.unauthorized(res, 'Invalid or expired portal session');
    }

    if (new Date(session.expiresAt) < new Date()) {
      return apiResponse.unauthorized(res, 'Portal session expired');
    }

    (req as PortalApiRequest).portalSession = session;
    return handler(req as PortalApiRequest, res);
  };
}

export async function createPortalSessionCookie(
  res: NextApiResponse,
  session: PortalSession,
): Promise<void> {
  const token = await signPortalToken(session, `${PORTAL_SESSION_TTL_HOURS}h`);
  const secure = process.env.NODE_ENV !== 'development' ? 'Secure;' : '';
  res.setHeader('Set-Cookie', [
    `${PORTAL_COOKIE_NAME}=${token}; HttpOnly; ${secure} SameSite=Strict; Path=/; Max-Age=${PORTAL_SESSION_TTL_HOURS * 3600}`,
  ]);
}

export function clearPortalSessionCookie(res: NextApiResponse): void {
  const secure = process.env.NODE_ENV !== 'development' ? 'Secure;' : '';
  res.setHeader('Set-Cookie', [
    `${PORTAL_COOKIE_NAME}=; HttpOnly; ${secure} SameSite=Strict; Path=/; Max-Age=0`,
  ]);
}
```

**Key differences from the original plan:**
- Uses `signPortalToken` / `verifyPortalToken` from `portalJwt.ts` — NOT the staff `signToken`/`verifyToken`.
- `signPortalToken` and `verifyPortalToken` are async (jose library), so `createPortalSessionCookie` is now async.
- `Secure` flag is conditionally added based on `NODE_ENV` (dev runs on HTTP).
- `PortalApiRequest` exposes `portalSession` — handlers read `req.portalSession.companyId` for all DB queries.

---

## 6. API Routes

### 6.1 `pages/api/accounting/afs/portal-contacts.ts` — GET / POST

**Auth:** `withCompany` (staff-only)

```typescript
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { listPortalContacts, createPortalContact } from '@/modules/accounting/services/afs/portalContactService';
import type { PortalRole } from '@/modules/accounting/services/afs/afsTypes';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    log.info('Listing portal contacts', { companyId }, 'portal-contacts-api');
    const contacts = await listPortalContacts(companyId);
    return apiResponse.success(res, { contacts });
  }

  if (req.method === 'POST') {
    const { name, email, role } = req.body as { name?: string; email?: string; role?: PortalRole };

    if (!name || typeof name !== 'string' || !name.trim()) {
      return apiResponse.badRequest(res, 'name is required');
    }
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return apiResponse.badRequest(res, 'A valid email is required');
    }
    const validRoles: PortalRole[] = ['director', 'cfo', 'shareholder_readonly', 'external_auditor'];
    if (!role || !validRoles.includes(role)) {
      return apiResponse.badRequest(res, `role must be one of: ${validRoles.join(', ')}`);
    }

    try {
      const contact = await createPortalContact(companyId, { name: name.trim(), email: email.trim().toLowerCase(), role });
      return apiResponse.created(res, { contact }, 'Portal contact created');
    } catch (err) {
      if (err instanceof Error && err.message === 'DUPLICATE_EMAIL') {
        return apiResponse.badRequest(res, 'A contact with this email already exists');
      }
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withCompany(withErrorHandler(handler as never));
```

---

### 6.2 `pages/api/accounting/afs/portal-contacts/[contactId].ts` — PUT / DELETE

**Auth:** `withCompany` (staff-only)

```typescript
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { updatePortalContact, deletePortalContact } from '@/modules/accounting/services/afs/portalContactService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
  const contactId = req.query.contactId as string;
  if (!contactId) return apiResponse.badRequest(res, 'contactId is required');

  if (req.method === 'PUT') {
    const { name, role, active } = req.body as { name?: string; role?: string; active?: boolean };
    try {
      const contact = await updatePortalContact(companyId, contactId, { name, role: role as never, active });
      return apiResponse.success(res, { contact });
    } catch (err) {
      if (err instanceof Error && err.message === 'CONTACT_NOT_FOUND') {
        return apiResponse.notFound(res, 'Portal contact', contactId);
      }
      throw err;
    }
  }

  if (req.method === 'DELETE') {
    log.info('Soft-deleting portal contact', { companyId, contactId }, 'portal-contacts-api');
    await deletePortalContact(companyId, contactId);
    return apiResponse.noContent(res);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PUT', 'DELETE']);
}

export default withCompany(withErrorHandler(handler as never));
```

---

### 6.3 `pages/api/accounting/afs/[documentId]/send-for-signing.ts` — POST

**Auth:** `withCompany` (staff-only)

```typescript
import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs/promises';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { sendForSigning } from '@/modules/accounting/services/afs/signumIntegrationService';
import { notifySigningRequested } from '@/modules/accounting/services/afs/portalNotificationService';
import type { PortalRole } from '@/modules/accounting/services/afs/afsTypes';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;
  const documentId = req.query.documentId as string;
  if (!documentId) return apiResponse.badRequest(res, 'documentId is required');

  const { signerContactIds } = req.body as { signerContactIds?: string[] };
  if (!signerContactIds || !Array.isArray(signerContactIds) || signerContactIds.length === 0) {
    return apiResponse.badRequest(res, 'signerContactIds must be a non-empty array');
  }

  // 1. Load and verify the document
  const docs = await sql`
    SELECT id, status, signing_requested_at
    FROM afs_documents
    WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  `;
  if (docs.length === 0) return apiResponse.notFound(res, 'AFS document', documentId);

  const doc = docs[0] as { id: string; status: string; signing_requested_at: Date | null };
  if (doc.status !== 'partner_review') {
    return apiResponse.badRequest(res, 'Document must be in partner_review status to send for signing');
  }
  if (doc.signing_requested_at) {
    return apiResponse.badRequest(res, 'Signing has already been requested for this document');
  }

  // 2. Load and verify signer contacts
  const contacts = await sql`
    SELECT id, company_id, name, email, role
    FROM portal_contacts
    WHERE id = ANY(${signerContactIds}::UUID[])
      AND company_id = ${companyId}::UUID
      AND active = true
  `;
  if (contacts.length !== signerContactIds.length) {
    return apiResponse.badRequest(res, 'One or more signer contacts not found or inactive');
  }

  const signerRoles: PortalRole[] = ['director', 'cfo'];
  for (const c of contacts) {
    if (!signerRoles.includes(c.role as PortalRole)) {
      return apiResponse.badRequest(res, `Contact ${String(c.name)} has role '${String(c.role)}' — only directors and CFOs can sign`);
    }
  }

  // 3. Load the rendered AFS HTML
  //    The HTML is stored at /storage/afs-html/{companyId}/{documentId}.html by the render service.
  const htmlPath = `/storage/afs-html/${companyId}/${documentId}.html`;
  let html: string;
  try {
    html = await fs.readFile(htmlPath, 'utf-8');
  } catch {
    return apiResponse.badRequest(res, 'Rendered HTML not yet generated for this document');
  }

  // 4. Load company name for the document title
  const companies = await sql`
    SELECT name FROM companies WHERE id = ${companyId}::UUID LIMIT 1
  `;
  const companyName = companies.length > 0 ? String(companies[0]!.name) : 'Company';
  const title = `Annual Financial Statements — ${companyName}`;

  // 5. Send to Signum (JSON body, not multipart — real API uses /documents/from-html)
  const signers = contacts.map((c) => ({
    email: String(c.email),
    name: String(c.name),
  }));
  const { signumDocumentId, signingTokens } = await sendForSigning(documentId, companyId, html, title, signers);

  // 6. Notify each signer with their individual signing URL
  const callbackBaseUrl = process.env.SIGNUM_CALLBACK_BASE_URL ?? 'https://app.isaflow.co.za/sign';
  for (const c of contacts) {
    const signerToken = signingTokens.find((t) => t.email === String(c.email));
    const signingUrl = signerToken
      ? `${callbackBaseUrl}/${signerToken.signingToken}`
      : callbackBaseUrl;
    await notifySigningRequested(
      { id: String(c.id), companyId, name: String(c.name), email: String(c.email), role: c.role as PortalRole, active: true, createdAt: new Date(), updatedAt: new Date() },
      documentId,
      signingUrl,
    );
  }

  log.info('Document sent for signing', { documentId, signumDocumentId, signerCount: signers.length }, 'send-for-signing-api');
  return apiResponse.success(res, { signumDocumentId, message: 'Signing requests sent' });
}

export default withCompany(withErrorHandler(handler as never));
```

**Status flow:** The document stays in `'partner_review'`. The `sendForSigning` service sets `signing_requested_at = now()` on the afs_documents record. The webhook handler (6.4) will set `status = 'signed_off'` when signing completes.

---

### 6.4 `pages/api/accounting/afs/webhook/signum.ts` — POST

**Auth:** None (webhook endpoint) — secured by HMAC signature verification

```typescript
import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs/promises';
import path from 'path';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { verifySignumWebhookSignature, downloadSignedPdf } from '@/modules/accounting/services/afs/signumIntegrationService';
import { notifyDocumentSignedOff } from '@/modules/accounting/services/afs/portalNotificationService';

export const config = { api: { bodyParser: false } };

function readRawBody(req: NextApiRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  // 1. Read raw body for HMAC verification
  const rawBody = await readRawBody(req);
  const signatureHeader = req.headers['x-signum-signature'];
  if (typeof signatureHeader !== 'string') {
    log.warn('Signum webhook: missing X-Signum-Signature header', {}, 'signum-webhook');
    return res.status(401).json({ error: 'Missing signature' });
  }

  // verifySignumWebhookSignature expects the full header value including the 'sha256=' prefix
  if (!verifySignumWebhookSignature(rawBody, signatureHeader)) {
    log.warn('Signum webhook HMAC verification failed', {}, 'signum-webhook');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // 2. Parse body
  // Signum sends: document.signed | document.declined | document.cancelled | document.expired
  const body = JSON.parse(rawBody) as { documentId: string; event: string; signedAt?: string };

  if (!['document.signed', 'document.declined', 'document.cancelled', 'document.expired'].includes(body.event)) {
    log.info('Signum webhook: unrecognised event, acknowledging', { event: body.event }, 'signum-webhook');
    return res.status(200).json({ received: true }); // acknowledge unknown events gracefully
  }

  // 3. Look up afs_document by signum_document_id
  const rows = await sql`
    SELECT id, company_id FROM afs_documents
    WHERE signum_document_id = ${body.documentId}
    LIMIT 1
  `;
  if (rows.length === 0) {
    log.warn('Signum webhook: no afs_document for signum_document_id', { signumDocumentId: body.documentId, event: body.event }, 'signum-webhook');
    return res.status(200).json({ received: true }); // don't retry
  }
  const doc = rows[0] as { id: string; company_id: string };

  // Handle non-signed terminal events (declined, cancelled, expired)
  if (body.event !== 'document.signed') {
    // Reset signing state so staff can resend for signing if needed
    await sql`
      UPDATE afs_documents
      SET signum_document_id = NULL,
          signing_requested_at = NULL,
          updated_at = now()
      WHERE id = ${doc.id}::UUID AND company_id = ${doc.company_id}::UUID
    `;
    log.info('Signum signing terminal event — signing state reset', { documentId: doc.id, event: body.event }, 'signum-webhook');
    return res.status(200).json({ received: true });
  }

  // 4. Download signed PDF from Signum
  const pdfBuffer = await downloadSignedPdf(body.documentId);

  // 5. Store to /storage/afs-signed/{companyId}/{documentId}.pdf
  const storagePath = `/storage/afs-signed/${doc.company_id}/${doc.id}.pdf`;
  await fs.mkdir(path.dirname(storagePath), { recursive: true });
  await fs.writeFile(storagePath, pdfBuffer);

  // 6. Update afs_document: status → 'signed_off', locked_at = now(), signed_pdf_path
  await sql`
    UPDATE afs_documents
    SET status = 'signed_off',
        locked_at = now(),
        signed_pdf_path = ${storagePath},
        updated_at = now()
    WHERE id = ${doc.id}::UUID AND company_id = ${doc.company_id}::UUID
  `;

  // 7. Notify portal contacts
  await notifyDocumentSignedOff(doc.company_id, doc.id);

  log.info('Document signed off via Signum webhook', { documentId: doc.id, signumDocumentId: body.documentId }, 'signum-webhook');
  return res.status(200).json({ received: true });
}

export default withErrorHandler(handler as never);
```

**Notes:**
- `bodyParser: false` is mandatory. HMAC must be computed over the raw bytes before any JSON parsing.
- `withErrorHandler` wraps the handler but `withCompany` is NOT used — webhooks have no company context in the request headers.
- `readRawBody` is inlined (simple utility, not worth a separate file).
- `X-Signum-Signature` format is `sha256=<hex>`. The `verifySignumWebhookSignature` function handles the prefix stripping internally — pass the full header value.
- Signum sends four event types: `document.signed`, `document.declined`, `document.cancelled`, `document.expired`. Only `document.signed` triggers the sign-off flow; the other three reset signing state so staff can resend.

**Known unknown — signed PDF download:**
`downloadSignedPdf` calls `GET ${SIGNUM_API_URL}/documents/{id}/download`. This path has not been confirmed against the real Signum API. It is possible the signed PDF URL is included in the `document.signed` webhook payload instead. Before implementing, verify:
1. Does `GET /documents/{id}/download` exist and return the signed PDF binary?
2. Or does the `document.signed` payload include a `signedPdfUrl` field?

If option 2, replace the `downloadSignedPdf` call with a direct `fetch(body.signedPdfUrl)` and remove the `downloadSignedPdf` function.

---

### 6.5 `pages/api/accounting/portal/auth.ts` — POST / GET

**Auth:** None (public endpoint — issues the session)

**Rate limiting:** `POST` is rate-limited to 5 requests per minute per IP to prevent brute-force magic link abuse. Implement via a simple in-memory counter (or middleware if available).

```typescript
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { verifyMagicLink, generateMagicLink } from '@/modules/accounting/services/afs/magicLinkService';
import { notifyMagicLinkRequested } from '@/modules/accounting/services/afs/portalNotificationService';
import { createPortalSessionCookie, PORTAL_SESSION_TTL_HOURS } from '@/lib/portalAuth';
import type { PortalRole, PortalSession } from '@/modules/accounting/services/afs/afsTypes';

// ── Simple in-memory rate limiter (5 req/min per IP) ──
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    // Rate limit by IP
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    if (isRateLimited(ip)) {
      return apiResponse.tooManyRequests(res, 'Too many login attempts. Please try again in a minute.');
    }

    const { email } = req.body as { email?: string };
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return apiResponse.badRequest(res, 'A valid email is required');
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Look up contact — search across all companies (magic link lookup is by token, not by company)
    // We return { sent: true } regardless to prevent email enumeration
    const contacts = await sql`
      SELECT id, company_id, name, email, role
      FROM portal_contacts
      WHERE email = ${normalizedEmail} AND active = true
      LIMIT 1
    `;

    if (contacts.length > 0) {
      const contact = contacts[0] as { id: string; company_id: string; name: string; email: string; role: string };
      const { token } = await generateMagicLink(String(contact.company_id), String(contact.id));
      const magicLinkUrl = `https://app.isaflow.co.za/api/accounting/portal/auth?token=${token}`;

      await notifyMagicLinkRequested(
        {
          id: String(contact.id),
          companyId: String(contact.company_id),
          name: String(contact.name),
          email: String(contact.email),
          role: contact.role as PortalRole,
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        magicLinkUrl,
      );
    }

    // Always return success — prevent email enumeration
    return apiResponse.success(res, { sent: true });
  }

  if (req.method === 'GET') {
    const token = req.query.token as string;
    if (!token) {
      return res.redirect(302, '/accounting/afs/portal/login?error=missing_token');
    }

    const result = await verifyMagicLink(token);
    if (!result) {
      return res.redirect(302, '/accounting/afs/portal/login?error=expired');
    }

    const { contact, companyId } = result;
    const expiresAt = new Date(Date.now() + PORTAL_SESSION_TTL_HOURS * 3600 * 1000).toISOString();
    const session: PortalSession = {
      contactId: contact.id,
      companyId,
      role: contact.role,
      expiresAt,
    };

    await createPortalSessionCookie(res, session);
    log.info('Portal session created', { contactId: contact.id, companyId }, 'portal-auth-api');
    return res.redirect(302, '/accounting/afs/portal/dashboard');
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST', 'GET']);
}

export default withErrorHandler(handler as never);
```

**Notes:**
- `POST` email lookup is intentionally cross-tenant (no `company_id` filter) because the user enters only their email. The `company_id` comes from the portal_contacts record. This is safe: the token points to a specific contact+company pair.
- `GET` returns a redirect, not JSON — the browser follows it.
- Rate limiting is in-memory (resets on deploy). For production, consider Redis-backed rate limiting.

---

### 6.6 `pages/api/accounting/portal/documents.ts` — GET

**Auth:** `withPortalAuth`

```typescript
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { withPortalAuth, type PortalApiRequest } from '@/lib/portalAuth';
import { PORTAL_ACCESS_RULES } from '@/modules/accounting/services/afs/afsTypes';

async function handler(req: PortalApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId, role } = req.portalSession;
  const rules = PORTAL_ACCESS_RULES[role];
  const { documentTypes, statuses } = rules;

  log.info('Portal: listing documents', { companyId, role }, 'portal-documents-api');

  const documents = await sql`
    SELECT id, fiscal_year, period, document_type, status, created_at, updated_at
    FROM afs_documents
    WHERE company_id = ${companyId}::UUID
      AND document_type = ANY(${documentTypes}::TEXT[])
      AND (${statuses.length === 0} OR status = ANY(${statuses}::TEXT[]))
    ORDER BY created_at DESC
  `;

  return apiResponse.success(res, { documents });
}

export default withPortalAuth(withErrorHandler(handler as never) as never);
```

---

### 6.7 `pages/api/accounting/portal/documents/[documentId].ts` — GET

**Auth:** `withPortalAuth`

```typescript
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { withPortalAuth, type PortalApiRequest } from '@/lib/portalAuth';
import { PORTAL_ACCESS_RULES } from '@/modules/accounting/services/afs/afsTypes';

async function handler(req: PortalApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId, role } = req.portalSession;
  const documentId = req.query.documentId as string;
  if (!documentId) return apiResponse.badRequest(res, 'documentId is required');

  log.info('Portal: loading document', { companyId, documentId, role }, 'portal-document-api');

  // Load document
  const docs = await sql`
    SELECT id, fiscal_year, period, document_type, status, signing_requested_at, created_at, updated_at
    FROM afs_documents
    WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  `;
  if (docs.length === 0) return apiResponse.notFound(res, 'Document', documentId);

  const doc = docs[0] as { id: string; document_type: string; status: string };

  // Check access rules
  const rules = PORTAL_ACCESS_RULES[role];
  if (!rules.documentTypes.includes(doc.document_type as 'afs' | 'management_pack')) {
    return apiResponse.forbidden(res, 'You do not have access to this document type');
  }
  if (rules.statuses.length > 0 && !rules.statuses.includes(doc.status)) {
    return apiResponse.forbidden(res, 'You do not have access to this document in its current status');
  }

  // Load sections (exclude version_history for payload size)
  const sections = await sql`
    SELECT id, section_type, sort_order, status, content, ai_narrative, created_at, updated_at
    FROM afs_sections
    WHERE document_id = ${documentId}::UUID AND company_id = ${companyId}::UUID
    ORDER BY sort_order ASC
  `;

  return apiResponse.success(res, { document: doc, sections });
}

export default withPortalAuth(withErrorHandler(handler as never) as never);
```

---

### 6.8 `pages/api/accounting/portal/documents/[documentId]/annotate.ts` — POST

**Auth:** `withPortalAuth`

```typescript
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { withPortalAuth, type PortalApiRequest } from '@/lib/portalAuth';
import { PORTAL_ACCESS_RULES } from '@/modules/accounting/services/afs/afsTypes';
import { notifyAnnotationReceived } from '@/modules/accounting/services/afs/portalNotificationService';

async function handler(req: PortalApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId, role, contactId } = req.portalSession;
  const documentId = req.query.documentId as string;
  if (!documentId) return apiResponse.badRequest(res, 'documentId is required');

  // Check annotation permission
  const rules = PORTAL_ACCESS_RULES[role];
  if (!rules.canAnnotate) {
    return apiResponse.forbidden(res, 'Your role does not allow annotations');
  }

  const { sectionId, body: commentBody } = req.body as { sectionId?: string; body?: string };
  if (!sectionId || typeof sectionId !== 'string') {
    return apiResponse.badRequest(res, 'sectionId is required');
  }
  if (!commentBody || typeof commentBody !== 'string' || !commentBody.trim()) {
    return apiResponse.badRequest(res, 'Comment body is required');
  }

  // Verify document belongs to company and is not signed off
  const docs = await sql`
    SELECT id, status FROM afs_documents
    WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  `;
  if (docs.length === 0) return apiResponse.notFound(res, 'Document', documentId);

  const doc = docs[0] as { id: string; status: string };
  if (doc.status === 'signed_off' || doc.status === 'filed') {
    return apiResponse.badRequest(res, 'Annotations are disabled on signed or filed documents');
  }

  // Verify section belongs to this document and company
  const sections = await sql`
    SELECT id FROM afs_sections
    WHERE id = ${sectionId}::UUID
      AND document_id = ${documentId}::UUID
      AND company_id = ${companyId}::UUID
    LIMIT 1
  `;
  if (sections.length === 0) return apiResponse.notFound(res, 'Section', sectionId);

  // Insert comment with author_type = 'portal'
  const inserted = await sql`
    INSERT INTO afs_section_comments (section_id, company_id, author_id, author_type, body)
    VALUES (${sectionId}::UUID, ${companyId}::UUID, ${contactId}::UUID, 'portal', ${commentBody.trim()})
    RETURNING id
  `;

  const commentId = String(inserted[0]!.id);

  // Load contact name for notification
  const contactRows = await sql`
    SELECT name FROM portal_contacts
    WHERE id = ${contactId}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  `;
  const authorName = contactRows.length > 0 ? String(contactRows[0]!.name) : 'Portal contact';

  await notifyAnnotationReceived(companyId, sectionId, authorName);

  log.info('Portal annotation created', { companyId, documentId, sectionId, commentId, contactId }, 'portal-annotate-api');
  return apiResponse.created(res, { commentId }, 'Annotation saved');
}

export default withPortalAuth(withErrorHandler(handler as never) as never);
```

**Key fix:** Sets `author_type = 'portal'` on the comment row (requires the `author_type` column from the prerequisites section). Staff comments set `author_type = 'staff'` (default).

---

## 7. Pages

### 7.1 `pages/accounting/afs/portal/login.tsx` — Magic Link Request Form

**Route:** `/accounting/afs/portal/login`  
**Auth:** None (public)

```tsx
// No ISaFlow staff nav — full-page portal branding
// Components:
// - ISaFlow logo + "Client Portal" label
// - Email input field
// - "Send sign-in link" button
// - "Check your email" confirmation state after submission
// - Error state for bad requests / expired tokens (from query param)

// On submit: POST /api/accounting/portal/auth { email }
// On success: show confirmation message (do not reveal whether email exists)
// On API error: show generic "Something went wrong" message (never "email not found")
```

**State machine:**
- `idle` → `loading` (on submit) → `sent` (on success) or `error` (on failure)

**Styling notes:**
- Centred card layout — no sidebar nav.
- ISaFlow branding: logo top-centre, portal tagline below.
- Mobile-first responsive.
- Display `?error=expired` and `?error=missing_token` query params as user-friendly messages.

---

### 7.2 `pages/accounting/afs/portal/dashboard.tsx` — Client Portal Dashboard

**Route:** `/accounting/afs/portal/dashboard`  
**Auth:** Portal session required (redirect to login if missing)

**Sections:**
1. **Latest AFS** — most recent `afs` document, status badge, year, download button (if `signed_off`).
2. **Recent Management Packs** — last 6 `management_pack` documents, month, status, download.
3. **Pending Actions** — signing requests (links to `/accounting/afs/sign/[token]`), annotation replies needed.
4. **Filing Deadlines** — CIPC annual return date, provisional tax dates (read from `afs_documents.filing_deadline_at` when available).
5. **Firm Contact** — company accounting firm name, contact email/phone (from `companies` table).

**Data fetching:**
- `GET /api/accounting/portal/documents` — all accessible documents.
- Filter client-side into AFS vs management packs.
- Use `getServerSideProps` with portal session cookie validation to avoid flash-of-unauthenticated-content.

```typescript
export async function getServerSideProps(context: GetServerSidePropsContext) {
  const cookie = context.req.cookies['portal_session'];
  if (!cookie) return { redirect: { destination: '/accounting/afs/portal/login', permanent: false } };
  // Verify cookie server-side with verifyPortalToken; if invalid, redirect
  // Pass session to page as prop
}
```

---

### 7.3 `pages/accounting/afs/portal/documents/[documentId].tsx` — Document Viewer

**Route:** `/accounting/afs/portal/documents/[documentId]`  
**Auth:** Portal session required

**Layout:**
- Left sidebar: section list with status badges, scroll-spy highlighting active section.
- Right main area: full-width rendered document sections (HTML/CSS — same `NoteContent` model as staff UI).
- Top bar: document title, fiscal year, status badge, download button (if `signed_off`).

**Annotation layer (directors + CFOs only):**
- Each section has a "Comment" button.
- On click: inline textarea appears below the section.
- On submit: `POST /api/accounting/portal/documents/[documentId]/annotate`.
- Existing annotations shown as comment threads below each section.
- `shareholder_readonly` and `external_auditor` see no comment UI.

**Data fetching:**
- `GET /api/accounting/portal/documents/[documentId]` — document + sections.

---

### 7.4 `pages/accounting/afs/sign/[token].tsx` — Signing Page

**Route:** `/accounting/afs/sign/[token]`  
**Auth:** None — the token IS the auth. Signum validates it.

**Layout:**
- ISaFlow header with logo (no nav links — signing context only).
- Full-height iframe. The `src` is built server-side from `SIGNUM_CALLBACK_BASE_URL` passed via `getServerSideProps` — no `NEXT_PUBLIC_` env var needed:
  ```tsx
  // Props passed from getServerSideProps:
  // { callbackBaseUrl: string }
  
  <iframe
    src={`${callbackBaseUrl}/${token}?embed=true`}
    style={{ width: '100%', height: 'calc(100vh - 64px)', border: 'none' }}
  />
  ```
- `postMessage` listener:
  ```typescript
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data?.type === 'signum:signed') {
        setSigningComplete(true);
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);
  ```
- On `signingComplete = true`: replace iframe with a success screen:
  - "Thank you — your signature has been recorded."
  - "You will receive a copy of the signed document by email."
  - Link to portal dashboard (if the contact has an active session) or close-window instruction.

**`getServerSideProps`:**
```typescript
export async function getServerSideProps() {
  const callbackBaseUrl = process.env.SIGNUM_CALLBACK_BASE_URL ?? '';
  return { props: { callbackBaseUrl } };
}
```

**Why not `NEXT_PUBLIC_SIGNUM_CALLBACK_BASE_URL`?** The `NEXT_PUBLIC_` approach would bake the URL into the browser bundle for every page. Using `getServerSideProps` limits exposure to the signing page only and avoids a second env var to maintain.

---

## 8. Tests

### 8.1 `tests/unit/services/afs/portalContactService.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql } from '@/lib/neon';
import {
  listPortalContacts,
  createPortalContact,
  updatePortalContact,
  deletePortalContact,
  getPortalContactByEmail,
} from '@/modules/accounting/services/afs/portalContactService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY_ID = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const CONTACT_ROW = {
  id: 'c1c1c1c1-0000-0000-0000-000000000001',
  company_id: COMPANY_ID,
  name: 'Alice Director',
  email: 'alice@example.com',
  role: 'director',
  active: true,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

describe('portalContactService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('listPortalContacts maps DB rows to PortalContact objects', async () => {
    mockSql.mockResolvedValueOnce([CONTACT_ROW]);
    const contacts = await listPortalContacts(COMPANY_ID);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.name).toBe('Alice Director');
    expect(contacts[0]!.role).toBe('director');
    expect(contacts[0]!.companyId).toBe(COMPANY_ID);
  });

  it('listPortalContacts returns empty array when no contacts', async () => {
    mockSql.mockResolvedValueOnce([]);
    const contacts = await listPortalContacts(COMPANY_ID);
    expect(contacts).toHaveLength(0);
  });

  it('createPortalContact inserts and returns new contact', async () => {
    mockSql.mockResolvedValueOnce([CONTACT_ROW]);
    const contact = await createPortalContact(COMPANY_ID, {
      name: 'Alice Director',
      email: 'alice@example.com',
      role: 'director',
    });
    expect(contact.id).toBe(CONTACT_ROW.id);
    expect(contact.email).toBe('alice@example.com');
  });

  it('createPortalContact throws DUPLICATE_EMAIL on unique constraint violation', async () => {
    mockSql.mockRejectedValueOnce(new Error('unique constraint violation'));
    await expect(
      createPortalContact(COMPANY_ID, { name: 'Bob', email: 'alice@example.com', role: 'cfo' })
    ).rejects.toThrow('DUPLICATE_EMAIL');
  });

  it('updatePortalContact verifies company ownership before updating', async () => {
    mockSql
      .mockResolvedValueOnce([CONTACT_ROW])  // ownership check
      .mockResolvedValueOnce([{ ...CONTACT_ROW, name: 'Alice Updated' }]); // update
    const contact = await updatePortalContact(COMPANY_ID, CONTACT_ROW.id, { name: 'Alice Updated' });
    expect(contact.name).toBe('Alice Updated');
  });

  it('updatePortalContact throws when contact does not belong to company', async () => {
    mockSql.mockResolvedValueOnce([]); // ownership check returns nothing
    await expect(
      updatePortalContact('other-company', CONTACT_ROW.id, { name: 'Evil' })
    ).rejects.toThrow('CONTACT_NOT_FOUND');
  });

  it('deletePortalContact soft-deletes by setting active = false', async () => {
    mockSql.mockResolvedValueOnce([]); // update result
    await deletePortalContact(COMPANY_ID, CONTACT_ROW.id);
    expect(mockSql).toHaveBeenCalled();
  });

  it('getPortalContactByEmail scopes by companyId', async () => {
    mockSql.mockResolvedValueOnce([CONTACT_ROW]);
    const contact = await getPortalContactByEmail(COMPANY_ID, 'alice@example.com');
    expect(contact).not.toBeNull();
    expect(contact!.companyId).toBe(COMPANY_ID);
  });

  it('getPortalContactByEmail returns null when not found', async () => {
    mockSql.mockResolvedValueOnce([]);
    const contact = await getPortalContactByEmail(COMPANY_ID, 'unknown@example.com');
    expect(contact).toBeNull();
  });
});
```

---

### 8.2 `tests/unit/services/afs/magicLinkService.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return { ...actual, randomBytes: vi.fn(() => Buffer.from('a'.repeat(32))) };
});

import { sql } from '@/lib/neon';
import { generateMagicLink, verifyMagicLink } from '@/modules/accounting/services/afs/magicLinkService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY_ID = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const CONTACT_ID = 'c1c1c1c1-0000-0000-0000-000000000001';
const MOCK_TOKEN = '61'.repeat(32); // hex of 32 'a' bytes

const CONTACT_ROW = {
  id: CONTACT_ID,
  company_id: COMPANY_ID,
  name: 'Alice Director',
  email: 'alice@example.com',
  role: 'director',
  active: true,
  created_at: new Date(),
  updated_at: new Date(),
};

const LINK_ROW = {
  id: 'link-id-1',
  company_id: COMPANY_ID,
  contact_id: CONTACT_ID,
  token: MOCK_TOKEN,
  expires_at: new Date(Date.now() + 15 * 60 * 1000),
  used_at: null,
  created_at: new Date(),
};

describe('magicLinkService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('generateMagicLink returns token and expiresAt', async () => {
    mockSql
      .mockResolvedValueOnce([]) // invalidate old tokens
      .mockResolvedValueOnce([]); // insert new
    const { token, expiresAt } = await generateMagicLink(COMPANY_ID, CONTACT_ID);
    expect(typeof token).toBe('string');
    expect(token.length).toBe(64); // 32 bytes = 64 hex chars
    expect(expiresAt).toBeInstanceOf(Date);
  });

  it('generateMagicLink sets expiry 15 minutes from now', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const before = Date.now();
    const { expiresAt } = await generateMagicLink(COMPANY_ID, CONTACT_ID);
    const after = Date.now();
    const diffMs = expiresAt.getTime() - before;
    expect(diffMs).toBeGreaterThan(14 * 60 * 1000);
    expect(diffMs).toBeLessThan(15 * 60 * 1000 + (after - before));
  });

  it('verifyMagicLink returns contact for valid unused token', async () => {
    mockSql
      .mockResolvedValueOnce([LINK_ROW])     // SELECT token
      .mockResolvedValueOnce([{ id: 'x' }])  // UPDATE used_at (RETURNING id)
      .mockResolvedValueOnce([CONTACT_ROW]);  // SELECT contact
    const result = await verifyMagicLink(MOCK_TOKEN);
    expect(result).not.toBeNull();
    expect(result?.contact.id).toBe(CONTACT_ID);
    expect(result?.companyId).toBe(COMPANY_ID);
  });

  it('verifyMagicLink returns null for expired token', async () => {
    mockSql.mockResolvedValueOnce([]); // no rows = expired or already used
    const result = await verifyMagicLink('bad-token');
    expect(result).toBeNull();
  });

  it('verifyMagicLink returns null when concurrent request already consumed token', async () => {
    mockSql
      .mockResolvedValueOnce([LINK_ROW]) // SELECT finds the token
      .mockResolvedValueOnce([]);         // UPDATE returns nothing (race condition)
    const result = await verifyMagicLink(MOCK_TOKEN);
    expect(result).toBeNull();
  });
});
```

---

### 8.3 `tests/unit/services/afs/signumIntegrationService.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { sql } from '@/lib/neon';
import {
  downloadSignedPdf,
  verifySignumWebhookSignature,
} from '@/modules/accounting/services/afs/signumIntegrationService';

describe('signumIntegrationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SIGNUM_API_URL = 'https://signum.velocityfibre.co.za/api/v1';
    process.env.SIGNUM_API_KEY = 'test-api-key';
    process.env.SIGNUM_WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.SIGNUM_CALLBACK_BASE_URL = 'https://app.isaflow.co.za/sign';
    process.env.SIGNUM_EXPIRES_IN_DAYS = '14';
  });

  describe('downloadSignedPdf', () => {
    it('returns Buffer from Signum download endpoint', async () => {
      const pdfBytes = new Uint8Array([37, 80, 68, 70]); // %PDF
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => pdfBytes.buffer,
      });
      const buffer = await downloadSignedPdf('signum-doc-id-1');
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer[0]).toBe(37); // %
    });

    it('throws when Signum returns non-2xx', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
      await expect(downloadSignedPdf('missing-id')).rejects.toThrow('Signum download failed: 404');
    });
  });

  describe('verifySignumWebhookSignature', () => {
    it('returns true for valid HMAC with sha256= prefix', () => {
      const crypto = require('crypto');
      const payload = '{"event":"document.signed"}';
      const secret = 'test-webhook-secret';
      const hex = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      const header = `sha256=${hex}`; // Signum sends this format
      expect(verifySignumWebhookSignature(payload, header)).toBe(true);
    });

    it('returns false when sha256= prefix is missing', () => {
      const crypto = require('crypto');
      const payload = '{"event":"document.signed"}';
      const secret = 'test-webhook-secret';
      const hex = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      // Pass raw hex without prefix — should be rejected
      expect(verifySignumWebhookSignature(payload, hex)).toBe(false);
    });

    it('returns false for tampered payload', () => {
      const payload = '{"event":"document.signed"}';
      const fakeSig = `sha256=${'a'.repeat(64)}`;
      expect(verifySignumWebhookSignature(payload, fakeSig)).toBe(false);
    });

    it('returns false for null header', () => {
      expect(verifySignumWebhookSignature('payload', null)).toBe(false);
    });

    it('throws when SIGNUM_WEBHOOK_SECRET is not set', () => {
      delete process.env.SIGNUM_WEBHOOK_SECRET;
      expect(() => verifySignumWebhookSignature('payload', 'sha256=abc')).toThrow('SIGNUM_WEBHOOK_SECRET not configured');
    });
  });

  describe('sendForSigning', () => {
    it('calls /documents/from-html with JSON body, stores signumDocumentId, and returns tokens', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          documentId: 'signum-123',
          signers: [{ email: 'alice@example.com', signingToken: 'tok-abc' }],
        }),
      });

      const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
      mockSql.mockResolvedValue([]);

      const { sendForSigning } = await import('@/modules/accounting/services/afs/signumIntegrationService');
      const result = await sendForSigning(
        'doc-id-1',
        'd27bac33-cdc0-4e58-bf6b-709c1597d41c',
        '<html>AFS content</html>',
        'Annual Financial Statements — Test Co',
        [{ email: 'alice@example.com', name: 'Alice' }],
      );

      expect(result.signumDocumentId).toBe('signum-123');
      expect(result.signingTokens).toHaveLength(1);
      expect(result.signingTokens[0]!.signingToken).toBe('tok-abc');

      // Must call /documents/from-html (JSON), not /documents (multipart)
      expect(mockFetch).toHaveBeenCalledWith(
        'https://signum.velocityfibre.co.za/api/v1/documents/from-html',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        }),
      );

      // Verify the request body shape
      const callArgs = mockFetch.mock.calls[0]![1] as { body: string };
      const body = JSON.parse(callArgs.body) as Record<string, unknown>;
      expect(body.html).toBe('<html>AFS content</html>');
      expect(body.senderEmail).toBe('accounts@isaflow.co.za');
      expect(body.callbackBaseUrl).toBe('https://app.isaflow.co.za/sign');
      expect(body.expiresInDays).toBe(14);
    });

    it('throws when Signum create returns non-2xx', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Internal Error' });
      const { sendForSigning } = await import('@/modules/accounting/services/afs/signumIntegrationService');
      await expect(
        sendForSigning('doc-id-1', 'comp-id', '<html/>', 'Title', [])
      ).rejects.toThrow('Signum create failed: 500');
    });

    it('throws when SIGNUM_API_URL is not configured', async () => {
      delete process.env.SIGNUM_API_URL;
      const { sendForSigning } = await import('@/modules/accounting/services/afs/signumIntegrationService');
      await expect(
        sendForSigning('doc-id-1', 'comp-id', '<html/>', 'Title', [])
      ).rejects.toThrow('SIGNUM_API_URL');
    });
  });
});
```

---

### 8.4 `tests/unit/services/afs/portalJwt.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';

describe('portalJwt', () => {
  beforeEach(() => {
    process.env.PORTAL_JWT_SECRET = 'test-portal-secret-that-is-long-enough-32chars';
  });

  it('signPortalToken + verifyPortalToken round-trips', async () => {
    const { signPortalToken, verifyPortalToken } = await import('@/lib/auth/portalJwt');
    const session = {
      contactId: 'c1',
      companyId: 'comp1',
      role: 'director' as const,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    const token = await signPortalToken(session);
    const result = await verifyPortalToken(token);
    expect(result).not.toBeNull();
    expect(result!.contactId).toBe('c1');
    expect(result!.companyId).toBe('comp1');
    expect(result!.role).toBe('director');
  });

  it('verifyPortalToken returns null for staff JWT', async () => {
    // A token signed with a different secret should fail
    const { SignJWT } = await import('jose');
    const staffSecret = new TextEncoder().encode('completely-different-staff-secret-32chars');
    const staffToken = await new SignJWT({ sub: 'user1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(staffSecret);

    const { verifyPortalToken } = await import('@/lib/auth/portalJwt');
    const result = await verifyPortalToken(staffToken);
    expect(result).toBeNull();
  });

  it('signPortalToken throws when PORTAL_JWT_SECRET is not set', async () => {
    delete process.env.PORTAL_JWT_SECRET;
    const { signPortalToken } = await import('@/lib/auth/portalJwt');
    await expect(
      signPortalToken({ contactId: 'c1', companyId: 'comp1', role: 'director', expiresAt: '' })
    ).rejects.toThrow('PORTAL_JWT_SECRET');
  });
});
```

---

## 9. Implementation Order

Execute in this order. Each step is independently deployable.

```
Step 1 — Migrations
  If Plan 5's 338 migration lacks author_type: run 340_add_author_type_to_comments.sql
  Run 341_portal_contacts.sql
  Run 342_portal_magic_links.sql
  Run 343_afs_signum_columns.sql

Step 2 — Type definitions
  Append portal types to afsTypes.ts (PortalRole, PortalContact, MagicLink,
  PortalSession, PORTAL_ACCESS_RULES)

Step 3 — Portal JWT module (write test first — TDD)
  src/lib/auth/portalJwt.ts + portalJwt.test.ts

Step 4 — Services (write tests first — TDD)
  portalContactService.ts + test
  magicLinkService.ts + test
  signumIntegrationService.ts + test
  portalNotificationService.ts (no unit test — email sends are integration-tested)

Step 5 — Portal auth middleware
  src/lib/portalAuth.ts (uses portalJwt.ts)

Step 6 — Internal staff API routes
  portal-contacts.ts (GET/POST)
  portal-contacts/[contactId].ts (PUT/DELETE)
  afs/[documentId]/send-for-signing.ts (POST)

Step 7 — Webhook
  afs/webhook/signum.ts (POST)

Step 8 — Portal API routes
  portal/auth.ts (POST + GET)
  portal/documents.ts (GET)
  portal/documents/[documentId].ts (GET)
  portal/documents/[documentId]/annotate.ts (POST)

Step 9 — Pages
  portal/login.tsx
  portal/dashboard.tsx
  portal/documents/[documentId].tsx
  sign/[token].tsx

Step 10 — Nav config
  Add portal management link to accountingNavConfig.ts:
  { label: 'Portal Contacts', href: '/accounting/afs/portal-contacts', icon: <UsersIcon /> }

Step 11 — Verification
  bun run test:unit
  bunx tsc --noEmit
```

---

## 10. Security Checklist

| Concern | Mitigation |
|---------|-----------|
| Portal contacts accessing wrong tenant data | All portal DB queries use `req.portalSession.companyId` — no URL-provided company IDs |
| Magic link token brute force | 256-bit entropy token; `POST /api/accounting/portal/auth` rate-limited to 5 req/min per IP |
| Token replay | Single-use `used_at` set atomically; race condition guarded by `RETURNING id` check |
| Forged portal session cookie | JWT signed with `PORTAL_JWT_SECRET` (separate from staff `JWT_SECRET`); `HttpOnly; Secure; SameSite=Strict` |
| Staff JWT used on portal routes | `withPortalAuth` uses `verifyPortalToken` with `PORTAL_JWT_SECRET` — a staff token signed with `JWT_SECRET` will fail verification |
| Portal JWT used on staff routes | `withCompany` uses `verifyToken` with `JWT_SECRET` — a portal token signed with `PORTAL_JWT_SECRET` will fail verification |
| Signum webhook spoofing | HMAC-SHA256 verification with `SIGNUM_WEBHOOK_SECRET`; header format `sha256=<hex>` validated before any processing |
| PDF download IDOR | Webhook handler looks up `afs_document` by `signum_document_id` only — no user-controlled document ID |
| Annotation on signed documents | Handler checks `status !== 'signed_off'` and `status !== 'filed'` before inserting comment |
| External auditor annotating | `PORTAL_ACCESS_RULES.external_auditor.canAnnotate = false` enforced in annotate handler |
| Email enumeration on login | `POST /api/accounting/portal/auth` always returns `{ sent: true }` regardless of email existence |
| Author type ambiguity | `afs_section_comments.author_type` column distinguishes `'staff'` vs `'portal'` comments |

---

## 11. File Checklist

| # | File | Type | New / Modified |
|---|------|------|----------------|
| 1 | `scripts/migrations/sql/341_portal_contacts.sql` | Migration | New |
| 2 | `scripts/migrations/sql/342_portal_magic_links.sql` | Migration | New |
| 3 | `scripts/migrations/sql/343_afs_signum_columns.sql` | Migration | New |
| 4 | `src/modules/accounting/services/afs/afsTypes.ts` | Types | Modified (append) |
| 5 | `src/lib/auth/portalJwt.ts` | Auth | New |
| 6 | `src/modules/accounting/services/afs/portalContactService.ts` | Service | New |
| 7 | `src/modules/accounting/services/afs/magicLinkService.ts` | Service | New |
| 8 | `src/modules/accounting/services/afs/signumIntegrationService.ts` | Service | New |
| 9 | `src/modules/accounting/services/afs/portalNotificationService.ts` | Service | New |
| 10 | `src/lib/portalAuth.ts` | Middleware | New |
| 11 | `pages/api/accounting/afs/portal-contacts.ts` | API | New |
| 12 | `pages/api/accounting/afs/portal-contacts/[contactId].ts` | API | New |
| 13 | `pages/api/accounting/afs/[documentId]/send-for-signing.ts` | API | New |
| 14 | `pages/api/accounting/afs/webhook/signum.ts` | API | New |
| 15 | `pages/api/accounting/portal/auth.ts` | API | New |
| 16 | `pages/api/accounting/portal/documents.ts` | API | New |
| 17 | `pages/api/accounting/portal/documents/[documentId].ts` | API | New |
| 18 | `pages/api/accounting/portal/documents/[documentId]/annotate.ts` | API | New |
| 19 | `pages/accounting/afs/portal/login.tsx` | Page | New |
| 20 | `pages/accounting/afs/portal/dashboard.tsx` | Page | New |
| 21 | `pages/accounting/afs/portal/documents/[documentId].tsx` | Page | New |
| 22 | `pages/accounting/afs/sign/[token].tsx` | Page | New |
| 23 | `tests/unit/services/afs/portalContactService.test.ts` | Test | New |
| 24 | `tests/unit/services/afs/magicLinkService.test.ts` | Test | New |
| 25 | `tests/unit/services/afs/signumIntegrationService.test.ts` | Test | New |
| 26 | `tests/unit/services/afs/portalJwt.test.ts` | Test | New |
| 27 | `src/components/layout/accountingNavConfig.ts` | Config | Modified |

---

## 12. Changes from Original Plan (Audit Trail)

### Revision 1 — 2026-04-16 (JWT blocker, migration numbering, status flow, FK, author_type, import paths)

| Issue | Original | Fix |
|-------|----------|-----|
| Migration numbering | 342, 343 | 341, 342, 343 (last existing = 339, Plan 5 takes 340) |
| JWT blocker | Used `signToken`/`verifyToken` with custom secret param (doesn't exist) | New `src/lib/auth/portalJwt.ts` with `signPortalToken`/`verifyPortalToken` |
| Document status after signing request | Set `'awaiting_signatures'` (not in `DocumentStatus`) | Keep `'partner_review'`, set `signing_requested_at` timestamp |
| FK on portal_contacts.company_id | Missing | Added `REFERENCES companies(id) ON DELETE CASCADE` |
| FK on portal_magic_links.company_id | Missing | Added `REFERENCES companies(id) ON DELETE CASCADE` |
| author_id ambiguity | Suggested `portal_author_id` column | Uses `author_type TEXT CHECK (...)` column on `afs_section_comments` |
| `getPortalContactByEmail` scope | No `companyId` parameter | Accepts `companyId` to scope lookup |
| Unused types | `SignumUploadResult`, `PortalDocumentView` | Removed |
| Import paths | Various inconsistencies | Standardised: `@/lib/auth`, `@/lib/api-error-handler`, `@/lib/apiResponse` |
| Handler wrap pattern | `as any` | `as never` (matches existing codebase) |
| `NEXT_PUBLIC_SIGNUM_URL` | Missing from env vars | Added |
| Rate limiting on auth POST | Mentioned in security table but not implemented | Implemented with in-memory counter |
| Email sending | Assumed generic "email infrastructure" | Uses existing `sendEmail` from `emailService.ts` + `emailLayout`/`ctaButton` from shared templates |
| Portal auth POST email lookup | Scoped by company (impossible — user provides only email) | Cross-tenant lookup, safe because token binds to specific contact+company |
| `portalJwt.ts` test | Missing | Added `portalJwt.test.ts` |

### Revision 2 — 2026-04-16 (Real Signum API shape)

| Issue | Assumed | Actual / Fix |
|-------|---------|--------------|
| Signum API URL env var | `SIGNUM_URL=http://signum:3001` | `SIGNUM_API_URL=https://signum.velocityfibre.co.za/api/v1` |
| API key header name | `X-Api-Key` | `x-api-key` |
| Create document endpoint | `POST /api/v1/documents` (multipart, PDF file) | `POST /documents/from-html` (JSON, rendered HTML) |
| Request body format | `FormData` with PDF `Blob` | `JSON` with `html`, `title`, `senderEmail`, `signers`, `callbackBaseUrl`, `expiresInDays` |
| Signum response shape | `{ id, signingUrl }` | `{ documentId, signers: Array<{ email, signingToken }> }` |
| `sendForSigning` signature | Accepts `pdfBuffer: Buffer` + `order` per signer | Accepts `html: string` + `title: string`; signers have no `order` field |
| No separate PDF generation before Signum | Plan loaded PDF from disk | Signum generates the PDF from HTML — load HTML instead |
| Signing token per signer | Single `signumDocumentId` returned | `signingTokens` array — each signer gets their own `signingToken` |
| Signing URL in notification | Built as `${callbackBaseUrl}/${signumDocumentId}` | Built as `${callbackBaseUrl}/${signerToken.signingToken}` per signer |
| Webhook secret header format | Raw hex in `X-Signum-Signature` | `sha256=<hex>` prefixed — `verifySignumWebhookSignature` now requires and validates the prefix |
| Webhook events handled | Only `document.signed` | All four: `document.signed`, `document.declined`, `document.cancelled`, `document.expired` |
| Non-signed terminal events | Not handled | Reset `signum_document_id` + `signing_requested_at` so staff can resend |
| Webhook registration | Called at runtime inside `sendForSigning` | One-time manual step in Signum admin console — removed from runtime code |
| `registerSignumWebhook` function | Exported from service | Removed entirely — not called at runtime |
| Client-side iframe URL env var | `NEXT_PUBLIC_SIGNUM_URL` | Removed; `SIGNUM_CALLBACK_BASE_URL` passed via `getServerSideProps` to signing page |
| New env vars | — | `SIGNUM_CALLBACK_BASE_URL`, `SIGNUM_EXPIRES_IN_DAYS` |
| Removed env vars | `SIGNUM_URL`, `NEXT_PUBLIC_SIGNUM_URL` | Replaced by `SIGNUM_API_URL` + `SIGNUM_CALLBACK_BASE_URL` |
| Signed PDF delivery mechanism | Assumed `GET /documents/{id}/download` exists | **Known unknown** — must confirm with Signum before implementation |

---

*Plan written: 2026-04-16 | Revised: 2026-04-16 (×2) | Scope: Plan 6 of 8 | Depends on: Plans 1–5*
