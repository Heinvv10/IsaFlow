import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ENTITY_TYPE_CODES, ENTITY_TYPES, DEFAULT_ENTITY_TYPE, afsTemplateFor, entityTypeLabel,
  getEntityType, isEntityTypeCode,
} from '@/lib/entityTypes';

describe('entityTypes: the one SA entity list (Hein, 2026-10-16)', () => {
  it('pins the eight codes and their labels, in order', () => {
    expect(ENTITY_TYPES.map(t => [t.code, t.label])).toEqual([
      ['sole_proprietor', 'Sole proprietor'],
      ['partnership', 'Partnership'],
      ['pty_ltd', 'Private company (Pty) Ltd'],
      ['ltd', 'Public company (Ltd)'],
      ['cc', 'Close corporation (CC)'],
      ['npc', 'Non-profit company (NPC)'],
      ['trust', 'Trust'],
      ['other', 'Other'],
    ]);
    expect(ENTITY_TYPES.map(t => t.code)).toEqual([...ENTITY_TYPE_CODES]);
    expect(DEFAULT_ENTITY_TYPE).toBe('pty_ltd');
  });

  it('pins the one required proof and the people role per entity (§2a.2)', () => {
    const proof = Object.fromEntries(ENTITY_TYPES.map(t => [t.code, t.requiredProof.kind === 'document'
      ? t.requiredProof.documentType
      : t.requiredProof.kind === 'person_ids' ? `ids>=${t.requiredProof.minPeople}` : 'none']));
    expect(proof).toEqual({
      sole_proprietor: 'ids>=1', partnership: 'ids>=2',
      pty_ltd: 'cipc_certificate', ltd: 'cipc_certificate', npc: 'cipc_certificate',
      cc: 'ck_certificate', trust: 'letters_of_authority', other: 'none',
    });
    expect(Object.fromEntries(ENTITY_TYPES.map(t => [t.code, t.personRole]))).toEqual({
      sole_proprietor: 'Owner', partnership: 'Partner', pty_ltd: 'Director', ltd: 'Director',
      cc: 'Member', npc: 'Director', trust: 'Trustee', other: 'Representative',
    });
    expect(getEntityType('sole_proprietor').maxPeople).toBe(1);
    expect(getEntityType('sole_proprietor').registration).toBeNull();
  });

  it('maps every entity to its AFS template, with the pty fallback AFS always had', () => {
    expect(ENTITY_TYPE_CODES.map(c => afsTemplateFor(c))).toEqual(
      ['pty', 'pty', 'pty', 'pty', 'cc', 'pty', 'trust', 'pty']);
    expect(getEntityType('sole_proprietor').afsTemplate).toBeNull();
    expect(afsTemplateFor(null)).toBe('pty');
    expect(afsTemplateFor('nonsense')).toBe('pty');
  });

  it('validates codes and labels unknown values as-is', () => {
    expect(isEntityTypeCode('pty_ltd')).toBe(true);
    expect(isEntityTypeCode('pty')).toBe(false);
    expect(isEntityTypeCode('company')).toBe(false);
    expect(entityTypeLabel('cc')).toBe('Close corporation (CC)');
    expect(entityTypeLabel('weird')).toBe('weird');
    expect(() => getEntityType('nope' as never)).toThrow(/Unknown entity type/);
  });

  it('migration 894 CHECK names exactly the same eight codes', () => {
    const sqlText = readFileSync('scripts/migrations/sql/894_company_entity_type_sa_codes.sql', 'utf8');
    const check = /ADD CONSTRAINT companies_entity_type_check CHECK \(entity_type IN \(([^)]*)\)\)/.exec(sqlText);
    expect(check).not.toBeNull();
    const codes = (check?.[1] ?? '').split(',').map(s => s.trim().replace(/'/g, ''));
    expect(codes).toEqual([...ENTITY_TYPE_CODES]);
    expect(sqlText).toMatch(/SET DEFAULT 'pty_ltd'/);
  });
});
