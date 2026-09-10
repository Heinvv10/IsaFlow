import {writeFile} from 'node:fs/promises';
import {transferControlFixture} from './bankTransferControlFixture';
import {prepareBankTransfer,executeBankTransfer} from '@/modules/accounting/services/bank/bankTransferPostingService';
/** Run only from the selected pre-normalization baseline worktree. No retained rows are rewritten. */
const output=process.argv[2];if(!output)throw new Error('Synthetic output path required');
const f=await transferControlFixture();
try{
 const p=await f.actor(()=>prepareBankTransfer(f.f.companyA,f.f.u1.id,{fromAccountId:f.from,toAccountId:f.to,amount:'10',transferDate:'2026-09-09'}));
 const ref={...p.operation,entityId:p.intentId.toUpperCase()};
 if(ref.entityId===p.intentId)throw new Error('Fixture UUID lacks case distinction');
 const approval=await f.approve(ref);
 const result=await f.actor(()=>executeBankTransfer(f.f.companyA,f.f.u1.id,ref.entityId,{approvalId:approval}));
 const effects=(await f.pool.query("SELECT entity_id,result FROM control_operation_effects WHERE company_id=$1 AND entity_type='bank_transfer_intent' AND lower(entity_id)=$2",[f.f.companyA,p.intentId])).rows;
 if(effects.length!==1||effects[0].entity_id!==ref.entityId||result.intentId!==ref.entityId)throw new Error('Baseline uppercase effect was not retained');
 await writeFile(output,JSON.stringify({companyId:f.f.companyA,personId:f.f.u1.id,ref,result,approval,
  keys:{encryption:process.env.ENCRYPTION_KEY,fingerprint:process.env.CONTROL_FINGERPRINT_KEY}}),{mode:0o600});
}finally{await f.close();}
