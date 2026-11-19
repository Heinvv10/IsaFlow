/**
 * The item-master tools (Phase A), grouped so toolIndex.ts and flowMetering.ts each register them in one line rather
 * than growing past their size cap.
 */
import { getItemTool, listItemCategoriesTool, listItemsTool } from './itemReadTools';
import { bulkUpsertItemsTool, deactivateItemTool, updateItemTool, upsertItemCategoryTool } from './itemWriteTools';

export const ITEM_READ_TOOLS = [listItemsTool, getItemTool, listItemCategoriesTool] as const;

export const ITEM_WRITE_TOOLS = [bulkUpsertItemsTool, updateItemTool, deactivateItemTool, upsertItemCategoryTool] as const;

/** All free: master data posts nothing, and the app meters neither the items nor the item-categories routes. */
export const ITEM_FLOW_OPERATIONS = {
  list_items: null,
  get_item: null,
  list_item_categories: null,
  bulk_upsert_items: null,
  update_item: null,
  deactivate_item: null,
  upsert_item_category: null,
} as const;
