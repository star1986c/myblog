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

Version 0.3.10 targets Hermes `v0.22.4` and declares
`requires_hermes: ">=0.22.4"`. Python dependencies are declared in
`plugin.yaml` (`python_dependencies`) for Hermes' native dependency management;
`requirements.txt` contains the same requirements for manual installation into
the interpreter or virtual environment that owns the `hermes` executable.
Simply copying the directory does not install dependencies. An already upgraded
Hermes v0.22.4 environment satisfies them with cryptography 50.0.1 and
websockets 15.0.1; do not reinstall the older plugin's requirements.
Each profile has its own `.env`. The default profile uses `/root/.hermes/.env`;
a named profile uses `/root/.hermes/profiles/<name>/.env`. Every profile must
set a unique `HERMES_CF_SPACE_ID` and `HERMES_CF_CHAT_KEY`.

## Upgrade notes

Version 0.3.10 fixes connection-lock handling against Hermes v0.22.4:

- Read the acquired flag from the upstream `(acquired, existing)` result, so a
  lock held by another live process prevents opening a second relay connection.
- Release locks through `gateway.status_scoped_locks.release_scoped_lock`.
  Disconnect now removes the actual lock file, not just the adapter's key.
- A missing lock backend no longer silently permits an unlocked connection.

Upgrade Hermes to v0.22.4 before installing this plugin. Replace the complete
plugin directory in every enabled profile, retain each profile's outer `.env`,
keys and enablement, and restart the shared Gateway once. Keep
`plugins.isolation: in_process`. No Worker, Android or macOS update is required.
The 0.3.9 reconnect backoff and stream deduplication remain unchanged. Local
checks cover actual lock files and a competing process as well as messaging,
approval, attachments and profile isolation; they do not prove NAS networking.

Version 0.3.9 reduces avoidable relay work without changing the protocol:

- Reconnect delay grows exponentially, with 75–100% jitter and a 30-second ceiling.
  Only a connection lasting at least 60 seconds resets it; brief successful
  handshakes no longer produce a continuous one-second reconnect loop.
- Identical intermediate stream edits are skipped only after their ACK on the
  same connection. The memory-only cache holds at most 128 chat/target entries
  and stores content digests. Failed, cancelled, concurrent superseded and old
  connection ACKs do not establish cache entries. Final edits always transmit.
- Existing encryption, durable final messages, ACK/HTTP fallback, checkpoint
  replay, attachments, commands and interaction cards remain in place.

No Worker deployment, paid service or polling endpoint is added. Android 2.24
separately adds foreground health checks and network recovery; install that APK
for the Android improvement. The plugin remains compatible with existing clients.
These changes reduce unnecessary work; future usage still depends on traffic and
all services sharing the account's free allowances.

Version 0.3.9 retains the 0.3.8 fix for ordinary-message admission in Hermes v0.22.1's unified
Gateway. The adapter's typing epoch now lives on the in-process event object
instead of in `MessageEvent.metadata`: canonical durable admission accepts a
closed metadata schema and rejected the old custom field with `invalid_params`.
The epoch stays out of the persisted input and model context; existing typing,
queued-message and cancellation behavior is retained. Dependencies and the
Cloudflare wire protocol are unchanged. Keep `plugins.isolation: in_process`;
platform adapters do not support `host` isolation. Replace the plugin in every
enabled profile, keep its parent `.env` and keys, and restart the owning Gateway
once. The local verification includes the real GatewayRunner and SQLite session
authority with synthetic model execution and transport; NAS networking is not
covered by that check.

Version 0.3.7 fixes installation compatibility with Hermes `v2026.9.24`.
The cryptography requirement is now `>=50,<51`, which includes Hermes' pinned
50.0.0 instead of forcing a downgrade below 48. The existing websockets range
`>=14,<17` includes Hermes' pinned 15.0.1. The manifest declares both packages,
so Hermes can check them against core and other enabled plugins during managed
installation and reapply them after a Hermes update rebuilds the environment.
The minimum Hermes version is declared as 0.21.5; releases below that are outside
this plugin release's supported range.

Replace the complete `cloudflare_chat` directory in every served profile,
preserve each profile's `.env`, keys and enablement, and restart its owning
Gateway. For a multiplex Gateway, restart the single owner after replacing all
served profiles. No Worker or Android/macOS update is required. In-flight
interactive prompts do not survive a Gateway restart; send a new request after
upgrading. Validation uses the exact Hermes tag in an isolated local environment;
NAS networking and installed-client checks remain deployment checks.

