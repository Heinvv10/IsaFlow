/**
 * `create_fixed_asset` — registers a fixed asset on the subledger, over MCP. It POSTS NOTHING.
 *
 * It runs the same create as `POST /api/accounting/assets` (`items/assetCreateService`, extracted from the route so
 * there is one implementation): the INSERT into `assets` and the asset number, and nothing else. No capitalisation
 * journal is written (the cost reaches the ledger through the bill or journal that bought it), no GL account is set
 * on the asset, and the route takes no dimension, bill link or opening accumulated depreciation, so neither does this.
 *
 * Every refusal is answered BEFORE the INSERT, from `parseFixedAssetArgs` (the route's own `validateAsset` plus the
 * column bounds) and from the category read. `planAssetCreate` writes no row. `insertPlannedAsset` is called with no
 * catch: a returned error would release the registry's savepoint and commit a half-made call (contracts/mutation.ts).
 */
import type { McpTool } from '../types';
import { MUTATION_ARG_SCHEMA, type DryRunResult } from '../contracts';
import {
  findSimilarAssets,
  insertPlannedAsset,
  listActiveAssetCategories,
  planAssetCreate,
} from '@/modules/accounting/services/items/assetCreateService';
import { fmtDate } from '@/lib/fmtDate';
import { DEPRECIATION_METHODS, parseFixedAssetArgs } from './fixedAssetArgs';
import { nulArgError, ok, toolError } from './toolHelpers';

const TOOL = 'create_fixed_asset';

const REVERSAL =
  'No MCP tool or app route deletes an asset, and this call posted no journal to reverse. An asset registered in '
  + 'error stays on the register, and run_depreciation will depreciate it and post that charge. Disposing it '
  + '(POST /api/accounting/assets/<asset_id>/dispose, after PATCH .../gl-account sets a cost account) posts a '
  + 'disposal journal against a cost that was never capitalised, so it is not an undo. Ask a person to retire it in '
  + 'the app; dry_run first so it is never needed.';

export const createFixedAssetTool: McpTool = {
  name: TOOL,
  description:
    'Register a fixed asset on the asset register (the subledger): name, category, purchase date, cost, useful life, '
    + 'residual (salvage_value) and depreciation method. Same create as the app\'s New Asset page. '
    + 'IT POSTS NOTHING TO THE GENERAL LEDGER: no capitalisation journal, so no write:post is needed. The cost reaches '
    + 'the ledger through the supplier bill or journal that bought the asset; register the asset here separately. '
    + 'It sets no GL account on the asset (a disposal needs one, set in the app), takes no cost centre / business unit, '
    + 'no supplier bill link and no opening accumulated depreciation: the create path has none of them. '
    + 'category is a fixed asset category code (computers, motor_vehicles, furniture, office_equipment, buildings, '
    + 'machinery, ...); it sets the SARS wear-and-tear rate and the asset number prefix (COMP-0001). useful_life_years '
    + 'is the accounting (IAS 16) life and is required. depreciation_method is straight_line (default), '
    + 'reducing_balance or sum_of_years. purchase_date cannot be in the future. '
    + 'THE REGISTRATION CANNOT BE UNDONE FROM HERE: nothing deletes an asset, and the next run_depreciation depreciates '
    + 'it and posts the charge. ALWAYS CALL IT WITH dry_run: true FIRST: it runs every refusal the live call runs, '
    + 'returns the asset (with the number it would take) and any existing asset with the same name, date and cost, '
    + 'writes nothing and does not consume the idempotency key. dry_run defaults to FALSE: a call without it registers. '
    + 'It refuses an unknown or inactive category, a cost that is not above zero or has more than 2 decimals, a '
    + 'salvage value above the cost, a life or method that is invalid, and a future or impossible date. There is no '
    + 'closed-period refusal: registering an asset touches no ledger period, so an asset bought in a closed year can '
    + 'be registered; depreciation for a closed period is refused by run_depreciation.',
  // write:journals, as run_depreciation: the asset subledger is the ledger-side register that tool depreciates. No
  // requiresPost: nothing here posts.
  scope: 'write:journals',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', maxLength: 200, description: 'Asset name, e.g. "Dell Latitude 5440".' },
      category: { type: 'string', description: 'Fixed asset category code, e.g. computers, motor_vehicles, furniture.' },
      purchase_date: { type: 'string', format: 'date', description: 'YYYY-MM-DD; not in the future.' },
      cost: { type: 'number', description: 'Purchase price in rand, above zero, at most 2 decimals.' },
      useful_life_years: { type: 'number', description: 'Accounting useful life in years, 0.01 to 999.99.' },
      salvage_value: { type: 'number', description: 'Residual value in rand; default 0; not above cost.' },
      depreciation_method: { type: 'string', enum: [...DEPRECIATION_METHODS], description: 'Default straight_line.' },
      description: { type: 'string', maxLength: 1000 },
      serial_number: { type: 'string', maxLength: 100 },
      location: { type: 'string', maxLength: 200 },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['name', 'category', 'purchase_date', 'cost', 'useful_life_years', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const nul = nulArgError(args);
    if (nul) return nul;
    const parsed = parseFixedAssetArgs(args);
    if (!parsed.ok) return toolError(parsed.error);
    const input = parsed.input;

    // ── PRE-WRITE. Nothing below the INSERT is reachable until every refusal has been answered.
    const categories = await listActiveAssetCategories();
    if (!categories.some((c) => c.code === input.category)) {
      return toolError(
        `Unknown fixed asset category "${input.category}". Use one of: ${categories.map((c) => c.code).join(', ')}.`,
      );
    }
    const plan = await planAssetCreate(ctx.companyId, input);
    const possibleDuplicates = await findSimilarAssets(ctx.companyId, input.name, input.purchaseDate, input.cost);
    const asset = {
      asset_number: plan.assetNumber,
      name: input.name,
      category: plan.categoryKey,
      purchase_date: input.purchaseDate,
      cost: input.cost,
      salvage_value: input.salvageValue,
      useful_life_years: input.usefulLifeYears,
      depreciation_method: input.depreciationMethod,
      status: 'available',
      sars_rate: plan.sarsRate,
      tax_useful_life_years: plan.taxLife,
    };

    if (args.dry_run === true) {
      const preview: DryRunResult = {
        dryRun: true, journals: [], skipped: [], effects: [], journalsTotal: 0, truncated: false,
      };
      // wroteNothing frees the idempotency key for the real call.
      return {
        ...ok({
          ...preview,
          asset,
          posts_to_ledger: false,
          possible_duplicates: possibleDuplicates,
          note: 'The asset number is the next free one now; a concurrent registration can take it first.',
        }),
        wroteNothing: true,
      };
    }

    // ── WRITE. No try/catch: only pre-write validation may return toolError.
    const row = await insertPlannedAsset(ctx.companyId, ctx.userId, input, plan);
    return ok({
      asset_id: String(row.id),
      asset_number: String(row.asset_number),
      asset: { ...asset, purchase_date: fmtDate(row.purchase_date) || input.purchaseDate },
      posts_to_ledger: false,
      possible_duplicates: possibleDuplicates,
      reversal: REVERSAL,
    });
  },
};
