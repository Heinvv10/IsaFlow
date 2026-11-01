/**
 * The first check on a batch's payees, ahead of the bank-verification gate and the file's validation. A member naming
 * another company's supplier reads back with no supplier row (`s.id` NULL: the join is scoped to the batch's company),
 * so both of those would answer about bank details: missing, or unverified. Neither can be fixed from here, because the
 * supplier is not this company's, and the second would name the foreign id as the supplier. The file is refused whole
 * either way; this says what is actually wrong, from the payment's own number alone.
 */

interface BatchMember {
  /** `s.id` of the scoped join. */
  payee_id?: unknown;
  payment_number?: unknown;
}

/** One message per member whose supplier is not in this company ("Payment 2 (SP-1): ..."), position as in the file. */
export function payeesNotInCompany(members: readonly BatchMember[]): string[] {
  const errors: string[] = [];
  members.forEach((member, i) => {
    if (member.payee_id != null) return;
    const number = member.payment_number == null || member.payment_number === '' ? '' : ` (${String(member.payment_number)})`;
    errors.push(`Payment ${i + 1}${number}: names a supplier that is not in this company, `
      + 'so the batch was not sent. Correct the payment; editing bank details will not fix this.');
  });
  return errors;
}
