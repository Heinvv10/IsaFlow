import {z} from 'zod';
const id=z.string().uuid().transform(value=>value.toLowerCase());
const requestFields={version:z.literal(1),kind:z.literal('transfer'),bankTransactionId:id,counterpartyAccountId:id,description:z.string().max(1000).optional()};
const request=z.object(requestFields).strict();
/** Only shared preparation may select a matching row or an existing original. */
export function parseBankTransferRequest(input:unknown){return request.parse(input);}
export const bankTransferPlanSchema=z.object({...requestFields,transfer:z.discriminatedUnion('mode',[
 z.object({mode:z.literal('post'),oppositeBankTransactionId:id.nullable()}).strict(),
 z.object({mode:z.literal('link'),originalIntentId:id}).strict(),
])}).strict();
export type BankTransferPlan=z.infer<typeof bankTransferPlanSchema>;
export type BankTransferRequest=z.infer<typeof request>;
