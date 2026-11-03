/**
 * Server-only hashing of JSON-able values (node:crypto; never import it from a page). `sha256Json` is the digest of a
 * value's JSON text, so equal values in equal key order hash equal; `md5Hex` stands in for a large text (a logo) the way
 * Postgres md5() does, so a value read either way hashes the same.
 */
import { createHash } from 'node:crypto';

export const sha256Json = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const md5Hex = (text: string): string => createHash('md5').update(text).digest('hex');
