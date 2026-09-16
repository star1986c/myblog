"""Offline integration check; run separately from the stub-based unittest suite.

PYTHONPATH=/path/to/hermes:/path/to/integrations/hermes-cloudflare-chat \
    python tests/verify_real_hermes_approval.py

Uses the installed upstream Gateway probe, approval template and resolver. Only
transport is looped back; no command executes and no real profile is modified.
"""

import asyncio
import base64
import itertools
import json
import tempfile
import time
import uuid
from pathlib import Path
from unittest.mock import patch

from agent.secret_scope import set_secret_scope, reset_secret_scope
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from gateway.config import PlatformConfig
from gateway.platform_registry import PlatformEntry, platform_registry
from gateway.platforms.base import BasePlatformAdapter
from gateway.run_turn_runner import _renders_exec_approval_buttons
from cloudflare_chat import adapter as plugin


class Context:
    def register_platform(self, **kwargs):
        platform_registry.register(PlatformEntry(**kwargs))


async def check_profile(profile, root):
    home = root / profile
    home.mkdir()
    (home / "config.yaml").write_text("approvals:\n  timeout: 720\n")
    ht = set_hermes_home_override(home)
    st = set_secret_scope({
        "HERMES_CF_RELAY_URL": "wss://offline.invalid/ws",
        "HERMES_CF_AGENT_SECRET": "synthetic-only",
        "HERMES_CF_CHAT_KEY": base64.urlsafe_b64encode(bytes(range(32))).decode(),
        "HERMES_CF_SPACE_ID": profile, "HERMES_CF_AGENT_ID": profile,
        "HERMES_CF_ALLOWED_USERS": "android-owner",
    })
    # Import after installing the temporary home: approval loads its allowlist at import time.
    from tools import approval
    from tools.approval_gateway_wait import _ApprovalEntry

    instance = plugin.CloudflareChatAdapter(PlatformConfig(enabled=True))
    frames = []
    cases = 0

    async def send_frame(frame):
        frames.append(frame)
        envelope = frame["message"] if frame.get("type") == "edit" else frame
        await instance._handle_frame(json.dumps({
            "type": "ack", "id": envelope["id"], "seq": len(frames),
        }))

    try:
        with patch.object(instance, "_send_frame", side_effect=send_frame):
            for smart_denied, allow_session, allow_permanent in itertools.product((False, True), repeat=3):
                expected = ["once"]
                if not smart_denied and allow_session:
                    expected.append("session")
                    if allow_permanent:
                        expected.append("always")
                expected.append("deny")
                for choice in expected:
                    key = f"approval-test:{profile}:{cases}"
                    entry = _ApprovalEntry({"command": "synthetic approval; never executed"})
                    with approval._lock:
                        approval._gateway_queues[key] = [entry]
                    try:
                        started = int(time.time() * 1000)
                        result = await instance.send_exec_approval(
                            chat_id=profile, command=entry.data["command"], session_key=key,
                            description="offline regression", smart_denied=smart_denied,
                            allow_session=allow_session, allow_permanent=allow_permanent)
                        assert result.success, result.error
                        payload = instance._cipher.decrypt_message(frames[-1], expected_sender="agent")
                        card = payload["interaction"]
                        assert card["kind"] == "approval" and card["state"] == "pending"
                        assert [o["id"] for o in card["options"]] == expected
                        assert all(o["style"] in {"default", "primary", "danger", "warning"}
                                   for o in card["options"])
                        assert payload["text"] == instance._format_exec_approval(
                            entry.data["command"], "offline regression", smart_denied)
                        assert started + 720_000 <= card["expiresAt"] <= int(time.time() * 1000) + 720_000
                        if "always" not in expected:
                            try:
                                await instance._handle_interaction_response(
                                    {"promptId": card["id"], "optionId": "always"}, relay_user="owner")
                            except ValueError:
                                pass
                            else:
                                raise AssertionError("restricted choice was accepted")
                            assert not entry.event.is_set()
                        envelope = instance._cipher.encrypt_message(
                            sender="client", text="", interaction_response={
                                "promptId": card["id"], "optionId": choice,
                            }, message_id=str(uuid.uuid4()))
                        action = json.dumps({"v": 1, "type": "action", "userId": "owner", "message": envelope})
                        await instance._handle_frame(action)
                        await asyncio.gather(*list(instance._interaction_tasks))
                        assert entry.event.is_set() and entry.result == choice
                        assert not approval.has_blocking_approval(key)
                        resolved = instance._cipher.decrypt_message(frames[-1]["message"], expected_sender="agent")
                        assert resolved["interaction"]["state"] == "resolved"
                        assert resolved["interaction"]["options"] == []
                        assert card["id"] not in instance._pending_interactions
                        count = len(frames)
                        await instance._handle_frame(action)
                        await asyncio.gather(*list(instance._interaction_tasks))
                        assert len(frames) == count, "duplicate action emitted another resolution"
                        cases += 1
                    finally:
                        approval.unregister_gateway_notify(key)
    finally:
        tasks = list(instance._interaction_expiry_tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        reset_secret_scope(st)
        reset_hermes_home_override(ht)
    return {"profile": profile, "encrypted_approval_cases": cases}


async def main():
    assert _renders_exec_approval_buttons(plugin.CloudflareChatAdapter)
    assert plugin.CloudflareChatAdapter.send_exec_approval is BasePlatformAdapter.send_exec_approval
    plugin.register(Context())
    with tempfile.TemporaryDirectory(prefix="hermes-approval-integration-") as root:
        results = [await check_profile(profile, Path(root)) for profile in ("default", "personal")]
    print(json.dumps({"gateway_recognizes_buttons": True, "uses_upstream_template": True,
                      "results": results}, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
