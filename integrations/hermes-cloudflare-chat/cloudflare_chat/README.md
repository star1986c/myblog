# Cloudflare Chat Hermes plugin

Deploy this directory to:

```text
/root/.hermes/plugins/cloudflare_chat
```

For a named Hermes profile, deploy the same directory to that profile's own
Hermes home, for example:

```text
/root/.hermes/profiles/personal/plugins/cloudflare_chat
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

Version 0.1.6 emits a best-effort typing frame as soon as each new inbound
message is accepted, before dispatching it to the Hermes Gateway. This makes
the Android “thinking” indicator consistent across default and named profiles,
even when their Gateway typing behavior differs. Existing environment variables
and chat keys do not change.

Version 0.1.5 adds Hermes Gateway streaming support. The first response creates
one normal chat message, later chunks edit that same Android bubble, and the
final edit is stored by the relay for reconnect/resume. Both the replacement
sequence and final flag are duplicated inside the encrypted payload so the
Android client can reject relay-side retargeting. Upgrade the Worker, plugin,
and Android app together. Existing environment variables and chat keys do not
change.

Version 0.1.4 prevents an Android image from being replayed into Hermes after
the inbound message has already been accepted. The plugin checkpoints the
sequence before dispatch, treats local checkpoint-write failures as non-fatal,
and confirms consumed sequences to the relay. The relay keeps a per-agent
consumer offset, so a restart or missing local state file cannot feed the same
image to the Agent repeatedly. This version requires the matching Worker
deployment.

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
