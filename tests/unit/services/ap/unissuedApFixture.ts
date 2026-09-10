import {expect,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {als} from '@/lib/als';
export const apIdentity={company:'11111111-1111-4111-8111-111111111111',person:'22222222-2222-4222-8222-222222222222',id:'33333333-3333-4333-8333-333333333333'};
/** Negative authority only. This deliberately unissued store can never grant a financial capability. */
export async function expectUnissuedApRefusal(action:()=>Promise<unknown>){
 await expect(action()).rejects.toThrow('Authenticated control transaction required');
 const query=vi.fn();
 await als.run({client:{query} as unknown as PoolClient,userId:apIdentity.person,companyId:apIdentity.company,claims:{},controlPrincipal:{
  personId:apIdentity.person,companyId:apIdentity.company,authMethod:'cookie',connectionId:null,grantId:null,actingFirmId:null,delegatedByPersonId:null,
  requestId:apIdentity.id,operationId:apIdentity.id,provenance:'human',grantedScopes:null,
 }},async()=>{await expect(action()).rejects.toThrow('Authenticated control transaction required');});
 expect(query).not.toHaveBeenCalled();
}
