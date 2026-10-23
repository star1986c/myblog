"""Offline integration checks against Hermes v0.22.4's real runtime.

Set PYTHONPATH to the pinned Hermes checkout and this integration directory,
HERMES_HOME to a scratch directory under /private/tmp or /tmp, and AUDIT_PLUGIN_DIR
to the plugin to check. Network/model boundaries are synthetic; native admission,
SQLite scheduling, authorization, crypto and delivery remain real. Do not run
alongside the stub-based test_*.py suite in the same interpreter.
"""
import asyncio
import base64
import inspect
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

PLUGIN_DIR = Path(os.environ["AUDIT_PLUGIN_DIR"])


class LoopbackRelay:
    """Same envelope and ACK flow as the relay, with no external connection."""
    def __init__(self):
        self.incoming = asyncio.Queue()
        self.sent = []
        self.sequence = 100
        self.closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    def __aiter__(self):
        return self

    async def __anext__(self):
        raw = await self.incoming.get()
        if raw is None:
            raise StopAsyncIteration
        return raw

    def feed(self, frame):
        self.incoming.put_nowait(json.dumps(frame))

    async def send(self, raw):
        frame = json.loads(raw)
        self.sent.append(frame)
        if frame["type"] in {"message", "edit"}:
            envelope = frame.get("message", frame)
            self.sequence += 1
            self.feed({"type": "ack", "id": envelope["id"], "seq": self.sequence})

    async def close(self, *args, **kwargs):
        self.closed = True
        self.incoming.put_nowait(None)


async def until(predicate):
    async with asyncio.timeout(8):
        while not predicate():
            await asyncio.sleep(0.01)


