import {render,screen,fireEvent} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import {BankControlDialog} from '@/components/accounting/bank-transactions/BankControlDialog';
import type {BankPreparedOperation} from '@/modules/accounting/services/bank/bankControlReadService';
const op:BankPreparedOperation={intentId:'intent',operation:{entityType:'bank_allocation_intent',entityId:'intent',operation:'bank_allocation.post'},plan:{version:1,kind:'account',bankTransactionId:'bank',lines:[{accountId:'account',amount:'115.23',vatCode:'standard'}]},createdAt:'2026-09-09',accountingDate:'2026-09-09',amount:'115.23',currency:'ZAR',executed:false,requesterIsCurrentPerson:true,approvalVisibility:'visible',approval:{id:'approval',entityId:'intent',entityType:'bank_allocation_intent',operation:'bank_allocation.post',status:'pending',requestedAt:'2026-09-09',expiresAt:'2026-09-10'}};
function fixture(selected:BankPreparedOperation|null=op){return{state:{id:1,bankTransactionId:'bank',mode:'allocate' as const,bank:{bankTransactionId:'bank',bankAmount:'-115.23',currentOriginalIntentId:'original',legacyProvenanceUnavailable:false,prepared:{items:selected?[selected]:[],total:selected?1:0,hasMore:false},selected},selected,requirements:null,busy:false,error:'',preparation:{action:'prepare_allocate'}},open:vi.fn(),close:vi.fn(),refresh:vi.fn(),select:vi.fn(),prepare:vi.fn(),requestApproval:vi.fn(),execute:vi.fn()};}
it('pending review displays exact plan and no posted success or execution action',()=>{
 const workflow=fixture();render(<BankControlDialog workflow={workflow}/>);
 expect(screen.getByText('Awaiting independent approval')).toBeTruthy();expect(screen.getByText('ZAR 115.23')).toBeTruthy();
 expect(screen.queryByRole('button',{name:'Execute approved allocation'})).toBeNull();expect(workflow.execute).not.toHaveBeenCalled();
});
it('approved instruction requires explicit execute click',()=>{
 const workflow=fixture({...op,approval:{...op.approval!,status:'approved'}});render(<BankControlDialog workflow={workflow}/>);
 expect(workflow.execute).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Execute approved allocation'}));expect(workflow.execute).toHaveBeenCalledTimes(1);
});
it('inverse preparation receives human-entered accounting date and reason',()=>{
 const base=fixture(null),workflow={...base,state:{...base.state,mode:'reverse' as const}};render(<BankControlDialog workflow={workflow}/>);
 fireEvent.change(screen.getByLabelText('Reversal date'),{target:{value:'2026-09-10'}});fireEvent.change(screen.getByLabelText('Reason for reversal'),{target:{value:'Duplicate allocation'}});
 fireEvent.click(screen.getByRole('button',{name:'Prepare reversal'}));expect(workflow.prepare).toHaveBeenCalledWith({reversalDate:'2026-09-10',reason:'Duplicate allocation'});
});
