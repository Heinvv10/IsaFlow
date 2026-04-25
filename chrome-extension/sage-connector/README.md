# ISAFlow Sage Connector

A tiny Chrome extension that lets the ISAFlow admin console read your
Sage Business Cloud session cookie so a Sage import can run server-side
without bookmarklets, JSON downloads, or copy/paste.

## Why this exists

- The Sage web app (`accounting.sageone.co.za`) sets its session cookie
  with the `HttpOnly` flag, which means **no web page can read it from
  JavaScript**, no matter how clever the bookmarklet.
- Same-origin policy stops `admin.isaflow.co.za` from reading anything
  inside the Sage tab — even though both tabs are open in the same
  browser.
- A Chrome extension with the `cookies` permission *can* read the
  cookie. So we do the smallest possible extension: read the cookie,
  hand it to the ISAFlow admin page when asked, do nothing else.

## Install (developer mode)

1. Clone or download this folder (`chrome-extension/sage-connector/`).
2. Open Chrome → `chrome://extensions/`.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and pick the `sage-connector/` folder.
5. The extension should appear in the list — make sure it's enabled.

That's it. No popup, no settings, no telemetry.

## Use

1. In Chrome, sign in to Sage Business Cloud
   (`https://accounting.sageone.co.za`) and select the company you want
   to import.
2. Open ISAFlow admin: `https://admin.isaflow.co.za/tools/sage-import`.
3. Pick the target ISAFlow company.
4. Click **Pull from Sage**. The page asks the extension for the
   session cookie, sends it to the ISAFlow server, and the server
   pulls all your data via Sage's API directly.

The cookie is only ever held in memory for the duration of the
request. Nothing is stored client-side.

## Security

- The extension responds only to `chrome.runtime.sendMessage` calls
  from its own content script, which only runs on
  `app.isaflow.co.za`, `admin.isaflow.co.za`, and localhost (so this
  also works in dev).
- The cookie is sent over HTTPS to the ISAFlow API and used once for
  the pull. It is not persisted anywhere.
- If you uninstall the extension, the page falls back to a "paste
  cookie value" textbox. No functionality is lost — only convenience.
