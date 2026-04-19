# `src/lib/encryption.ts`

## Purpose
AES-256-GCM encryption/decryption for sensitive data at rest (OAuth tokens, secrets stored in the DB), with PBKDF2 key derivation and a legacy raw-key fallback for pre-migration ciphertext.

## Key exports

- `encrypt(plaintext) → string` — returns `"ivHex:tagHex:ciphertextHex"`. Key is PBKDF2-derived.
- `decrypt(ciphertext) → string` — tries PBKDF2-derived key first; falls back to legacy raw-slice key and logs a warning if the derived key fails.
- `encryptToken(plaintext) → string` — wraps `encrypt`; if `ENCRYPTION_KEY` is absent, logs a warning and returns plaintext (soft failure).
- `decryptToken(value) → string` — if the value doesn't look encrypted (not 3 colon-delimited hex segments), returns it as-is (plaintext fallback). Catches decrypt errors and returns the raw value with a warning.
- `isEncryptionAvailable() → boolean` — checks `ENCRYPTION_KEY` length ≥ 32 without throwing.

## Dependencies
- `node:crypto` — `createCipheriv`, `createDecipheriv`, `randomBytes`, `pbkdf2Sync`
- `@/lib/logger` — `log.warn` on fallback/missing key scenarios

## Critical notes
- **`ENCRYPTION_KEY` must be ≥ 32 chars** — `validateEnv` enforces this at startup. `encrypt` throws if the key is missing or short; `encryptToken` degrades to plaintext.
- **KDF parameters**: PBKDF2-SHA256, 100 000 iterations, static salt `"isaflow-encryption-salt"`, 32-byte output. The salt is not secret (it's fixed), so key entropy comes entirely from `ENCRYPTION_KEY`.
- **Static salt risk**: the fixed KDF salt means two installations with the same `ENCRYPTION_KEY` produce the same derived key. Use a strong, unique `ENCRYPTION_KEY` per environment.
- **Legacy migration**: data encrypted before the PBKDF2 change uses a raw 32-byte slice of `ENCRYPTION_KEY`. `decrypt` falls back to this automatically but logs a warning. Re-encrypt by reading and re-saving each field (e.g. `bank_accounts` OAuth tokens).
- **Ciphertext format**: `ivHex:tagHex:encryptedHex` — the `decryptToken` heuristic relies on this being exactly 3 colon-separated segments to distinguish encrypted from plaintext.
- **GCM authentication tag**: `setAuthTag` is called before `decipher.update`; tampered ciphertext will throw at `decipher.final`, which `decrypt` does NOT catch (intentional — corruption should surface).
- **Never log plaintext or ciphertext** from this module.
