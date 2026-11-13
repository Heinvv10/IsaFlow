/**
 * `delete_fixed_asset` — the undo for `create_fixed_asset`, and ONLY while the asset has no footprint.
 *
 * `assetDeleteService.lockAndInspectAsset` locks the company's asset row FOR UPDATE and lists what refers to it
 * (depreciation rows, a disposal, journals naming it, fleet records, a linked bank line, ...). Any blocker refuses,
 * before the DELETE, and the dry run runs the same lock and the same census, so it cannot pass where the live call
 * refuses. The DELETE is called with no catch: a returned error would release the registry's savepoint and commit.
 */
import type { McpTool } from '../types';
import { MUTATION_ARG_SCHEMA, type DryRunResult } from '../contracts';
import { deleteLockedAsset, lockAndInspectAsset } from '@/modules/accounting/services/items/assetDeleteService';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

export const deleteFixedAssetTool: McpTool = {
  name: 'delete_fixed_asset',
  description:
    'Delete a fixed asset that has no footprint: the undo for create_fixed_asset when the asset was registered in error. '
    + 'It posts nothing. It refuses, naming every reason, when the asset has been depreciated (any subledger or '
    + 'depreciation row, or accumulated depreciation), has a depreciation, disposal or expensing journal, was disposed, '
    + 'written off or expensed as below the capitalisation threshold, has fuel or service records, or has a bank '
    + 'transaction linked to it. An asset that was depreciated or disposed is retired by disposing it in the app, not '
    + 'deleted. The asset row is locked while it is checked, so a depreciation run in flight either finishes first (and '
    + 'the delete then refuses) or finds the asset gone. Deleting is final. Its number may be issued again to the next '
    + 'asset in that category. Run with dry_run first: it takes the same lock, runs the same checks and writes nothing.',
  scope: 'write:journals',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      asset_id: { type: 'string', description: 'The asset to delete: asset_id from create_fixed_asset or list_fixed_assets.' },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['asset_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const assetId = strArg(args, 'asset_id');
    if (!assetId) return toolError('asset_id is required');
    const bad = guardCastableArgs(args, { uuid: ['asset_id'] });
    if (bad) return bad;

    // ── PRE-WRITE: lock, then census.
    const found = await lockAndInspectAsset(ctx.companyId, assetId);
    if (!found) return toolError(NOT_FOUND);
    if (found.blockers.length > 0) {
      return toolError(
        `Asset ${found.assetNumber} cannot be deleted: ${found.blockers.map((b) => b.detail).join('; ')}. `
        + 'Dispose of it in the app instead.',
      );
    }
    const asset = { asset_id: found.assetId, asset_number: found.assetNumber, name: found.name, status: found.status };

    if (args.dry_run === true) {
      const preview: DryRunResult = {
        dryRun: true, journals: [], skipped: [], effects: [], journalsTotal: 0, truncated: false,
      };
      // wroteNothing frees the idempotency key for the real call.
      return { ...ok({ ...preview, would_delete: asset }), wroteNothing: true };
    }

    // ── WRITE. No try/catch: only pre-write validation may return toolError.
    await deleteLockedAsset(ctx.companyId, assetId);
    return ok({ deleted: true, ...asset });
  },
};
