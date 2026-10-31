import { describe, expect, it } from 'vitest';

import { mcpRegistry } from '@/lib/mcp/toolIndex';

describe('MCP tool annotations', () => {
  it('annotates every registered tool consistently with its write metadata', () => {
    const manifestByName = new Map(
      mcpRegistry.getManifest().map((tool) => [tool.name, tool]),
    );

    for (const tool of mcpRegistry.listTools()) {
      const annotations = manifestByName.get(tool.name)?.annotations;

      expect(annotations, tool.name).toBeDefined();
      expect(Object.keys(annotations!).sort(), tool.name).toEqual([
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
        'readOnlyHint',
      ]);
      expect(annotations!.readOnlyHint, tool.name).toBe(!tool.write);
      expect(annotations!.idempotentHint, tool.name).toBe(true);
      expect(annotations!.openWorldHint, tool.name).toBe(false);

      if (!tool.write) expect(annotations!.destructiveHint, tool.name).toBe(false);
      if (tool.requiresPost) expect(annotations!.destructiveHint, tool.name).toBe(true);
    }
  });

  it('distinguishes destructive state changes from additive non-posting writes', () => {
    const byName = new Map(mcpRegistry.getManifest().map((tool) => [tool.name, tool]));

    const destructive = [
      'deactivate_gl_account',
      'delete_cost_centre',
      'delete_business_unit',
      'undo_bank_import',
      'cancel_bank_reconciliation',
      'end_employee_component',
      'lock_vat_period',
      'disable_bank_rule',
      'create_bank_rule',
      'update_bank_rule',
      'update_customer',
      'update_gl_account',
    ];
    const additive = [
      'create_draft_invoice',
      'create_customer',
      'log_time_entry',
      'suggest_bank_allocation',
      'attach_document',
    ];

    for (const name of destructive) {
      expect(byName.get(name)?.annotations.destructiveHint, name).toBe(true);
    }
    for (const name of additive) {
      expect(byName.get(name)?.annotations.destructiveHint, name).toBe(false);
    }
  });
});
