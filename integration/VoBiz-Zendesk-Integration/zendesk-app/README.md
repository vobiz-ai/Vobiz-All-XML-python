# Vobiz Calling — Zendesk app

This is the ZAF v2 app only. Setup, architecture and debugging live one level up
in **[`../README.md`](../README.md)**.

```
assets/
  index.html            top_bar softphone panel
  ticket-sidebar.html   ticket context + "Call requester"
  background.html       click-to-dial relay (Talk Partner Edition only)
  scripts/app.js        the softphone — SIP, calling, Zendesk write-back
  logo.png              320x320 Marketplace tile
  logo-small.png        128x128 in-product icon
  icon_top_bar.svg      top bar icon — this exact filename or Zendesk ignores it
tools/
  make-brand-assets.py  regenerates the two logos from the Vobiz mark
translations/en.json    UI strings and the Marketplace listing copy
manifest.json           locations, parameters, Marketplace fields
```

Run it:

```bash
npm install -g @zendesk/zcli
zcli apps:server
# then open https://<subdomain>.zendesk.com/agent/dashboard?zcli_apps=true
```

Package it for upload or submission:

```bash
zcli apps:validate
zcli apps:package .     # writes tmp/app-<timestamp>.zip
```

Marketplace submission status is tracked in
[`../MARKETPLACE.md`](../MARKETPLACE.md).
