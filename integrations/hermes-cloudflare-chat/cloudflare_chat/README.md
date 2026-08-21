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

Version 0.3.2 reads the dangerous-command authorization deadline from the
current Hermes profile's `approvals.timeout` setting each time it creates an
approval prompt. Missing, malformed, or unreadable configuration falls back to
Hermes' 300-second default. This keeps the encrypted button `expiresAt`, the
plugin's proactive expiry update, and Hermes' fail-closed wait aligned for both
the default and named profiles. No environment variables, Worker deployment,
or Android/macOS client upgrade are required. Replace the plugin for every
Hermes profile and restart each Gateway.

Version 0.3.1 keeps Hermes' fail-closed 300-second authorization window and
actively finalizes unanswered interactive prompts as expired when that window
ends. Android already rejects expired actions locally; macOS now refreshes the
button state at the deadline and checks it again before sending. If a normal
outbound message loses its WebSocket application ACK, the adapter retires the
stale socket and confirms the exact same encrypted message id through the
existing authenticated HTTPS endpoint. The relay's idempotency prevents a
second visible message. No environment variables, chat keys, or Worker upgrade
are required for this release. Replace the plugin for every Hermes profile and
restart each Gateway; install the matching macOS client for the local expiry UI.

Version 0.3.0 keeps Android/macOS uploads and all inbound files on the existing
10 MiB end-to-end encrypted path, while allowing this trusted NAS Agent to
deliver larger generated files directly to the private R2 bucket. Files above
10 MiB are hashed in a stream, uploaded with a short-lived object-specific PUT
URL, verified by the Worker, and only then referenced inside the encrypted chat
message. The filename, media type, size, hash, and message stay encrypted; the
large R2 object itself is private but is not encrypted with the chat key. The
default Agent output ceiling is 512 MiB. Set
`HERMES_CF_AGENT_ATTACHMENT_MAX_BYTES` to a lower matching value on each
profile if desired. `HERMES_CF_DIRECT_UPLOAD_TIMEOUT_SECONDS` defaults to 900.
No permanent R2 credential is stored on the NAS. Deploy and configure the
matching Worker, replace the complete plugin directory for every profile, then
restart each Gateway. New Android and macOS clients are required to open the
new large-object attachment format; old encrypted attachments remain fully
compatible.

Version 0.2.0 adds Hermes-native interactive prompts to the encrypted Android
chat. The adapter implements `send_model_picker`, `send_choice_picker`,
`send_exec_approval`, `send_slash_confirm`, and `send_clarify` using the same
resolver/callback contracts as the official Telegram adapter. Prompt text,
button labels, selections, and results stay inside the existing AES-GCM message
payload. Button taps use a short-lived encrypted WebSocket action that is routed
to the matching profile but is not stored as chat history; the resolved result
replaces the original prompt as a durable encrypted edit. Deploy the matching
Worker first, then replace the complete plugin directory and restart each
profile Gateway. Finally install Android 2.15. Environment variables and chat
keys do not change. Pending prompts do not survive a Gateway restart; send the
command again after upgrading.

Version 0.1.8 adds Hermes out-of-process cron delivery. The plugin registers a
`standalone_sender_fn` and publishes each encrypted cron result through a
short-lived authenticated HTTPS request, so `hermes cron run` does not need to
open a second agent WebSocket or replace the running Gateway connection. Cron
output is routed by each profile's `HERMES_CF_SPACE_ID`; the default profile can
deliver to `primary` while `hermes -p personal` delivers to `personal`. Deploy
the matching Worker before upgrading the plugin. Existing environment variables
and chat keys do not change.

Version 0.1.7 adds bidirectional encrypted attachments. Android can send the
supported images, audio, video, documents, Office files, archives, EPUB/APK/IPA
files to Hermes, and the adapter now implements `send_document`, `send_file`,
`send_voice`, and `send_video` for Agent output. Each attachment remains limited
to 10 MiB. Audio and video are delivered with their native Hermes message types;
other non-image files use `DOCUMENT`. Existing environment variables and chat
keys do not change. The attachment wire format is unchanged; when using Android
2.5's single/multi-message deletion, deploy the matching Worker release as well.

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
