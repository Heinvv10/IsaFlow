import {expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {als} from '@/lib/als';
import {withPlatformImportRequest} from '@/lib/auth/platformImportAuthority';
import {withControlRequest} from '@/modules/accounting/services/controls/context';
import {assertIndependentRequestReview} from '@/modules/accounting/services/controls/independentReview';

const client={query:vi.fn().mockResolvedValue({rows:[]})} as unknown as PoolClient;
const companyId='11111111-1111-4111-8111-111111111111';

/**
 * The gate's polarity. Inside a request context the answer must default to NO: a new
 * auth path, a middleware ordering change or any bug that leaves controlPrincipal unset
 * has to fail visibly instead of quietly approving.
 */
it('allows a caller with no request context at all: a script, not a browser session',()=>{
 expect(als.getStore()).toBeUndefined();
 expect(assertIndependentRequestReview('requester')).toBeUndefined();
});

it('refuses an unrecognised principal-less request context',async()=>{
 await als.run({client,userId:'someone',companyId,claims:{}},async()=>{
  expect(()=>assertIndependentRequestReview('requester'))
   .toThrow('This request context cannot record an independent review');
 });
});

it('refuses a verified platform-admin request context by name',async()=>{
 await withPlatformImportRequest({client,userId:'platform-admin',claims:{sub:'platform-admin'}},async()=>{
  expect(()=>assertIndependentRequestReview('requester'))
   .toThrow('A platform administrator is not an independent reviewer');
 });
});

it('still lets an ordinary tenant principal through and still refuses an impersonated one',async()=>{
 await withControlRequest({client,userId:'reviewer',companyId,claims:{}},
  {personId:'reviewer',companyId,authMethod:'cookie'},
  async()=>{expect(assertIndependentRequestReview('requester')).toBeUndefined();});
 await withControlRequest({client,userId:'reviewer',companyId,claims:{}},
  {personId:'reviewer',companyId,authMethod:'cookie',impersonatorPersonId:'platform-admin'},
  async()=>{expect(()=>assertIndependentRequestReview('requester'))
   .toThrow('An impersonated session cannot record an independent review');});
});
