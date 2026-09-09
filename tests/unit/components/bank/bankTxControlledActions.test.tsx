import {beforeEach,expect,it,vi} from 'vitest';
import {buildBankTxActions} from '@/components/accounting/bank-transactions/useBankTxActions';
const mocked=vi.hoisted(()=>({fetch:vi.fn(),success:vi.fn(),error:vi.fn()}));
vi.mock('@/lib/apiFetch',()=>({apiFetch:mocked.fetch}));vi.mock('@/utils/toast',()=>({notify:{success:mocked.success,error:mocked.error}}));
vi.mock('@/components/accounting/CreateRuleModal',()=>({extractPattern:()=>''}));
beforeEach(()=>{vi.resetAllMocks();mocked.fetch.mockResolvedValue({ok:true,json:async()=>({success:true,data:{}})});});
function setup(){
 const openBankControl=vi.fn().mockResolvedValue('pending'),setSelectedIds=vi.fn(),loadTransactions=vi.fn();
 const deps={transactions:[],glAccounts:[],selectedBank:'',selectedIds:new Set(['bank']),rowSelections:{bank:{type:'customer' as const,entityId:'customer',label:'Customer',vatCode:'none' as const}},batchType:'customer' as const,excludingTxId:null,createEntityTxId:null,
  setSmartRunning:vi.fn(),setRowSelections:vi.fn(),setTransactions:vi.fn(),setSelectedIds,setShowBatchEdit:vi.fn(),setRulePrompt:vi.fn(),setExcludingTxId:vi.fn(),loadTransactions,refreshBankAccounts:vi.fn(),openBankControl};
 return{actions:buildBankTxActions(deps),openBankControl,setSelectedIds,loadTransactions};
}
it('accept opens approval workflow and never reports a pending item as allocated',async()=>{
 const s=setup();await s.actions.handleAccept('bank');
 expect(s.openBankControl).toHaveBeenCalledWith({bankTransactionId:'bank',mode:'allocate',preparation:{action:'prepare_allocate',bankTransactionId:'bank',allocationType:'customer',entityId:'customer'}});
 expect(mocked.fetch).not.toHaveBeenCalled();expect(mocked.success).not.toHaveBeenCalled();
});
it('batch keeps pending selected rows and does not emit a zero-allocated success',async()=>{
 const s=setup();await s.actions.handleBatchAccept();expect(s.openBankControl).toHaveBeenCalledTimes(1);
 expect(s.setSelectedIds).not.toHaveBeenCalled();expect(mocked.success).not.toHaveBeenCalled();
});
it('reverse opens explicit date/reason and controlled original selection rather than raw execution',async()=>{
 const s=setup();Object.defineProperty(window,'confirm',{value:vi.fn(()=>true),configurable:true});await s.actions.handleReverse('bank');
 expect(s.openBankControl).toHaveBeenCalledWith({bankTransactionId:'bank',mode:'reverse'});expect(mocked.fetch).not.toHaveBeenCalled();
});
