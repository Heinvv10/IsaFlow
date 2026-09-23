/**
 * What the consent screen says about where an authorisation code would go
 * (src/lib/auth/consentRedirectTarget.ts).
 *
 * The property under test is honesty: a hosted redirect yields a fact the
 * reader can check, and a loopback redirect must NOT yield one, because the
 * legitimate client and a hostile one are indistinguishable there.
 */
import { describe, it, expect } from 'vitest';
import { describeRedirectTarget } from '@/lib/auth/consentRedirectTarget';

describe('describeRedirectTarget', () => {
  it('reports the host for a hosted client', () => {
    expect(describeRedirectTarget('https://claude.ai/api/mcp/auth_callback')).toEqual({
      kind: 'web',
      host: 'claude.ai',
    });
    expect(describeRedirectTarget('https://evil.example/cb')).toEqual({
      kind: 'web',
      host: 'evil.example',
    });
  });

  // A non-default port is part of what a reader would have to check, so it
  // stays — unlike the loopback case, where the port is noise.
  it('keeps a non-default port on a hosted host', () => {
    expect(describeRedirectTarget('https://apps.example:8443/cb')).toEqual({
      kind: 'web',
      host: 'apps.example:8443',
    });
  });

  // Every RFC 8252 loopback form registration accepts. None may surface a host
  // or port: "localhost:57526" names nobody, and Claude Code and an impostor
  // look the same there.
  it('reports only the category for a client on the reader\'s machine', () => {
    for (const uri of [
      'http://localhost:57526/callback',
      'http://localhost:1/callback',
      'http://127.0.0.1:65393/callback',
      'http://[::1]:8080/callback',
    ]) {
      expect(describeRedirectTarget(uri), uri).toEqual({ kind: 'local' });
    }
  });

  // Registration refuses these, so they cannot come from a registered app.
  // Saying nothing is the safe rendering.
  it('says nothing for anything else', () => {
    for (const uri of [
      'http://evil.example/cb', // plain http, non-loopback
      'ftp://example.com/cb',
      'javascript:alert(1)',
      'not a url',
      '',
    ]) {
      expect(describeRedirectTarget(uri), JSON.stringify(uri)).toEqual({ kind: 'unknown' });
    }
  });

  // The whole point is that these two never render the same way.
  it('never describes a loopback client the way it describes a hosted one', () => {
    const local = describeRedirectTarget('http://localhost:57526/callback');
    const hosted = describeRedirectTarget('https://claude.ai/cb');
    expect(local).not.toEqual(hosted);
    expect(JSON.stringify(local)).not.toContain('57526');
    expect(JSON.stringify(local)).not.toContain('localhost');
  });
});
