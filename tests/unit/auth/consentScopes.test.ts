/** Every OAuth write scope is explicit opt-in; reads stay automatic. */
import { describe, it, expect } from 'vitest';
import {
  OPT_IN_SCOPES,
  isOptInScope,
  partitionRequestedScopes,
  buildGrantedScopes,
  checkedRequestedOptIns,
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
  it('classifies every write scope in the OAuth vocabulary as opt-in', () => {
    const writeScopes = OAUTH_SCOPES.filter((scope) => scope.startsWith('write:'));
    expect(OPT_IN_SCOPES).toEqual(writeScopes);
    for (const scope of writeScopes) expect(isOptInScope(scope)).toBe(true);
    expect(isOptInScope('read:reports')).toBe(false);
    expect(isOptInScope('offline_access')).toBe(false);
  });
});

describe('partitionRequestedScopes', () => {
  it('splits requested scopes into auto-granted and opt-in', () => {
    const { autoGranted, optIn } = partitionRequestedScopes([
      'read:reports', 'write:journals', 'offline_access', 'write:post',
    ]);
    expect(autoGranted).toEqual(['read:reports', 'offline_access']);
    expect(optIn).toEqual(['write:journals', 'write:post']);
  });

  it('no opt-in scopes requested → empty optIn', () => {
    const { autoGranted, optIn } = partitionRequestedScopes(['read:reports']);
    expect(autoGranted).toEqual(['read:reports']);
    expect(optIn).toEqual([]);
  });
});

describe('buildGrantedScopes', () => {
  const autoGranted = ['read:reports', 'offline_access'];
  const optIn = ['write:journals', 'write:post'];

  it('excludes every unticked write scope by default', () => {
    expect(buildGrantedScopes(autoGranted, optIn, {})).toEqual(autoGranted);
    expect(buildGrantedScopes(autoGranted, optIn, {
      'write:journals': false,
      'write:post': false,
    })).toEqual(autoGranted);
  });

  it('includes only the individually ticked write scopes', () => {
    expect(buildGrantedScopes(autoGranted, optIn, { 'write:journals': true })).toEqual([
      'read:reports', 'offline_access', 'write:journals',
    ]);
  });

  it('never adds an opt-in scope the client did not request, even if ticked', () => {
    expect(buildGrantedScopes(autoGranted, ['write:journals'], {
      'write:journals': true,
      'write:accounts': true,
    })).toEqual([...autoGranted, 'write:journals']);
  });
});

describe('checkedRequestedOptIns', () => {
  it('prechecks only requested writes already granted to this connection', () => {
    expect(checkedRequestedOptIns(
      ['write:journals', 'write:accounts'],
      ['read:reports', 'write:journals', 'write:post'],
    )).toEqual({ 'write:journals': true, 'write:accounts': false });
  });
});
