import {expect,it} from 'vitest';
import {parsePaymentReleaseAction} from '@/modules/accounting/services/ap/paymentReleaseAction';
const id='11111111-1111-4111-8111-111111111111';
it('refuses raw bank payloads and implicit release',()=>{
 expect(()=>parsePaymentReleaseAction('netcash',{payments:[]})).toThrow();
 expect(()=>parsePaymentReleaseAction('netcash',{action:'release',intentId:id,approvalId:id,payments:[]})).toThrow();
});
it('requires explicit valid channel-specific preparation',()=>{
 expect(parsePaymentReleaseAction('eft',{action:'prepare',batchId:id,bank:'fnb'})).toEqual({action:'prepare',batchId:id,bank:'fnb'});
 expect(()=>parsePaymentReleaseAction('netcash',{action:'prepare',batchPaymentId:id,bank:'fnb'})).toThrow();
});
it('requires approval for release and allows download only on EFT',()=>{
 expect(()=>parsePaymentReleaseAction('eft',{action:'release',intentId:id})).toThrow();
 expect(parsePaymentReleaseAction('netcash',{action:'release',intentId:id,approvalId:id})).toEqual({action:'release',intentId:id,approvalId:id});
 expect(()=>parsePaymentReleaseAction('netcash',{action:'download',intentId:id})).toThrow();
});
