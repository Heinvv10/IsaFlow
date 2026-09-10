import {expect,it} from 'vitest';
import {parseAccessReviewInput,accessReviewCursor} from '@/modules/accounting/services/controls/accessControlReviewInput';
const company='11111111-1111-4111-8111-111111111111';
it('bounds kinds, page sizes and dormancy without caller authority fields',()=>{
 expect(parseAccessReviewInput({kind:'pat'},company)).toMatchObject({kind:'pat',limit:20,dormantDays:90,after:null});
 for(const input of [{kind:'unknown'},{kind:'pat',limit:101},{kind:'pat',company_id:company},{kind:'pat',dormantDays:0}])expect(()=>parseAccessReviewInput(input,company)).toThrow();
});
it('binds continuation to tenant, kind and filter without treating cursor as authority',()=>{
 const cursor=accessReviewCursor(company,'pat',90,'last-id');
 expect(parseAccessReviewInput({kind:'pat',cursor},company).after).toBe('last-id');
 expect(()=>parseAccessReviewInput({kind:'oauth',cursor},company)).toThrow();
 expect(()=>parseAccessReviewInput({kind:'pat',cursor,dormantDays:10},company)).toThrow();
 expect(()=>parseAccessReviewInput({kind:'pat',cursor},'22222222-2222-4222-8222-222222222222')).toThrow();
 for(const invalid of [cursor+'!',Buffer.from('{}').toString('base64url'),'x'.repeat(2001)])expect(()=>parseAccessReviewInput({kind:'pat',cursor:invalid},company)).toThrow();
});
it('never reads untrusted accessors',()=>{
 let calls=0;expect(()=>parseAccessReviewInput({get kind(){calls++;return 'pat';}},company)).toThrow();expect(calls).toBe(0);
});
