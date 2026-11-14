/** parseGlAssetAccountId: the ONE parser behind POST /api/accounting/assets (glAssetAccountId) and create_fixed_asset (gl_asset_account_id). */
import { describe, it, expect } from 'vitest';
import { parseGlAssetAccountId } from '@/modules/accounting/services/items/assetService';

const ID = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const REFUSAL = { ok: false, error: 'Fixed-asset cost account must be a UUID or null' };

describe('parseGlAssetAccountId', () => {
  it.each([[undefined], [null]])('%s is "none"', (raw) => {
    expect(parseGlAssetAccountId(raw)).toEqual({ ok: true, id: null });
  });

  it('accepts a uuid, trimmed, in either case', () => {
    expect(parseGlAssetAccountId(ID)).toEqual({ ok: true, id: ID });
    expect(parseGlAssetAccountId(`  ${ID}\n`)).toEqual({ ok: true, id: ID });
    expect(parseGlAssetAccountId(ID.toUpperCase())).toEqual({ ok: true, id: ID.toUpperCase() });
  });

  it.each([[''], ['   '], ['nope'], [`${ID}x`], [12345], [{ id: ID }], [[ID]], [true]])('refuses %j with one text', (raw) => {
    expect(parseGlAssetAccountId(raw)).toEqual(REFUSAL);
  });
});
