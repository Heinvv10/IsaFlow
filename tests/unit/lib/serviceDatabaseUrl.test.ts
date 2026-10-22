import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { serviceDatabaseUrl } from '@/lib/serviceDatabaseUrl';

// S-07b: the service pools use SERVICE_DATABASE_URL, and DATABASE_URL only
// until the env names it.
let saved: NodeJS.ProcessEnv;
beforeEach(() => { saved = { ...process.env }; });
afterEach(() => { process.env = saved; });

describe('serviceDatabaseUrl', () => {
  it('prefers SERVICE_DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgresql://isaflow_app@h/isaflow';
    process.env.SERVICE_DATABASE_URL = 'postgresql://isaflow_service@h/isaflow';
    expect(serviceDatabaseUrl()).toBe('postgresql://isaflow_service@h/isaflow');
  });

  it('falls back to DATABASE_URL while SERVICE_DATABASE_URL is unset or empty', () => {
    process.env.DATABASE_URL = 'postgresql://postgres@h/isaflow';
    delete process.env.SERVICE_DATABASE_URL;
    expect(serviceDatabaseUrl()).toBe('postgresql://postgres@h/isaflow');
    process.env.SERVICE_DATABASE_URL = '';
    expect(serviceDatabaseUrl()).toBe('postgresql://postgres@h/isaflow');
  });

  it('throws when neither is set', () => {
    delete process.env.DATABASE_URL;
    delete process.env.SERVICE_DATABASE_URL;
    expect(() => serviceDatabaseUrl()).toThrow(/DATABASE_URL is not set/);
  });
});
