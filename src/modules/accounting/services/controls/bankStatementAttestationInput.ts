import {z} from 'zod';
import {canonicalMoney} from './canonical';
import {isRealCalendarDate} from '@/lib/validation';
const amount=z.string().regex(/^-?\d{1,16}(\.\d{1,2})?$/).transform(canonicalMoney);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealCalendarDate);
const schema=z.object({bankAccountId:z.string().uuid(),sourceDocumentId:z.string().uuid(),expectedSourceHash:z.string().regex(/^[a-f0-9]{64}$/),
 periodStart:date,periodEnd:date,sourceCount:z.number().int().min(0).max(2147483647),openingBalance:amount,closingBalance:amount,
 currency:z.string().regex(/^[A-Z]{3}$/)}).strict();
/** Source assertions remain unverified until the separate immutable intent and independent approval workflow. */
export function parseBankStatementAttestation(input:unknown){
 const parsed=schema.parse(input);if(parsed.periodStart>parsed.periodEnd)throw new Error('Statement period is reversed');return parsed;
}
