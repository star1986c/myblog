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


async def check_request_bindings(instance, frames, profile):
    """Real queues/resolvers and encrypted clicks; no command or model runs."""
    from tools import approval
    from tools.approval_gateway_wait import _ApprovalEntry

    key = f"approval-binding:{profile}"
    passed = []

    def enqueue(label):
        entry = _ApprovalEntry({"command": f"synthetic {label}; never executed"})
        with approval._lock:
            approval._gateway_queues.setdefault(key, []).append(entry)
        return entry

    async def render(entry, **kwargs):
        result = await instance.send_exec_approval(
            chat_id=profile, command=entry.data["command"], session_key=key,
            request_id=entry.data["request_id"], **kwargs)
        assert result.success, result.error
        return instance._cipher.decrypt_message(frames[-1], expected_sender="agent")["interaction"]

    async def click(card, choice="once"):
        # Fresh wire ids also test replay through a second client, not only WS deduplication.
        envelope = instance._cipher.encrypt_message(sender="client", text="",
            interaction_response={"promptId": card["id"], "optionId": choice}, message_id=str(uuid.uuid4()))
        await instance._handle_frame(json.dumps({"type": "action", "userId": "owner", "message": envelope}))
        await asyncio.gather(*list(instance._interaction_tasks))

    def state_of(card):
        for frame in reversed(frames):
            payload = instance._cipher.decrypt_message(frame.get("message", frame), expected_sender="agent")
            interaction = payload.get("interaction", {})
            if interaction.get("id") == card["id"]:
                return interaction["state"]
        raise AssertionError("card missing")

    try:
        for reason in ("other_surface", "upstream_timeout"):
            first = enqueue("old-" + reason)
            card = await render(first)
            if reason == "other_surface":
                assert approval.resolve_gateway_approval(key, "deny", request_id=first.data["request_id"]) == 1
            else:
                # Model the upstream waiter's timeout cleanup while this client's card is still live.
                with approval._lock:
                    approval._gateway_queues[key].remove(first)
                    first.expired = True
            second = enqueue("new-" + reason)
            await click(card)
            assert not second.event.is_set() and second.result is None, reason + ": old card approved new request"
            assert state_of(card) == "expired"
            assert card["id"] not in instance._pending_interactions
            assert first.result == ("deny" if reason == "other_surface" else None)
            approval.unregister_gateway_notify(key)
            passed.append(reason)

        first, second = enqueue("concurrent-A"), enqueue("concurrent-B")
        a, b = await render(first), await render(second)
        await click(b, "deny")
        assert second.result == "deny" and not first.event.is_set(), "out-of-order click resolved queue head"
        await click(a)
        assert first.result == "once" and not approval.has_blocking_approval(key)
        passed.append("out_of_order_requests")

        # Both cards and duplicate clicks arrive while resolution edits await ACKs.
        first, second = enqueue("parallel-A"), enqueue("parallel-B")
        a, b = await render(first), await render(second)
        before = len(frames)
        await asyncio.gather(click(b, "deny"), click(a), click(b, "deny"), click(a))
        assert first.result == "once" and second.result == "deny"
        assert len(frames) - before == 2, "duplicate click emitted extra resolution"
        third = enqueue("after-duplicates")
        await click(a)
        await click(b, "deny")
        assert not third.event.is_set() and len(frames) - before == 2
        approval.unregister_gateway_notify(key)
        passed.append("parallel_and_replayed_clicks")

        first, second = enqueue("expired-card"), enqueue("after-expired-card")
        a = await render(first)
        instance._pending_interactions[a["id"]]["expires_at"] = int(time.time() * 1000) - 1
        await click(a)
        assert not first.event.is_set() and not second.event.is_set()
        assert state_of(a) == "expired"
        approval.unregister_gateway_notify(key)
        passed.append("client_card_expiry")

        first = enqueue("missing-id")
        before = len(frames)
        result = await instance.send_exec_approval(chat_id=profile,
            command=first.data["command"], session_key=key)
        assert not result.success and len(frames) == before
        assert not first.event.is_set()
        passed.append("missing_id_refused")

        a = await render(first)
        instance._pending_interactions[a["id"]].pop("request_id", None)
        await click(a)
        assert not first.event.is_set(), "missing stored ID fell back to FIFO"
        assert state_of(a) == "expired"
        passed.append("missing_stored_id_fails_closed")
    finally:
        approval.unregister_gateway_notify(key)
    return passed


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
                            allow_session=allow_session, allow_permanent=allow_permanent,
                            request_id=entry.data["request_id"])
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
            bindings = await check_request_bindings(instance, frames, profile)
    finally:
        tasks = list(instance._interaction_expiry_tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        reset_secret_scope(st)
        reset_hermes_home_override(ht)
    return {"profile": profile, "encrypted_approval_cases": cases, "request_binding_cases": bindings}


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
