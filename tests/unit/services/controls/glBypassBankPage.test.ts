// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
vi.mock('@/components/layout/AppLayout',()=>({AppLayout:({children}:{children:ReactNode})=>children}));
import BankTransfersPage from '../../../../pages/accounting/bank-transfers';

// The wire shapes the routes actually send. The chart-of-accounts list is `data: GLAccount[]` in camelCase;
// an earlier stub here answered `{data:{accounts:[{account_name}]}}` — the page's guess — and so never saw
// that every real dropdown was empty.
const envelope=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const ACCOUNTS={success:true,data:[{id:'a',accountCode:'1000',accountName:'Main Cheque',accountSubtype:'bank'},{id:'b',accountCode:'1010',accountName:'Savings',accountSubtype:'bank'}]};
function serve(prepare:Response){
 const fetch=vi.fn(async(url:string)=>url.startsWith('/api/accounting/chart-of-accounts')?envelope(200,ACCOUNTS):prepare);
 vi.stubGlobal('fetch',fetch);return fetch;
}
async function prepareTransfer(){
 render(createElement(BankTransfersPage));
 await screen.findAllByRole('option',{name:'1000 — Main Cheque'});
 fireEvent.change(screen.getAllByRole('combobox')[0]!,{target:{value:'a'}});
 fireEvent.change(screen.getAllByRole('combobox')[1]!,{target:{value:'b'}});
 fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'100.01'}});
 fireEvent.click(screen.getByRole('button',{name:/(Process|Prepare) Transfer/i}));
}
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it('lists the company\'s bank accounts in both dropdowns',async()=>{
 serve(envelope(200,{success:true,data:null}));
 render(createElement(BankTransfersPage));
 const [from,to]=await waitFor(()=>{const boxes=screen.getAllByRole('combobox');expect(boxes).toHaveLength(2);return boxes;});
 for(const box of [from!,to!]){
  await waitFor(()=>expect([...(box as HTMLSelectElement).options].map(o=>o.textContent)).toEqual(expect.arrayContaining(['1000 — Main Cheque','1010 — Savings'])));
 }
});

it('keeps preparation truthful and sends the exact decimal string',async()=>{
 const fetch=serve(envelope(200,{success:true,data:{intentId:'intent',status:'approval_required',requiresApproval:true,amount:'100.01',currency:'ZAR',accountingDate:'2026-02-28'}}));
 await prepareTransfer();
 await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));
 expect(JSON.parse(String((fetch.mock.calls[1] as unknown as [string,RequestInit])[1].body)).amount).toBe('100.01');
 expect(await screen.findByText(/prepared.*approval required/i)).toBeTruthy();
 expect(screen.queryByText(/Transfer completed/)).toBeNull();
});

it('shows the route\'s refusal when a transfer cannot be prepared',async()=>{
 const reason='Cannot transfer between these bank accounts: 1000 Main Cheque has no currency set. Both must have the ledger currency (ZAR).';
 serve(envelope(422,{success:false,error:{code:'BUSINESS_RULE_VIOLATION',message:reason}}));
 await prepareTransfer();
 expect(await screen.findByText(reason)).toBeTruthy();
});
