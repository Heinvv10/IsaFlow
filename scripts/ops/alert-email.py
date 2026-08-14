#!/usr/bin/env python3
"""Minimal SMTP alert helper. Reads SMTP_* + ALERT_EMAIL from the environment
(or sources /home/velo/isaflow/.env.local as a fallback). Sends subject
from argv[1] and body from stdin. Exits non-zero on send failure; calling
script has already trapped its own failure, so a secondary SMTP fault is
logged to journald only.
"""
from __future__ import annotations
import os
import socket
import ssl
import smtplib
import sys
from email.mime.text import MIMEText



class _SMTPSSLWithSNI(smtplib.SMTP_SSL):
    """SMTP_SSL that lets us set the TLS SNI hostname independently of the
    connect host.

    This mail server presents a certificate for www513.jnb1.host-h.net while
    being reached as mail.isaflow.co.za. Python's SMTP_SSL derives SNI from the
    connect host, so the handshake stalls and the greeting read times out —
    which surfaces as a bare `TimeoutError`, not as a certificate error, and is
    thoroughly misleading. The app's nodemailer transport already handles this
    via `tlsServername` (emailService.ts); this mirrors it.
    """

    def __init__(self, *args, sni_hostname=None, **kwargs):
        self._sni_hostname = sni_hostname
        super().__init__(*args, **kwargs)

    def _get_socket(self, host, port, timeout):
        sock = socket.create_connection((host, port), timeout, self.source_address)
        return self.context.wrap_socket(
            sock, server_hostname=self._sni_hostname or host
        )


def load_env_from_file(path: str) -> None:
    if not os.path.isfile(path):
        return
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
                    v = v[1:-1]
                os.environ.setdefault(k, v)
    except PermissionError:
        # File may be mode 600 owned by velo; the calling process must have
        # set the env vars before calling us.
        pass


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: alert-email.py <subject>  (body on stdin)", file=sys.stderr)
        return 2
    subject = sys.argv[1]
    body = sys.stdin.read()

    load_env_from_file("/home/velo/isaflow/.env.local")

    host = os.environ.get("SMTP_HOST")
    port = int(os.environ.get("SMTP_PORT", "587"))
    # Derive implicit-TLS from the PORT unless explicitly overridden. Defaulting
    # this to false meant a plain SMTP connect against 465 (which expects TLS
    # immediately): the server never sends a greeting, so the failure surfaced
    # as a bare read timeout rather than anything pointing at TLS.
    _secure_env = os.environ.get("SMTP_SECURE")
    if _secure_env is not None:
        secure = _secure_env.lower() in ("true", "1", "yes")
    else:
        secure = int(port) == 465
    user = os.environ.get("SMTP_USER")
    password = os.environ.get("SMTP_PASS")
    sender = os.environ.get("SMTP_FROM", user)
    recipient = os.environ.get("ALERT_EMAIL") or user

    missing = [k for k, v in {
        "SMTP_HOST": host, "SMTP_USER": user, "SMTP_PASS": password,
        "SMTP_FROM": sender, "recipient": recipient,
    }.items() if not v]
    if missing:
        print(f"alert-email: missing config: {', '.join(missing)}", file=sys.stderr)
        return 3

    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = recipient

    sni = os.environ.get("SMTP_TLS_SERVERNAME") or None
    if secure:
        ctx = ssl.create_default_context()
        smtp = _SMTPSSLWithSNI(host, port, context=ctx, timeout=30, sni_hostname=sni)
    else:
        smtp = smtplib.SMTP(host, port, timeout=30)
        smtp.ehlo()
        # SMTP.starttls() takes no server_hostname (3.12); SNI is read from
        # _host. Overriding it is the documented way to point SNI at a cert
        # whose name differs from the connect host.
        if sni:
            smtp._host = sni
        smtp.starttls(context=ssl.create_default_context())
        smtp.ehlo()
    try:
        smtp.login(user, password)
        smtp.sendmail(sender, [recipient], msg.as_string())
    finally:
        smtp.quit()
    print(f"alert-email: sent to {recipient}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
