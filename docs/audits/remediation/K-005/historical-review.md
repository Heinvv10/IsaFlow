# Historical WhatsApp assignments

No production query or migration was run. Migration617 preflight groups trimmed WhatsApp addresses across all rows (including retired ones) and refuses duplicates. Apply only after an authorized ownership review; do not choose a company by insertion order. Preserve original inbox/event identifiers and sender/message metadata when investigating potential prior misrouting. Sender membership alone does not establish invoice legitimacy or prove past disclosure.

For approved number reassignment, prepare exact-ID changes with provider ownership evidence, a preserved historical address/tenant mapping and a rollback snapshot. Test repeat-safe execution and old/new tenant routing in a disposable environment before requesting repair authorization. Never silently free a retired number or move captured documents based solely on current registration order.

First-registration ownership is a separate retained R003 candidate. K005 verifies unique routing, not WABA provisioning authority. The signed-webhook tests use the actual installed SDK with a synthetic signing key; outbound acknowledgement/extraction are local sinks, not real Twilio sends. Migration test must run alone because it drops/restores its index in the disposable fixture.
