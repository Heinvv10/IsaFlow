/**
 * write:post opt-in gating — MCP Phase 3, Task 3.1 (the Hein decision:
 * write:post is unchecked by default EVEN when the client requests it, and
 * is granted only when the user explicitly opts in).
 */
import { describe, it, expect } from 'vitest';
import {
  OPT_IN_SCOPES,
  isOptInScope,
  partitionRequestedScopes,
  buildGrantedScopes,
} from '@/lib/auth/consentScopes';
import { PAT_SCOPES } from '@/lib/auth/patScopes';
import { OAUTH_SCOPES } from '@/lib/auth/oauthScopes';

describe('scope vocabularies include write:post', () => {
  it('PAT_SCOPES and OAUTH_SCOPES both contain write:post', () => {
    expect(PAT_SCOPES).toContain('write:post');
    expect(OAUTH_SCOPES).toContain('write:post');
  });
});

describe('opt-in classification', () => {
  it('write:post is the (only) opt-in scope', () => {
    expect(OPT_IN_SCOPES).toContain('write:post');
    expect(isOptInScope('write:post')).toBe(true);
    expect(isOptInScope('write:journals')).toBe(false);
    expect(isOptInScope('read:reports')).toBe(false);
  });
});

describe('partitionRequestedScopes', () => {
  it('splits requested scopes into auto-granted and opt-in', () => {
    const { autoGranted, optIn } = partitionRequestedScopes([
      'read:reports', 'write:journals', 'write:post',
    ]);
    expect(autoGranted).toEqual(['read:reports', 'write:journals']);
    expect(optIn).toEqual(['write:post']);
  });

  it('no opt-in scopes requested → empty optIn', () => {
    const { autoGranted, optIn } = partitionRequestedScopes(['read:reports']);
    expect(autoGranted).toEqual(['read:reports']);
    expect(optIn).toEqual([]);
  });
});

describe('buildGrantedScopes', () => {
  const autoGranted = ['read:reports', 'write:journals'];
  const optIn = ['write:post'];

  it('excludes write:post when NOT explicitly ticked (default)', () => {
    expect(buildGrantedScopes(autoGranted, optIn, {})).toEqual(autoGranted);
    expect(buildGrantedScopes(autoGranted, optIn, { 'write:post': false })).toEqual(autoGranted);
  });

  it('includes write:post only when explicitly ticked', () => {
    expect(buildGrantedScopes(autoGranted, optIn, { 'write:post': true })).toEqual([
      'read:reports', 'write:journals', 'write:post',
    ]);
  });

  it('never adds an opt-in scope the client did not request, even if ticked', () => {
    // write:post not in optIn (client never asked) → a stray checked flag is ignored
    expect(buildGrantedScopes(autoGranted, [], { 'write:post': true })).toEqual(autoGranted);
  });
});
