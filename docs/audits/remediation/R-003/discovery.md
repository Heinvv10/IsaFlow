# R003 first-registration WhatsApp ownership

Discovered while validating K005 on222eb799. The authenticated WhatsApp settings POST checks E164 syntax and company write access, but asks for no provider ownership proof. K005 adds destination uniqueness and fail-closed ambiguity, which prevents conflicting assignments; it does not prove that the first registrant controls the WABA number.

This is a separate provisioning-authority candidate, not a claim that arbitrary external senders must be company members. Validate the actual configured provider/account model and reproduce a first-claim interception before selecting a correction. Options must preserve legitimate setup and establish provider-to-company authority, not merely forbid all self-service registration. Existing UI says connect your WABA and configure Twilio's webhook; shared TWILIO_AUTH_TOKEN configuration must be traced.

Priority: immediately after K005 and before financial candidates. No external sends, provider changes or production tests authorized. Candidate only: no correction/ownership-verification acceptance is claimed.
