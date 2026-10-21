/**
 * The refusal when a PAYG wallet cannot cover an MCP call (registry.ts).
 *
 * A plain statement of what is missing and that nothing happened, with no call
 * to buy anything (FB-6). It reaches the user through whichever AI client
 * relays it, and a marketplace plugin must not carry an upsell (Cursor
 * Marketplace Publisher Terms 3.1). It was "Insufficient Flows: ... Top up to
 * continue." Kept apart from flowMetering.ts so tests that mock the metering
 * module still get the real text.
 */
export function insufficientFlowsText(toolName: string, required: number, balance: number): string {
  return (
    `This company's Flow balance is too low for ${toolName}: it costs ${required} Flows ` +
    `and the balance is ${balance}. Nothing was changed.`
  );
}
