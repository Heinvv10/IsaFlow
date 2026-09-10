import {expect,it} from 'vitest';
import {historyDomain,HISTORY_ENTITY_TYPES} from '@/modules/accounting/services/controls/controlChangeHistoryPolicy';
import {forensicHistoryTools} from '@/lib/mcp/tools/forensicHistory';
it('declares the separate complete default settings family in shared policy and discovery',()=>{
 expect(historyDomain('accounting_default_accounts')).toBe('read:reports');
 expect(HISTORY_ENTITY_TYPES).toContain('accounting_default_accounts');
 expect(forensicHistoryTools[0].inputSchema).toMatchObject({properties:{entity_type:{enum:expect.arrayContaining(['accounting_default_accounts'])}}});
});
