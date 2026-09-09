import {expect,it} from 'vitest';
import {actor,source,bank,pool,statusFixture} from './beneficiaryStatusFixture';
import {readSupplierBankChangeStatus} from '../../../src/modules/accounting/services/controls/beneficiaryStatusService';
import {proposeBeneficiaryChange,verifyBeneficiaryChange,cancelBeneficiaryChange} from '../../../src/modules/accounting/services/controls/beneficiaryService';
it('keeps legacy unverified and returns only masked pending proposal after real proposal creation',async()=>{
 const f=statusFixture(),s=await source(),supplierId=s.ref.entityId;
 expect(await actor(f.u1.id,ctx=>readSupplierBankChangeStatus(ctx,{supplierId}))).toMatchObject({pendingHold:false,currentBank:{verification:'legacy_unverified',accountLast4:'6789'},proposal:null});
 const p=await actor(f.u1.id,ctx=>proposeBeneficiaryChange(ctx,s.ref,bank,[]));
 const result=await actor(f.u1.id,ctx=>readSupplierBankChangeStatus(ctx,{supplierId}));
 expect(result).toMatchObject({pendingHold:true,currentBank:{verification:'legacy_unverified'},proposal:{proposalId:p.proposalId,status:'pending',accountLast4:'4321',requestedByCurrentPerson:true}});
 const text=JSON.stringify(result);for(const secret of [bank.accountNumber,bank.branchCode,f.u1.id,'details_envelope','evidence_refs'])expect(text).not.toContain(secret);
});
it('authenticates actual independently verified banking and identifies later live changes',async()=>{
 const f=statusFixture(),s=await source(),supplierId=s.ref.entityId;
 const p=await actor(f.u1.id,ctx=>proposeBeneficiaryChange(ctx,s.ref,bank,s.evidence));
 await actor(f.u2.id,ctx=>verifyBeneficiaryChange(ctx,p.proposalId,s.evidence));
 expect(await actor(f.u2.id,ctx=>readSupplierBankChangeStatus(ctx,{supplierId}))).toMatchObject({pendingHold:false,currentBank:{verification:'verified',verifiedVersion:1,accountLast4:'4321'},proposal:{status:'verified',requestedByCurrentPerson:false}});
 await pool.query('UPDATE suppliers SET bank_account_number=$3 WHERE company_id=$1 AND id=$2',[f.companyA,supplierId,'99999999999']);
 expect(await actor(f.u1.id,ctx=>readSupplierBankChangeStatus(ctx,{supplierId}))).toMatchObject({currentBank:{verification:'changed_since_verification',accountLast4:'9999'}});
});
it('explicit proposal never falls back to a different supplier or tenant and inactive suppliers refuse',async()=>{
 const f=statusFixture(),s=await source(),other=await source(),foreign=await source(f.companyB);
 const p=await actor(f.u1.id,ctx=>proposeBeneficiaryChange(ctx,other.ref,bank,[]));
 await expect(actor(f.u1.id,ctx=>readSupplierBankChangeStatus(ctx,{supplierId:s.ref.entityId,proposalId:p.proposalId}))).rejects.toThrow();
 await expect(actor(f.u1.id,ctx=>readSupplierBankChangeStatus(ctx,{supplierId:foreign.ref.entityId}))).rejects.toThrow();
 await pool.query('UPDATE suppliers SET is_active=false WHERE company_id=$1 AND id=$2',[f.companyA,s.ref.entityId]);
 await expect(actor(f.u1.id,ctx=>readSupplierBankChangeStatus(ctx,{supplierId:s.ref.entityId}))).rejects.toThrow();
});
it('retains cancelled proposal status and refuses authenticated envelope corruption',async()=>{
 const f=statusFixture(),s=await source(),supplierId=s.ref.entityId;
 const p=await actor(f.u1.id,ctx=>proposeBeneficiaryChange(ctx,s.ref,bank,[]));
 await actor(f.u1.id,ctx=>cancelBeneficiaryChange(ctx,p.proposalId,'Synthetic cancellation'));
 expect(await actor(f.u1.id,ctx=>readSupplierBankChangeStatus(ctx,{supplierId,proposalId:p.proposalId}))).toMatchObject({pendingHold:false,proposal:{status:'cancelled'}});
 await pool.query("UPDATE control_beneficiary_proposals SET details_fingerprint=repeat('0',64) WHERE company_id=$1 AND id=$2",[f.companyA,p.proposalId]);
 await expect(actor(f.u1.id,ctx=>readSupplierBankChangeStatus(ctx,{supplierId}))).rejects.toThrow();
});
