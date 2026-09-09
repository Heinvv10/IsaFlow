# Provider event provenance

Checked official Twilio documentation on 2026-09-08:
- https://www.twilio.com/docs/messaging/guides/webhook-request
- https://www.twilio.com/docs/messaging/guides/track-outbound-message-status

Incoming WhatsApp callbacks document Body, NumMedia and WaId; message addresses identify sender and recipient. Outbound status callbacks also carry signed destination information, so signature plus To alone is insufficient. The route now checks the signed POST body's WhatsApp addresses, content/media fields and sender identity, and rejects non-received status values. Absent status fields remain accepted. Query parameters cannot supply missing body fields. The SDK still validates every signed parameter and the exact URL.

Review reproduced a synthetic signed delivered callback activating a pending claim before this gate. It now rejects before activation/capture. This proves the local documented contract, not a live provider exploit or sandbox pass. Hold provider-console acceptance open and trust signing-key/account configuration administrators explicitly. A provider API lookup is not required for the bounded documented callback distinction; it would add independent event verification.

The logging regression independently reproduced percent-encoded token leakage through withErrorHandler. Redaction now decodes query parameter names and removes the entire token value before request/response logs, including encoded values. Reverse-proxy log redaction remains a target rollout prerequisite.
