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

Version 0.1.1 ignores duplicate and out-of-order relay sequences before they
reach Hermes. Stop the profile gateway, replace the complete plugin directory,
and restart the gateway. Existing environment variables and chat keys do not
need to change.
