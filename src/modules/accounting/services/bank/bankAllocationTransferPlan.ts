import {z} from 'zod';
import {feedStateOf} from './bankFeedStateGuard';
const id=z.string().uuid().transform(value=>value.toLowerCase());
/**
 * The opposite leg of a controlled transfer, chosen from the ordered candidate
 * rows — the ONE copy of that choice, shared by preparation and by the
 * saved-plan re-read that has to reproduce it exactly.
 *
 * A leg that is `pending` or `removed` at the bank is SKIPPED, not refused.
 * Master's feed_state fence (25f9d62a9) never reached this family, and a pending
 * feed row carries status 'imported', so it was a live candidate; linking one
 * trips migration 675's guard with a 23514 inside `executeControlledOperation`,
 * which rolls the source leg back too and answers an unmapped 500. Skipping
 * leaves the transfer posted with the opposite leg unlinked — the outcome
 * already defined for when no counterparty row exists yet — because the operator
 * named the counterparty ACCOUNT, never this row, and has no remedy for a leg
 * the bank has not posted.
 */
export function selectOppositeTransferLeg<T extends {feed_state?:unknown}>(candidates:readonly T[]):T|null{
 return candidates.find(row=>feedStateOf(row)==='posted')??null;
}
const requestFields={version:z.literal(1),kind:z.literal('transfer'),bankTransactionId:id,counterpartyAccountId:id,description:z.string().max(1000).optional()};
const request=z.object(requestFields).strict();
/** Only shared preparation may select a matching row or an existing original. */
export function parseBankTransferRequest(input:unknown){
 const parsed=request.parse(input);if(parsed.description===undefined)delete parsed.description;return parsed;
}
export const bankTransferPlanSchema=z.object({...requestFields,transfer:z.discriminatedUnion('mode',[
 z.object({mode:z.literal('post'),oppositeBankTransactionId:id.nullable()}).strict(),
 z.object({mode:z.literal('link'),originalIntentId:id}).strict(),
])}).strict();
export type BankTransferPlan=z.infer<typeof bankTransferPlanSchema>;
export type BankTransferRequest=z.infer<typeof request>;
