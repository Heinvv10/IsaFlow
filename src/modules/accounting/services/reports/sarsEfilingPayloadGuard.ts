/**
 * The ISV payload is not yet in SARS's field numbers.
 *
 * `submitVAT201ToSars` still sends the legacy `field1..field11` storage keys,
 * whose meaning differs from the SARS VAT201 the user reviews on screen (field 1
 * there is a VAT-exclusive base; on the form it is VAT-inclusive; field 7 is a
 * remainder, not a SARS field). Sending them under an approval given for the
 * SARS-numbered form would file figures the reviewer never saw. The channel is
 * dark, so the remap to `sarsFields` waits for SARS's real wire spec (W7), and
 * until it ships the submit path refuses.
 *
 * Flip this to true ONLY in the change that sends `sarsFields`.
 */
const ISV_PAYLOAD_MAPPED_TO_SARS_FIELDS = false;

export const ISV_PAYLOAD_UNMAPPED_REASON = 'payload not yet mapped to SARS field numbers';

export function isvPayloadMappedToSarsFields(): boolean {
  return ISV_PAYLOAD_MAPPED_TO_SARS_FIELDS;
}
