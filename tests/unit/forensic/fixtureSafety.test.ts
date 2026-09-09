import { describe, expect, it } from 'vitest';
import { createFixtureIdentity, provisionForensicFixture, validateFixtureTarget } from '../../integration/forensic-fixture';

import { fixtureConfigFromEnv } from '../../../scripts/forensic/fixture-bootstrap';

const safe = {
  optIn: '1',
  databaseUrl: 'postgresql://postgres@127.0.0.1:33149/isaflow_schema_fixture',
};

describe('forensic fixture target fence', () => {
  it('accepts the dedicated programme fixture only after explicit opt-in', () => {
    expect(validateFixtureTarget(safe).port).toBe(33149);
    expect(() => validateFixtureTarget({ ...safe, optIn: undefined })).toThrow();
  });
  it.each([
    'postgresql://postgres@db.example.com:33149/isaflow_schema_fixture',
    'postgresql://postgres@127.0.0.1:5432/isaflow_schema_fixture',
    'postgresql://postgres@127.0.0.1:33149/isaflow',
    'postgresql://postgres@localhost/isaflow_schema_fixture',
    'https://localhost:33149/isaflow_schema_fixture',
    'postgresql://postgres@127.0.0.1:33149/isaflow_schema_fixture?host=production',
    'postgresql://postgres@127.0.0.1:33149/isaflow_schema_fixture?options=-csearch_path=public',
    'postgresql://postgres@127.0.0.1:33149/isaflow_schema_fixture#ignored',
  ])('rejects unsafe or ambiguous target %s', databaseUrl => {
    expect(() => validateFixtureTarget({ ...safe, databaseUrl })).toThrow();
  });
  it('requires generated port and matching fixture label together', () => {
    const target = { ...safe, databaseUrl: safe.databaseUrl.replace('33149', '33150') };
    expect(() => validateFixtureTarget(target)).toThrow();
    expect(() => validateFixtureTarget({ ...target, generatedPort: '33150' })).toThrow();
    expect(validateFixtureTarget({ ...target, generatedPort: '33150', fixtureLabel: 'isaflow-forensic-33150' }).port).toBe(33150);
    expect(() => validateFixtureTarget({ ...target, generatedPort: '33150', fixtureLabel: 'isaflow-forensic-33151' })).toThrow();
  });
  it('rejects before any database connection for invalid provisioning input', async () => {
    await expect(provisionForensicFixture({ ...safe, optIn: '0' })).rejects.toThrow('opt-in');
  });
  it('never derives a target from ambient production configuration', () => {
    expect(fixtureConfigFromEnv({ DATABASE_URL: 'postgresql://production/isaflow' }).databaseUrl).toBeUndefined();
    expect(() => validateFixtureTarget({ optIn: '1', databaseUrl: undefined })).toThrow();
  });
});

describe('synthetic identities', () => {
  it('creates isolated runs and two distinct tokens for one person', () => {
    const a = createFixtureIdentity();
    const b = createFixtureIdentity();
    expect(a.companyA).not.toBe(b.companyA);
    expect(new Set([a.u1.id, a.u2.id, a.u3.id]).size).toBe(3);
    expect(a.u1.companyId).toBe(a.u2.companyId);
    expect(a.u3.companyId).toBe(a.companyB);
    expect(a.u1.tokens).toHaveLength(2);
    expect(a.u1.tokens[0].raw).not.toBe(a.u1.tokens[1].raw);
    expect(a.u1.tokens[0].raw).toMatch(/^pat_[A-Za-z0-9]{32}$/);
    expect(a.u1.tokens[0].hash).toMatch(/^[a-f0-9]{64}$/);
    expect(a.u1.email).toMatch(/@forensic.invalid$/);
  });
});
