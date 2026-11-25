/**
 * The card verification charge Paystack takes when a mandate is authorised
 * (mandateCheckout.ts initialises a transaction for this amount). It is not
 * refunded. Kept in its own module, free of server imports, so the upgrade
 * page can state the same figure the checkout charges.
 */

// Small enough to be cheap, large enough to actually authorise the card.
// 100 cents. It is visible on the cardholder's statement.
export const AUTH_VERIFICATION_CENTS = 100;
