# encryption.ts

## Purpose
AES-256-GCM encryption/decryption for data at rest (OAuth tokens, admin impersonation stash, other sensitive fields), keyed via the `ENCRYPTION_KEY` env var.

## Key exports
- `isEncryptionAvailable(): boolean` — `true` iff `ENCRYPTION_KEY` is set with ≥32 chars
- `encrypt(plaintext: string): string` — returns `iv:tag:ciphertext` (all hex); throws if key missing
- `decrypt(ciphertext: string): string` — tries PBKDF2-derived key first, falls back to legacy raw-slice key on failure
- `encryptToken(plaintext): string` — like `encrypt` but warns + returns plaintext if no key (soft failure)
- `decryptToken(value): string` — bypasses crypto when value isn't `iv:tag:ct` triple (plaintext-legacy row); otherwise full decrypt with rethrow on tag mismatch (pentest L4)

## Dependencies
- `node:crypto` — `createCipheriv`, `createDecipheriv`, `pbkdf2Sync`, `randomBytes`
- `@/lib/logger`

## Critical notes
- **KDF migration**: new encryptions use PBKDF2-SHA256 with salt `'isaflow-encryption-salt'` and 100 000 iterations, 32-byte output. The legacy raw-slice key (`secret.slice(0,32)` as utf-8 bytes) is still tried as a fallback in `decrypt` so rows encrypted before the migration can still be read. Re-encrypt legacy rows by reading + re-saving each sensitive field (e.g. `bank_accounts` OAuth tokens).
- **Static-salt caveat**: the fixed KDF salt means two installations with the same `ENCRYPTION_KEY` produce the same derived key. Use a strong, unique `ENCRYPTION_KEY` per environment.
- **Pentest L4**: `decryptToken` now rethrows on GCM tag mismatch. Previously it silently returned the raw ciphertext string, letting callers treat tampered data as valid plaintext. Callers must now explicitly handle failure.
- **GCM authentication tag**: `setAuthTag` is called before `decipher.update`; tampered ciphertext throws at `decipher.final`. `decrypt` does NOT catch this — corruption should surface.
- Ciphertext format is `ivHex:tagHex:encryptedHex` (three colon-separated hex strings). `decryptToken` uses `split(':').length === 3` as a plaintext-vs-encrypted heuristic — plaintext values containing two colons would misroute.
- IV is 12 bytes (GCM standard), generated fresh per encryption via `crypto.randomBytes`.
- `ENCRYPTION_KEY` must be in `validateEnv` REQUIRED_VARS — app fails to start without it. Removing it would silently allow `encryptToken` to store tokens as plaintext.
- Never log plaintext secrets; the fallback-decrypt path logs a warning (empty context) so operators know a legacy row was just decrypted.

## Recent changes
- 2026-04-24: Pentest M1+M6+M14+M15+M20+M21+L4 batch — `decryptToken` now rethrows on tag mismatch.
- 2026-04-04: PBKDF2 key derivation introduced; legacy raw key kept as decrypt-fallback.
