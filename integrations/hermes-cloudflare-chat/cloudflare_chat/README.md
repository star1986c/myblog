# Cloudflare Chat Hermes plugin

Deploy this directory to:

```text
/root/.hermes/plugins/cloudflare_chat
```

For a named Hermes profile, deploy the same directory to that profile's own
Hermes home, for example:

```text
/root/.hermes/profiles/research/plugins/cloudflare_chat
```

The plugin connects outbound to:

```text
wss://h.superstar1014.qzz.io/api/hermes-chat/ws
```

It requires Python packages listed in `requirements.txt`. Install them into the
same interpreter or virtual environment that owns the `hermes` executable.
Each profile has its own `.env`. The default profile uses `/root/.hermes/.env`;
a named profile uses `/root/.hermes/profiles/<name>/.env`. Every profile must
set a unique `HERMES_CF_SPACE_ID` and `HERMES_CF_CHAT_KEY`.

## Upgrade notes

Version 0.1.3 fixes Cloudflare Error 1010 on attachment requests by replacing
Python urllib's default browser signature with an explicit
`Hermes-Cloudflare-Chat` User-Agent. It also records bounded HTTP response
details and the Cloudflare Ray ID when an upload fails. No Cloudflare secret,
chat key, or Android configuration change is required. This version also adds
explicit Agent guidance to preserve a safe local image path as a standalone
`MEDIA:` directive when needed.

Version 0.1.2 recovers extensionless Markdown image URLs and local `MEDIA:`
image directives in the adapter's text send path. This covers Hermes responses
that older or stricter base media extraction leaves as plain text. Successfully
recovered images are encrypted and uploaded as normal chat attachments; if an
upload fails, the original image markup remains visible instead of disappearing.

Version 0.1.1 ignores duplicate and out-of-order relay sequences before they
reach Hermes. Stop the profile gateway, replace the complete plugin directory,
and restart the gateway. Existing environment variables and chat keys do not
need to change.