class RealHermesCompatibility(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Keep synthetic fixtures until process exit: upstream background catalog
        # refreshes can finish writing after an individual test completes.
        self.user = Path(tempfile.mkdtemp(prefix="hermes-real-compat-"))
        self.home = self.user / ".hermes"
        self.home.mkdir()
        self.home_patch = patch.object(Path, "home", return_value=self.user)
        self.home_patch.start()
        self.env_patch = patch.dict(os.environ, {
            "HERMES_HOME": str(self.home),
            "HERMES_GATEWAY_LOCK_DIR": str(self.user / "locks"),
        })
        self.env_patch.start()
        self.managers = []
        self.adapters = []
        self.transport_patches = []
        self.profiles = {}
        for index, name in enumerate(("default", "personal"), start=1):
            home = self.home if name == "default" else self.home / "profiles" / name
            home.mkdir(parents=True, exist_ok=True)
            values = {
                "HERMES_CF_RELAY_URL": "wss://offline.invalid/api/hermes-chat/ws",
                "HERMES_CF_AGENT_SECRET": ("synthetic-" + name).ljust(48, "x"),
                "HERMES_CF_CHAT_KEY": base64.urlsafe_b64encode(bytes([index]) * 32).decode(),
                "HERMES_CF_SPACE_ID": name,
                "HERMES_CF_AGENT_ID": "audit-" + name,
                "HERMES_CF_ALLOWED_USERS": "android-owner",
            }
            (home / ".env").write_text("\n".join(f"{k}={v}" for k, v in values.items()))
            (home / "config.yaml").write_text(
                "plugins:\n  enabled: [cloudflare_chat]\n"
                "approvals:\n  timeout: 720\ngateway:\n  multiplex_profiles: true\n"
            )
            shutil.copytree(PLUGIN_DIR, home / "plugins" / "cloudflare_chat",
                            ignore=shutil.ignore_patterns("__pycache__"))
            self.profiles[name] = (home, values)
        set_multiplex_active(True)
        self.scope = self.profile_scope("default")
        self.scope.__enter__()

    def profile_scope(self, name, values=None):
        home, defaults = self.profiles[name]
        return _profile_runtime_scope(home, prepared_secret_scope=defaults if values is None else values)

    def load(self, name="default", *, enabled=True):
        home, _ = self.profiles[name]
        with self.profile_scope(name):
            if not enabled:
                (home / "config.yaml").write_text("plugins:\n  enabled: []\n")
            manager = PluginManager()
            self.managers.append(manager)
            with patch("hermes_cli.plugins.get_bundled_plugins_dir", return_value=self.user / "empty"):
                manager.discover_and_load()
            loaded = manager._plugins["cloudflare_chat"]
            if not enabled:
                self.assertIn("not enabled", loaded.error)
                self.assertIsNone(platform_registry.get("cloudflare_chat"))
                return None
            self.assertIsNone(loaded.error)
            self.assertTrue(loaded.enabled)
            entry = platform_registry.get("cloudflare_chat")
            self.assertIsNotNone(entry)
            self.assertTrue(entry.check_fn())
            self.assertEqual(entry.env_enablement_fn()["space_id"], name)
            adapter = platform_registry.create_adapter("cloudflare_chat", PlatformConfig(enabled=True))
            self.assertIsInstance(adapter, BasePlatformAdapter)
            self.assertFalse(inspect.isabstract(type(adapter)))
            adapter.set_owner_profile(name)
            self.adapters.append((name, adapter))
            return adapter

    async def connect(self, adapter):
        relay = LoopbackRelay()
        module = sys.modules[type(adapter).__module__]
        p = patch.object(module, "websocket_connect", return_value=relay)
        p.start()
        self.transport_patches.append(p)
        self.assertTrue(await adapter.connect())
        await until(lambda: any(f["type"] == "resume" for f in relay.sent))
        return relay

    def payloads(self, adapter, relay):
        return [adapter._cipher.decrypt_message(f.get("message", f), expected_sender="agent")
                for f in relay.sent if f["type"] in {"message", "edit"}]

    async def click(self, adapter, prompt, choice):
        message = adapter._cipher.encrypt_message(sender="client", text="",
            interaction_response={"promptId": prompt, "optionId": choice}, message_id=str(uuid.uuid4()))
        await adapter._handle_frame(json.dumps({"type": "action", "userId": "audit-owner", "message": message}))
        if adapter._interaction_tasks:
            await asyncio.gather(*list(adapter._interaction_tasks))

    async def inbound(self, adapter, relay, text, sequence):
        relay.feed({"type": "message", "seq": sequence,
                    "message": adapter._cipher.encrypt_message(sender="client", text=text)})
        await until(lambda: any(f["type"] == "received" and f["seq"] == sequence for f in relay.sent))

    async def asyncTearDown(self):
        for name, adapter in self.adapters:
            with self.profile_scope(name):
                await adapter.cancel_background_tasks()
                await adapter.disconnect()
        for p in reversed(self.transport_patches):
            p.stop()
        for manager in self.managers:
            manager.unload()
        self.scope.__exit__(None, None, None)
        set_multiplex_active(False)
        self.env_patch.stop()
        self.home_patch.stop()

    async def test_real_loader_enablement_and_scoped_registry(self):
        a = self.load()
        b = self.load("personal")
        for name, adapter in (("default", a), ("personal", b), ("default", a)):
            with self.profile_scope(name):
                entry = platform_registry.get("cloudflare_chat")
                self.assertIs(type(entry.adapter_factory(PlatformConfig(enabled=True))), type(adapter))
                self.assertEqual(adapter.space_id, name)
                self.assertTrue(adapter._logical_user_authorized())
        self.managers[1].unload()
        self.assertIs(type(platform_registry.create_adapter("cloudflare_chat", PlatformConfig(enabled=True))), type(a))

    async def test_disabled_plugin_does_not_register(self):
        self.load(enabled=False)

    async def test_current_base_call_signatures(self):
        adapter = self.load()
        for name, method in vars(type(adapter)).items():
            upstream = getattr(BasePlatformAdapter, name, None)
            if name == "__init__" or not inspect.isfunction(method) or not inspect.isfunction(upstream):
                continue
            args, kwargs = [], {}
            for param in inspect.signature(upstream).parameters.values():
                if param.kind in {param.POSITIONAL_ONLY, param.POSITIONAL_OR_KEYWORD}:
                    args.append(object())
                elif param.kind == param.KEYWORD_ONLY:
                    kwargs[param.name] = object()
            with self.subTest(method=name):
                inspect.signature(method).bind(*args, **kwargs)

    async def test_profile_credentials_paths_and_cipher_isolation(self):
        a, b = self.load(), self.load("personal")
        async def check(name, adapter):
            with self.profile_scope(name):
                await asyncio.sleep(0)
                headers = adapter._http_headers()
                self.assertEqual(headers["X-Hermes-Space"], name)
                self.assertEqual(adapter._state_path.parent.parent.parent, self.profiles[name][0])
                self.assertEqual(adapter._media_directory, self.profiles[name][0] / "cache/cloudflare_chat")
                event = await adapter._prepare_inbound_message(adapter._cipher.encrypt_message(sender="client", text=name))
                self.assertIn("agent:" + ("main" if name == "default" else name) + ":", adapter._event_session_key(event))
        await asyncio.gather(check("default", a), check("personal", b), check("default", a))
        encrypted = a._cipher.encrypt_message(sender="agent", text="A-only")
        with self.assertRaises(Exception):
            b._cipher.decrypt_message(encrypted, expected_sender="agent")
        with self.profile_scope("personal", {}), patch.dict(os.environ, self.profiles["default"][1]):
            self.assertFalse(b._logical_user_authorized())
            module = sys.modules[type(b).__module__]
            self.assertFalse(module.check_requirements())

    async def test_base_message_reply_and_busy_status_stop(self):
        for name in self.profiles:
            with self.subTest(profile=name), self.profile_scope(name):
                adapter = self.load(name)
                relay = await self.connect(adapter)
                started, release = asyncio.Event(), asyncio.Event()
                seen = []
                async def handler(event):
                    seen.append(event.text)
                    if event.text == "hold":
                        started.set()
                        await release.wait()
                    return "reply:" + event.text
                adapter.set_message_handler(handler)
                await self.inbound(adapter, relay, "hello", 1)
                await until(lambda: any(p["text"] == "reply:hello" for p in self.payloads(adapter, relay)))
                await until(lambda: not adapter._active_sessions)
                await self.inbound(adapter, relay, "hold", 2)
                await asyncio.wait_for(started.wait(), 8)
                await self.inbound(adapter, relay, "/status", 3)
                self.assertIn("reply:/status", [p["text"] for p in self.payloads(adapter, relay)])
                self.assertTrue(adapter._active_sessions)
                await self.inbound(adapter, relay, "/stop", 4)
                self.assertIn("reply:/stop", [p["text"] for p in self.payloads(adapter, relay)])
                await until(lambda: not adapter._active_sessions)
                await self.inbound(adapter, relay, "after stop", 5)
                await until(lambda: any(p["text"] == "reply:after stop" for p in self.payloads(adapter, relay)))
                self.assertNotIn("reply:hold", [p["text"] for p in self.payloads(adapter, relay)])
                # The loopback records a send before its queued ACK is consumed.
                # Wait for completion, not merely for the outgoing frame to exist.
                await until(lambda: not adapter._pending_acks and not adapter._active_sessions)
                self.assertFalse(adapter._pending_acks)
                self.assertEqual(seen, ["hello", "hold", "/status", "/stop", "after stop"])

    async def test_real_stream_consumer_finalizes_same_message(self):
        from gateway.stream_consumer import GatewayStreamConsumer, StreamConsumerConfig
        adapter = self.load()
        relay = await self.connect(adapter)
        consumer = GatewayStreamConsumer(adapter, adapter.space_id,
            StreamConsumerConfig(edit_interval=0.01, buffer_threshold=1, cursor=""))
        task = asyncio.create_task(consumer.run())
        consumer.on_delta("First ")
        await until(lambda: any(f["type"] == "message" for f in relay.sent))
        consumer.on_delta("second.")
        consumer.finish("First second.")
        await asyncio.wait_for(task, 8)
        messages = [f for f in relay.sent if f["type"] == "message"]
        edits = [f for f in relay.sent if f["type"] == "edit"]
        self.assertEqual(len(messages), 1)
        self.assertTrue(edits[-1]["final"])
        self.assertTrue(all(f["targetSeq"] == 101 for f in edits))
        self.assertEqual(self.payloads(adapter, relay)[-1]["text"], "First second.")

    async def test_real_media_validation_encryption_and_inbound_types(self):
        adapter = self.load()
        relay = await self.connect(adapter)
        blobs = {}
        module = sys.modules[type(adapter).__module__]
        with patch.object(adapter, "_upload_attachment", side_effect=lambda key, data: blobs.update({key:data})), \
             patch.object(adapter, "_download_attachment", side_effect=blobs.__getitem__):
            for ext, method, param, expected in [
                ("png", "send_image_file", "image_path", MessageType.PHOTO),
                ("pdf", "send_document", "file_path", MessageType.DOCUMENT),
                ("ogg", "send_voice", "audio_path", MessageType.VOICE),
                ("mp4", "send_video", "video_path", MessageType.VIDEO),
                ("zip", "send_file", "file_path", MessageType.DOCUMENT),
            ]:
                with self.subTest(extension=ext):
                    path = self.home / "cache" / ("fixture." + ext)
                    path.parent.mkdir(exist_ok=True)
                    data = b"synthetic media bytes"
                    path.write_bytes(data)
                    result = await getattr(adapter, method)(chat_id=adapter.space_id, **{param:str(path)})
                    self.assertTrue(result.success, result.error)
                    descriptor = self.payloads(adapter, relay)[-1]["attachments"][0]
                    self.assertEqual(adapter._cipher.decrypt_attachment(blobs[descriptor["id"]], descriptor), data)
                    envelope = adapter._cipher.encrypt_message(sender="client", text="input", attachments=[descriptor])
                    event = await adapter._prepare_inbound_message(envelope)
                    self.assertIsInstance(event, MessageEvent)
                    self.assertEqual(event.message_type, expected)
                    self.assertEqual(Path(event.media_urls[0]).read_bytes(), data)
            secret_file = self.home / ".env"
            result = await adapter.send_document(adapter.space_id, str(secret_file))
            self.assertFalse(result.success)

    async def test_clarify_buttons_other_and_multiselect(self):
        from tools import clarify_gateway as cg
        adapter = self.load()
        relay = await self.connect(adapter)
        for choice in ("c1", "other"):
            cid, key = str(uuid.uuid4()), "audit-clarify:" + choice
            entry = cg.register(cid, key, "Choose", ["one", "two"])
            result = await adapter.send_clarify(adapter.space_id, "Choose", ["one", "two"], cid, key)
            self.assertTrue(result.success)
            card = self.payloads(adapter, relay)[-1]["interaction"]
            await self.click(adapter, card["id"], choice)
            if choice == "c1":
                self.assertTrue(entry.event.is_set())
                self.assertEqual(entry.response, "two")
            else:
                self.assertTrue(entry.awaiting_text)
                self.assertFalse(entry.event.is_set())
                self.assertTrue(cg.resolve_gateway_clarify(cid, "typed answer"))
            self.assertIsNotNone(cg.wait_for_response(cid, 0.01))
        cid, key = str(uuid.uuid4()), "audit-multi"
        entry = cg.register(cid, key, "Choose several", ["one", "two"], multi_select=True)
        result = await adapter.send_clarify(adapter.space_id, entry.question, entry.choices, cid, key)
        self.assertTrue(result.success)
        payload = self.payloads(adapter, relay)[-1]
        self.assertFalse(payload.get("interaction"))
        self.assertIn("Multiple selections", payload["text"])
        self.assertTrue(entry.awaiting_text)
        cg.resolve_gateway_clarify(cid, "one, two")
        cg.wait_for_response(cid, 0.01)

    async def test_large_attachment_ticket_stream_upload_and_confirmation(self):
        adapter = self.load()
        relay = await self.connect(adapter)
        module = sys.modules[type(adapter).__module__]
        path = self.home / "cache" / "large.mp4"
        path.parent.mkdir(exist_ok=True)
        data = b"v" * (10 * 1024 * 1024 + 1)
        path.write_bytes(data)
        digest = hashlib.sha256(data).hexdigest()
        calls = []
        class Response:
            def __init__(self, status, payload=b""):
                self.status, self.payload = status, payload
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, limit=-1): return self.payload if limit < 0 else self.payload[:limit]
        def request(req, timeout):
            calls.append(req.get_method())
            if req.get_method() == "PUT":
                self.assertNotIn("Authorization", req.headers)
                self.assertEqual(b"".join(req.data), data)
                return Response(200)
            body = json.loads(req.data)
            common = {"storage":"r2-private-v1", "plaintextBytes":len(data), "sha256":digest}
            if req.full_url.endswith("/complete"):
                return Response(200, json.dumps({"attachment":{"id":body["attachmentId"], **common}}).encode())
            return Response(201, json.dumps({"ticket":{
                "attachmentId":body["attachmentId"], **common,
                "uploadUrl":"https://synthetic.r2.cloudflarestorage.com/audit/object?signature=test",
                "requiredHeaders":{"Content-Type":"application/octet-stream", "If-None-Match":"*"}
            }}).encode())
        with patch.object(module, "urlopen", side_effect=request):
            result = await adapter.send_video(adapter.space_id, str(path), caption="large file")
        self.assertTrue(result.success, result.error)
        self.assertEqual(calls, ["POST", "PUT", "POST"])
        desc = self.payloads(adapter, relay)[-1]["attachments"][0]
        self.assertEqual(desc["sha256"], digest)
        self.assertEqual(desc["storage"], "r2-private-v1")

    async def test_slash_confirmation_resolves_once(self):
        from tools import slash_confirm
        adapter = self.load()
        relay = await self.connect(adapter)
        calls = []
        async def handler(choice):
            calls.append(choice)
            return "synthetic command confirmation"
        for choice in ("once", "always", "cancel"):
            key, cid = "audit-slash:" + choice, str(uuid.uuid4())
            slash_confirm.register(key, cid, "audit-only", handler)
            result = await adapter.send_slash_confirm(adapter.space_id, "Confirm", "Synthetic", key, cid)
            self.assertTrue(result.success)
            card = self.payloads(adapter, relay)[-1]["interaction"]
            await self.click(adapter, card["id"], choice)
            await self.click(adapter, card["id"], choice)
            self.assertIsNone(slash_confirm.get_pending(key))
        self.assertEqual(calls, ["once", "always", "cancel"])

    async def test_model_and_choice_picker_callback_contracts(self):
        adapter = self.load()
        relay = await self.connect(adapter)
        picked = []
        async def callback(*args):
            picked.append(args)
            return "chosen"
        providers = [{"slug":"local", "name":"Local", "models":["audit-model-a","audit-model-b"]}]
        result = await adapter.send_model_picker(adapter.space_id, providers, "audit-model-a", "local", "audit-model", callback)
        self.assertTrue(result.success)
        card = self.payloads(adapter, relay)[-1]["interaction"]
        await self.click(adapter, card["id"], "p0")
        await self.click(adapter, card["id"], "m1")
        self.assertEqual(picked, [(adapter.space_id, "audit-model-b", "local")])
        result = await adapter.send_choice_picker(adapter.space_id, "Reasoning",
            [{"label":"High", "value":"high", "is_current":False}], "audit-choice", callback)
        self.assertTrue(result.success)
        card = self.payloads(adapter, relay)[-1]["interaction"]
        await self.click(adapter, card["id"], "c0")
        self.assertEqual(picked[-1], (adapter.space_id, "high"))

    async def test_disconnect_reconnect_preserves_checkpoint_and_releases_lock(self):
        from gateway.status import _get_scope_lock_path
        adapter = self.load()
        relay = await self.connect(adapter)
        lock_path = _get_scope_lock_path("cloudflare_chat", adapter._lock_key)
        self.assertTrue(lock_path.is_file())
        seen = []
        async def handler(event):
            seen.append(event.text)
        adapter.set_message_handler(handler)
        await self.inbound(adapter, relay, "first", 7)
        await until(lambda: not adapter._active_sessions)
        await adapter.cancel_background_tasks()
        await adapter.disconnect()
        self.assertTrue(relay.closed)
        self.assertIsNone(adapter._lock_key)
        self.assertFalse(lock_path.exists(), "disconnect must remove the on-disk lock")
        self.assertFalse(adapter._pending_acks)
        self.assertFalse(adapter._interaction_tasks)
        relay2 = await self.connect(adapter)
        self.assertTrue(lock_path.is_file())
        resume = next(f for f in relay2.sent if f["type"] == "resume")
        self.assertEqual(resume["afterSeq"], 7)
        duplicate = adapter._cipher.encrypt_message(sender="client", text="duplicate")
        relay2.feed({"type":"message", "seq":7, "message":duplicate})
        await self.inbound(adapter, relay2, "second", 8)
        await until(lambda: not adapter._active_sessions)
        self.assertEqual(seen, ["first", "second"])

    async def test_live_process_lock_blocks_other_process_without_releasing_owner(self):
        from gateway.status import acquire_scoped_lock, _get_scope_lock_path
        from gateway.status_scoped_locks import release_scoped_lock
        adapter = self.load()
        identity = hashlib.sha256(
            f"{adapter.relay_url}|{adapter.agent_id}|{adapter.space_id}".encode()
        ).hexdigest()
        acquired, _ = acquire_scoped_lock(
            "cloudflare_chat", identity, metadata={"owner_kind": "process"})
        self.assertTrue(acquired)
        lock_path = _get_scope_lock_path("cloudflare_chat", identity)
        original = lock_path.read_bytes()
        script = """
import json, sys
from types import SimpleNamespace
from cloudflare_chat.adapter import CloudflareChatAdapter
instance = SimpleNamespace(relay_url=sys.argv[1], agent_id=sys.argv[2],
                           space_id=sys.argv[3], _lock_key=None)
acquired = CloudflareChatAdapter._acquire_lock(instance)
CloudflareChatAdapter._release_lock(instance)
print(json.dumps({"acquired": acquired, "key": instance._lock_key}))
"""
        try:
            result = await asyncio.to_thread(
                subprocess.run,
                [sys.executable, "-c", script, adapter.relay_url, adapter.agent_id, adapter.space_id],
                capture_output=True, text=True, timeout=15, check=True,
                env={**os.environ, "HERMES_HOME": str(self.user / "other-home")})
            self.assertEqual(json.loads(result.stdout), {"acquired": False, "key": None})
            self.assertEqual(lock_path.read_bytes(), original)
        finally:
            release_scoped_lock("cloudflare_chat", identity)
        self.assertFalse(lock_path.exists())

    async def test_standalone_cron_uses_profile_and_never_opens_socket(self):
        adapter = self.load()
        module = sys.modules[type(adapter).__module__]
        encrypted = []
        def publish(self, envelope):
            encrypted.append(envelope)
            return {"seq":700}
        with patch.object(type(adapter), "_publish_message", publish), \
             patch.object(module, "websocket_connect", side_effect=AssertionError("cron opened socket")):
            result = await module._standalone_send(adapter.config, "default", "cron result")
            self.assertTrue(result["success"])
            self.assertEqual(adapter._cipher.decrypt_message(encrypted[0], expected_sender="agent")["text"], "cron result")
            result = await module._standalone_send(adapter.config, "personal", "must not send")
            self.assertIn("cannot cross profiles", result["error"])
            self.assertEqual(len(encrypted), 1)

    async def test_canonical_gateway_busy_fifo_and_encrypted_delivery(self):
        """Use the real SQLite session authority, replacing only model execution and transport."""
        from gateway.config import GatewayConfig
        from gateway.run import GatewayRunner
        from gateway.session_authority import initialize_session_authority
        from hermes_state_runtime import list_session_admissions
        import gateway.session_finite as finite

        adapter = self.load()
        config = GatewayConfig(multiplex_profiles=True)
        config._runtime_profile_homes = [("default", self.home)]
        runner = GatewayRunner(config)
        adapter.gateway_runner = runner
        runner.adapters = {adapter.platform: adapter}
        authority = await initialize_session_authority(
            runner, profile_id=str(self.home), instance_id="offline-cloudflare-canonical")
        runner._wire_adapter_handlers(adapter)
        relay = await self.connect(adapter)
        gate, started = asyncio.Event(), asyncio.Event()
        seen = []

        def statuses():
            return {row["payload"]["text"]: row["status"]
                for sid in authority.sessions
                for row in list_session_admissions(authority.db, session_id=sid, pending_only=False)}

        async def produce(owner, ref, row):
            text = row["payload"]["text"]
            seen.append(text)
            if text == "canonical-first":
                started.set()
                await gate.wait()
            return "canonical-reply:" + text

        try:
            with patch.object(finite, "execute_finite_admission", side_effect=produce):
                await self.inbound(adapter, relay, "canonical-first", 1)
                await asyncio.wait_for(started.wait(), 8)
                await asyncio.wait_for(self.inbound(adapter, relay, "canonical-second", 2), 3)
                await until(lambda: statuses().get("canonical-second") == "queued")
                self.assertEqual(statuses()["canonical-first"], "started")
                self.assertEqual(self.payloads(adapter, relay), [])
                gate.set()
                await until(lambda: statuses().get("canonical-second") == "terminal")
                await until(lambda: len(self.payloads(adapter, relay)) == 2 and not adapter._background_tasks)
                self.assertEqual([p["text"] for p in self.payloads(adapter, relay)],
                    ["canonical-reply:canonical-first", "canonical-reply:canonical-second"])
                self.assertEqual(seen, ["canonical-first", "canonical-second"])
                self.assertFalse(adapter._pending_acks)
                for session_id in authority.sessions:
                    rows = list_session_admissions(authority.db, session_id=session_id, pending_only=False)
                    self.assertEqual(len(rows), 2)
                    for row in rows:
                        self.assertNotIn("_cloudflare_chat_typing_epoch", json.dumps(row["payload"]))
                self.assertFalse([frame for frame in relay.sent if frame["type"] == "typing"][-1]["active"])
        finally:
            gate.set()
            await adapter.cancel_background_tasks()
            drains = [session.task for session in authority.sessions.values() if session.task]
            if drains:
                await asyncio.gather(*drains, return_exceptions=True)
            runner.close_all_session_db_handles()
            from hermes_state_registry import close_all_under
            close_all_under(self.home)


if __name__ == "__main__":
    sandbox = Path(os.environ["HERMES_HOME"]).resolve()
    assert str(sandbox).startswith(("/private/tmp/", "/tmp/")), "temporary HERMES_HOME required"
    sandbox.mkdir(parents=True, exist_ok=True)
    def network_guard(event, args):
        if event == "socket.connect":
            address = args[1]
            if isinstance(address, tuple) and address[0] not in {"127.0.0.1", "::1"}:
                raise RuntimeError("Audit forbids external network connections")
        if event == "socket.getaddrinfo" and args[0] not in {None, "localhost", "127.0.0.1", "::1"}:
            raise RuntimeError("Audit forbids external DNS lookups")
    sys.addaudithook(network_guard)
    with patch.object(Path, "home", return_value=sandbox.parent):
        from agent.secret_scope import set_multiplex_active
        from gateway.config import PlatformConfig
        from gateway.platform_registry import platform_registry
        from gateway.platforms.base import BasePlatformAdapter, MessageEvent, MessageType
        from gateway.run import _profile_runtime_scope
        from hermes_cli.plugins import PluginManager
        unittest.main(verbosity=2)
