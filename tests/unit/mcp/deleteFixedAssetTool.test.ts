/**
 * delete_fixed_asset: the undo for create_fixed_asset, only while the asset has no footprint. Pinned: the asset is
 * looked up (and locked) for the TOKEN company, every blocker refuses before the DELETE with all reasons named, the
 * dry run takes the same path and writes nothing, the DELETE has no catch. The lock and census against Postgres are
 * in tests/integration/delete-fixed-asset.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/items/assetDeleteService', () => ({
  lockAndInspectAsset: vi.fn(),
  deleteLockedAsset: vi.fn(),
}));

import { deleteLockedAsset, lockAndInspectAsset } from '@/modules/accounting/services/items/assetDeleteService';
import { deleteFixedAssetTool } from '@/lib/mcp/tools/writeDeleteFixedAsset';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import { flowOperationFor } from '@/lib/mcp/flowMetering';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const ASSET = 'a1a1a1a1-0000-4000-8000-000000000001';
const ctx = { companyId: COMPANY, userId: 'u-1', tokenJti: 'jti' } as unknown as McpToolContext;
const KEY = { idempotency_key: 'k-1' };
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;
const clear = { assetId: ASSET, assetNumber: 'COMP-0004', name: 'Laptop', status: 'available', blockers: [] };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(lockAndInspectAsset).mockResolvedValue(clear);
});

describe('delete_fixed_asset', () => {
  it('is write:journals, a write tool, not requiresPost, registered and free', () => {
    expect(deleteFixedAssetTool.scope).toBe('write:journals');
    expect(deleteFixedAssetTool.write).toBe(true);
    expect(deleteFixedAssetTool.requiresPost).toBeUndefined();
    expect(MCP_TOOLS.some((t) => t.name === 'delete_fixed_asset')).toBe(true);
    expect(CLIENT_MCP_TOOL_NAMES).toContain('delete_fixed_asset');
    expect(flowOperationFor('delete_fixed_asset')).toBeNull();
  });

  it('refuses a missing or non-uuid asset_id before any read', async () => {
    expect(text(await deleteFixedAssetTool.handler({ ...KEY }, ctx))).toBe('asset_id is required');
    expect((await deleteFixedAssetTool.handler({ asset_id: 'x', ...KEY }, ctx)).isError).toBe(true);
    expect(lockAndInspectAsset).not.toHaveBeenCalled();
  });

  it('looks the asset up for the token company and deletes that one', async () => {
    const r = await deleteFixedAssetTool.handler({ asset_id: ASSET, ...KEY }, ctx);
    expect(lockAndInspectAsset).toHaveBeenCalledWith(COMPANY, ASSET);
    expect(deleteLockedAsset).toHaveBeenCalledWith(COMPANY, ASSET);
    expect(JSON.parse(text(r))).toMatchObject({ deleted: true, asset_id: ASSET, asset_number: 'COMP-0004' });
    expect(r.wroteNothing).toBeUndefined();
  });

  it('an asset that is not this company\'s reads as Not found and deletes nothing', async () => {
    vi.mocked(lockAndInspectAsset).mockResolvedValue(null);
    const r = await deleteFixedAssetTool.handler({ asset_id: ASSET, ...KEY }, ctx);
    expect(text(r)).toBe('Not found');
    expect(r.isError).toBe(true);
    expect(deleteLockedAsset).not.toHaveBeenCalled();
  });

  it('refuses with every reason, says to dispose, and deletes nothing', async () => {
    vi.mocked(lockAndInspectAsset).mockResolvedValue({
      ...clear,
      blockers: [
        { code: 'depreciated', detail: 'depreciation has been recorded against it' },
        { code: 'bank_linked', detail: 'a bank transaction is linked to it' },
      ],
    });
    for (const dry of [false, true]) {
      const r = await deleteFixedAssetTool.handler({ asset_id: ASSET, ...KEY, ...(dry ? { dry_run: true } : {}) }, ctx);
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('COMP-0004 cannot be deleted: depreciation has been recorded against it; a bank transaction is linked to it');
      expect(text(r)).toMatch(/Dispose of it in the app/);
    }
    expect(deleteLockedAsset).not.toHaveBeenCalled();
  });

  it('the dry run locks and checks like the live call, deletes nothing and frees the key', async () => {
    const r = await deleteFixedAssetTool.handler({ asset_id: ASSET, ...KEY, dry_run: true }, ctx);
    expect(lockAndInspectAsset).toHaveBeenCalledWith(COMPANY, ASSET);
    expect(deleteLockedAsset).not.toHaveBeenCalled();
    expect(r.wroteNothing).toBe(true);
    expect(JSON.parse(text(r))).toMatchObject({ dryRun: true, journals: [], would_delete: { asset_number: 'COMP-0004' } });
  });

  it('lets a DELETE failure propagate (a returned error would commit the savepoint)', async () => {
    vi.mocked(deleteLockedAsset).mockRejectedValue(new Error('boom'));
    await expect(deleteFixedAssetTool.handler({ asset_id: ASSET, ...KEY }, ctx)).rejects.toThrow('boom');
  });
});
