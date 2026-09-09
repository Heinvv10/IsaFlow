import {afterAll,beforeAll} from 'vitest';
import {capturedEvidenceHttpFixture} from './capturedEvidenceHttpFixture';
let storage:Awaited<ReturnType<typeof capturedEvidenceHttpFixture>>|undefined;
/** One actual local object server per importing test suite; no external storage. */
beforeAll(async()=>{storage=await capturedEvidenceHttpFixture();});
afterAll(async()=>{if(storage)await storage.close();storage=undefined;});
export function capturedStorage(){
 if(!storage)throw new Error('Synthetic captured storage is not initialized');
 return storage;
}