Version 0.3.6 adopts Hermes' current `ExecApprovalPrompt` interface. The adapter
now implements `_send_exec_approval_prompt`; the inherited `send_exec_approval`
builds the shared prompt text and permitted action set. This also makes the
Gateway's `supports_exec_approval_buttons()` probe recognize the encrypted
buttons again. Text, action labels, and approval tiers come from Hermes;
an empty upstream button style maps to the clients' `default` style.
The old adapter-owned approval entry point is removed. This release requires
the current Hermes approval API (available in `v2026.9.14` and later).
No Worker or Android/macOS update is required. Replace the plugin in every
served profile and restart its owning Gateway. Existing text-only messages
do not gain buttons retroactively; use a new approval request after restarting.

Version 0.3.5 fixes application ACK timeouts caused by inline busy-session
commands such as `/stop`, `/status`, and `/approve`. The WebSocket receiver now
handles ACKs independently of ordered inbound message processing, so command
replies and slow attachment downloads do not block their own acknowledgements.
Messages and resume pagination remain ordered; in-flight dispatch survives
transient reconnects, and the bounded inbox replays overflow via reconnect.
Gateway shutdown cancels and joins both the receiver and inbox processor.
This addresses the adapter's receive-loop stall; unrelated heartbeat, TLS, and
HTTP connection failures still require separate diagnosis.

Version 0.3.4 fixes configuration isolation when one Hermes Gateway serves
multiple profiles (`gateway.multiplex_profiles: true`). All `HERMES_CF_*`
settings now use Hermes' current-profile scope, including relay URL, space id,
agent id, user authorization, media directory, and attachment limits/timeouts.
Previously those settings could come from the launch profile while the chat
key came from the served profile, causing wrong-room connections or a profile
to fail enablement. Single-profile Gateways retain their environment fallback.

Replace the complete plugin directory in every served profile's Hermes home;
each profile must still enable `cloudflare_chat` and keep its own `.env`.
For a multiplex Gateway, restart only the Gateway that serves all profiles
(usually `hermes -p default gateway restart`), then check each profile's status.
For separate Gateways, restart each owning Gateway. Existing chat keys and
environment variables stay valid; no Worker or native-client update is needed.

Version 0.3.3 explicitly clears the relay typing state with
`active=false, terminal=true` when Hermes finishes a response. It also requires
the matching Worker release, which keeps one Durable Object stub and one serial
RPC queue per native-client hub so the final response and the following stop
frame cannot be reordered. A stub is evicted only after an RPC failure or an
expired registration is confirmed absent; a concurrently refreshed
registration keeps its stub. No environment variables or chat keys change.

The adapter also assigns every accepted inbound message its own typing epoch.
At that boundary it first emits `active=false, terminal=false` to clear any
typing state left by the previous turn without cancelling the client's new
pending-response state. Only a refresh task created by the current turn may emit a new
`active=true` frame, and stopping that turn closes its epoch before sending
`active=false`. Normal and cascaded queued turns therefore light the indicator
from their own `_keep_typing` task, while `/new` or `/reset` bypass paths that
create no new task remain clear. This is a local defense for an upstream Hermes
lifecycle edge case where an older refresh task survives: its late heartbeats
and final cleanup become no-ops rather than changing the new turn's state.
Closing does not consume a new epoch id, so Hermes may retry `active=false`
after a transient send failure; a later inbound epoch immediately makes those
old retries stale. If Hermes merges several queued text/media follow-ups into
an existing pending or text-debounce event, the adapter retags that object with
the latest epoch; a distinct older event keeps its original epoch even when its
task is scheduled late. In-band queue draining rebinds the existing runner task
to that latest epoch. Inline busy-session commands and approval/clarify resumes
likewise rebind only the newest live owner/heartbeat task; active `/new` and
`/reset` turns emit their own terminal stop after interrupting the old owner.

New clients treat a missing `terminal` marker on an inactive frame as terminal
for compatibility with older plugins. Deploy the Worker, replace the plugin for
every Hermes profile, restart each Gateway, and install a client release with
the defensive typing timeout.

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
