import base64
import asyncio
import dataclasses
import enum
import importlib
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from io import BytesIO
from pathlib import Path
from urllib.error import HTTPError
from unittest.mock import AsyncMock, call, patch


def install_hermes_stubs():
    agent = types.ModuleType("agent")
    secret_scope = types.ModuleType("agent.secret_scope")

    class UnscopedSecretError(Exception):
        pass

    secret_scope.UnscopedSecretError = UnscopedSecretError
    secret_scope.get_secret = lambda name, default="": os.getenv(name, default)
    agent.secret_scope = secret_scope

    gateway = types.ModuleType("gateway")
    config = types.ModuleType("gateway.config")
    config.Platform = lambda value: value
    platforms = types.ModuleType("gateway.platforms")
    base = types.ModuleType("gateway.platforms.base")

    class BasePlatformAdapter:
        def __init__(self, config, platform):
            self.config = config
            self.platform = platform
            self.resumed_typing_chats = []

        async def handle_message(self, event):
            return None

        async def send_clarify(
            self,
            chat_id,
            question,
            choices,
            clarify_id,
            session_key,
            metadata=None,
        ):
            return SendResult(success=False, error="text fallback")

        def resume_typing_for_chat(self, chat_id):
            self.resumed_typing_chats.append(chat_id)

        @staticmethod
        def validate_media_delivery_path(path):
            candidate = Path(path).expanduser().resolve()
            return str(candidate) if candidate.is_file() else None

        @staticmethod
        def build_source(**kwargs):
            return kwargs

    class MessageType(enum.Enum):
        TEXT = "text"
        PHOTO = "photo"
        VOICE = "voice"
        VIDEO = "video"
        DOCUMENT = "document"

    @dataclasses.dataclass
    class MessageEvent:
        text: str
        message_type: MessageType | None = None
        user_id: str = ""
        user_name: str = ""
        source: dict | None = None
        message_id: str = ""
        media_urls: list[str] | None = None
        media_types: list[str] | None = None
        raw_message: dict | None = None

    @dataclasses.dataclass
    class SendResult:
        success: bool
        message_id: str | None = None
        error: str | None = None
        retryable: bool = False

    async def cache_image_from_url(url):
        return url

    base.BasePlatformAdapter = BasePlatformAdapter
    base.MessageEvent = MessageEvent
    base.MessageType = MessageType
    base.SendResult = SendResult
    base.cache_image_from_url = cache_image_from_url
    platforms.base = base
    gateway.config = config
    gateway.platforms = platforms

    hermes_constants = types.ModuleType("hermes_constants")
    hermes_constants.get_hermes_home = lambda: __import__("pathlib").Path.home() / ".hermes"

    sys.modules.update({
        "agent": agent,
        "agent.secret_scope": secret_scope,
        "gateway": gateway,
        "gateway.config": config,
        "gateway.platforms": platforms,
        "gateway.platforms.base": base,
        "hermes_constants": hermes_constants,
    })


class AdapterContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        install_hermes_stubs()
        cls.adapter = importlib.import_module("cloudflare_chat.adapter")

    def setUp(self):
        self.previous = dict(os.environ)
        key = base64.urlsafe_b64encode(bytes(range(32))).decode("ascii").rstrip("=")
        os.environ.update({
            "HERMES_CF_RELAY_URL": "wss://h.superstar1014.qzz.io/api/hermes-chat/ws",
            "HERMES_CF_AGENT_SECRET": "a" * 48,
            "HERMES_CF_CHAT_KEY": key,
            "HERMES_CF_SPACE_ID": "primary",
            "HERMES_CF_ALLOWED_USERS": "android-owner",
        })

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.previous)

    def test_requirements_accept_the_production_contract(self):
        self.assertTrue(self.adapter.check_requirements())

    def test_register_exposes_fail_closed_user_authorization(self):
        class Context:
            kwargs = None

            def register_platform(self, **kwargs):
                self.kwargs = kwargs

        context = Context()
        self.adapter.register(context)

        self.assertEqual(context.kwargs["name"], "cloudflare_chat")
        self.assertEqual(context.kwargs["allowed_users_env"], "HERMES_CF_ALLOWED_USERS")
        self.assertEqual(context.kwargs["allow_all_env"], "HERMES_CF_ALLOW_ALL_USERS")
        self.assertIs(context.kwargs["standalone_sender_fn"], self.adapter._standalone_send)
        self.assertIn("HERMES_CF_CHAT_KEY", context.kwargs["required_env"])
        self.assertIn("HERMES_CF_SPACE_ID", context.kwargs["required_env"])
        platform_hint = context.kwargs["platform_hint"]
        self.assertIn("image_generate", platform_hint)
        self.assertIn("MEDIA:<absolute-path>", platform_hint)
        self.assertIn("agent_visible_image", platform_hint)
        self.assertIn("fenced code blocks", platform_hint)
        self.assertIn("documents", platform_hint)

    def test_attachment_requests_use_explicit_application_user_agent(self):
        instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))

        headers = instance._http_headers()

        self.assertEqual(headers["User-Agent"], "Hermes-Cloudflare-Chat/0.3.0")
        self.assertEqual(headers["Accept"], "application/json")
        self.assertNotIn("Python-urllib", headers["User-Agent"])

    def test_attachment_http_error_keeps_cloudflare_diagnostics(self):
        error = HTTPError(
            "https://h.superstar1014.qzz.io/api/hermes-chat/attachments/test",
            403,
            "Forbidden",
            {"CF-Ray": "test-ray-TPE"},
            BytesIO(b"error code: 1010"),
        )

        result = self.adapter._attachment_http_error("upload", error)
        error.close()

        self.assertIsInstance(result, ConnectionError)
        self.assertIn("HTTP 403", str(result))
        self.assertIn("error code: 1010", str(result))
        self.assertIn("test-ray-TPE", str(result))

    def test_message_publish_uses_agent_authenticated_https_endpoint(self):
        instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
        envelope = instance._cipher.encrypt_message(
            sender="agent",
            text="cron result",
        )
        captured = {}

        class Response:
            status = 201

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _limit):
                return json.dumps({
                    "ok": True,
                    "ack": {
                        "v": 1,
                        "type": "ack",
                        "id": envelope["id"],
                        "seq": 70,
                        "duplicate": False,
                    },
                }).encode("utf-8")

        def open_request(request, timeout):
            captured.update({"request": request, "timeout": timeout})
            return Response()

        with patch.object(self.adapter, "urlopen", side_effect=open_request):
            ack = instance._publish_message(envelope)

        request = captured["request"]
        self.assertEqual(request.full_url, "https://h.superstar1014.qzz.io/api/hermes-chat/messages")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Authorization"), "Bearer " + "a" * 48)
        self.assertEqual(request.get_header("X-hermes-space"), "primary")
        self.assertEqual(captured["timeout"], 30)
        self.assertEqual(ack["seq"], 70)

    def test_standalone_cron_send_publishes_to_the_matching_profile_without_websocket(self):
        published = []

        def publish(instance, envelope):
            published.append((instance.space_id, envelope))
            return {
                "v": 1,
                "type": "ack",
                "id": envelope["id"],
                "seq": 71,
                "duplicate": False,
            }

        with patch.object(
            self.adapter.CloudflareChatAdapter,
            "_publish_message",
            autospec=True,
            side_effect=publish,
        ):
            result = asyncio.run(self.adapter._standalone_send(
                types.SimpleNamespace(extra={}),
                "primary",
                "定时任务完成",
            ))

        self.assertEqual(result, {"success": True, "message_id": "71"})
        self.assertEqual(published[0][0], "primary")
        payload = self.adapter.CloudflareChatAdapter(
            types.SimpleNamespace(extra={})
        )._cipher.decrypt_message(published[0][1], expected_sender="agent")
        self.assertEqual(payload["text"], "定时任务完成")
        self.assertEqual(payload["attachments"], [])

    def test_standalone_cron_send_refuses_cross_profile_delivery(self):
        with patch.object(
            self.adapter.CloudflareChatAdapter,
            "_publish_message",
        ) as publish:
            result = asyncio.run(self.adapter._standalone_send(
                types.SimpleNamespace(extra={}),
                "personal",
                "不应跨 profile",
            ))

        self.assertIn("cannot cross profiles", result["error"])
        publish.assert_not_called()

    def test_standalone_cron_send_encrypts_explicit_media_files(self):
        with tempfile.TemporaryDirectory() as directory:
            document = Path(directory) / "daily-report.pdf"
            document.write_bytes(b"%PDF-1.7\ncron report\n")
            published = []

            def publish(instance, envelope):
                published.append((instance, envelope))
                return {
                    "v": 1,
                    "type": "ack",
                    "id": envelope["id"],
                    "seq": 72,
                    "duplicate": False,
                }

            with patch.object(
                self.adapter.CloudflareChatAdapter,
                "_upload_attachment",
            ) as upload, patch.object(
                self.adapter.CloudflareChatAdapter,
                "_publish_message",
                autospec=True,
                side_effect=publish,
            ):
                result = asyncio.run(self.adapter._standalone_send(
                    types.SimpleNamespace(extra={}),
                    "primary",
                    "日报附件",
                    media_files=[(str(document), False)],
                ))

        self.assertEqual(result, {"success": True, "message_id": "72"})
        upload.assert_called_once()
        instance, envelope = published[0]
        payload = instance._cipher.decrypt_message(envelope, expected_sender="agent")
        self.assertEqual(payload["text"], "日报附件")
        self.assertEqual(payload["attachments"][0]["name"], "daily-report.pdf")
        self.assertEqual(payload["attachments"][0]["contentType"], "application/pdf")

    def test_edit_message_sends_encrypted_update_and_keeps_original_message_id(self):
        instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
        sent_frames = []

        async def send_frame(frame):
            sent_frames.append(frame)
            await instance._handle_frame(json.dumps({
                "v": 1,
                "type": "ack",
                "id": frame["message"]["id"],
                "seq": 43,
                "targetSeq": 42,
                "final": True,
            }))

        with patch.object(instance, "_send_frame", side_effect=send_frame):
            result = asyncio.run(instance.edit_message(
                chat_id="primary",
                message_id="42",
                content="完整的流式回复",
                finalize=True,
            ))

        self.assertTrue(result.success)
        self.assertEqual(result.message_id, "42")
        self.assertEqual(len(sent_frames), 1)
        frame = sent_frames[0]
        self.assertEqual(frame["type"], "edit")
        self.assertEqual(frame["targetSeq"], 42)
        self.assertIs(frame["final"], True)
        payload = instance._cipher.decrypt_message(
            frame["message"],
            expected_sender="agent",
        )
        self.assertEqual(payload["text"], "完整的流式回复")
        self.assertEqual(payload["replaceSeq"], 42)
        self.assertIs(payload["final"], True)

    def test_model_picker_is_encrypted_and_resolves_without_chat_dispatch(self):
        instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
        sent_frames = []
        selected = []

        async def send_frame(frame):
            sent_frames.append(frame)
            envelope = frame["message"] if frame.get("type") == "edit" else frame
            await instance._handle_frame(json.dumps({
                "v": 1,
                "type": "ack",
                "id": envelope["id"],
                "seq": 40 + len(sent_frames),
            }))

        async def on_model_selected(chat_id, model_id, provider_slug):
            selected.append((chat_id, model_id, provider_slug))
            return "模型已切换到 deepseek-v4-flash"

        async def click(prompt_id, option_id, message_id):
            message = instance._cipher.encrypt_message(
                sender="client",
                text="",
                interaction_response={
                    "promptId": prompt_id,
                    "optionId": option_id,
                },
                message_id=message_id,
                sent_at=1_800_000_000_000,
            )
            await instance._handle_frame(json.dumps({
                "v": 1,
                "type": "action",
                "userId": "authenticated-notes-owner",
                "message": message,
            }))
            tasks = list(instance._interaction_tasks)
            if tasks:
                await asyncio.gather(*tasks)

        async def scenario():
            with patch.object(instance, "_send_frame", side_effect=send_frame), patch.object(
                instance,
                "handle_message",
                AsyncMock(),
            ) as handle_message:
                result = await instance.send_model_picker(
                    chat_id="primary",
                    providers=[{
                        "slug": "deepseek",
                        "name": "DeepSeek",
                        "models": ["deepseek-v4-flash"],
                        "is_current": True,
                    }],
                    current_model="deepseek-v4-flash",
                    current_provider="deepseek",
                    session_key="session-primary",
                    on_model_selected=on_model_selected,
                )
                self.assertTrue(result.success)
                prompt_id = next(iter(instance._pending_interactions))
                await click(
                    prompt_id,
                    "p0",
                    "550e8400-e29b-41d4-a716-446655440030",
                )
                self.assertEqual(instance._pending_interactions[prompt_id]["stage"], "models")
                await click(
                    prompt_id,
                    "m0",
                    "550e8400-e29b-41d4-a716-446655440031",
                )
                handle_message.assert_not_awaited()

        asyncio.run(scenario())

        self.assertEqual(selected, [("primary", "deepseek-v4-flash", "deepseek")])
        self.assertEqual(instance._pending_interactions, {})
        self.assertEqual([frame.get("type") for frame in sent_frames], ["message", "edit", "edit"])
        self.assertNotIn("DeepSeek", json.dumps(sent_frames[0]))
        initial = instance._cipher.decrypt_message(sent_frames[0], expected_sender="agent")
        provider_view = instance._cipher.decrypt_message(
            sent_frames[1]["message"],
            expected_sender="agent",
        )
        resolved = instance._cipher.decrypt_message(
            sent_frames[2]["message"],
            expected_sender="agent",
        )
        self.assertEqual(initial["interaction"]["kind"], "model")
        self.assertEqual(initial["interaction"]["stage"], "providers")
        self.assertEqual(provider_view["interaction"]["stage"], "models")
        self.assertEqual(resolved["interaction"]["state"], "resolved")
        self.assertEqual(resolved["interaction"]["options"], [])

    def test_exec_approval_button_resolves_gateway_primitive_once(self):
        instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
        sent_frames = []
        resolved = []
        tools_module = types.ModuleType("tools")
        approval_module = types.ModuleType("tools.approval")

        def resolve_gateway_approval(session_key, choice):
            resolved.append((session_key, choice))
            return 1

        approval_module.resolve_gateway_approval = resolve_gateway_approval
        tools_module.approval = approval_module

        async def send_frame(frame):
            sent_frames.append(frame)
            envelope = frame["message"] if frame.get("type") == "edit" else frame
            await instance._handle_frame(json.dumps({
                "v": 1,
                "type": "ack",
                "id": envelope["id"],
                "seq": 50 + len(sent_frames),
            }))

        async def scenario():
            with patch.dict(sys.modules, {
                "tools": tools_module,
                "tools.approval": approval_module,
            }), patch.object(instance, "_send_frame", side_effect=send_frame):
                result = await instance.send_exec_approval(
                    chat_id="primary",
                    command="touch /tmp/approved",
                    session_key="approval-session",
                )
                self.assertTrue(result.success)
                prompt_id = next(iter(instance._pending_interactions))
                action = instance._cipher.encrypt_message(
                    sender="client",
                    text="",
                    interaction_response={
                        "promptId": prompt_id,
                        "optionId": "once",
                    },
                    message_id="550e8400-e29b-41d4-a716-446655440032",
                    sent_at=1_800_000_000_001,
                )
                await instance._handle_frame(json.dumps({
                    "v": 1,
                    "type": "action",
                    "userId": "authenticated-notes-owner",
                    "message": action,
                }))
                tasks = list(instance._interaction_tasks)
                if tasks:
                    await asyncio.gather(*tasks)

        asyncio.run(scenario())

        self.assertEqual(resolved, [("approval-session", "once")])
        self.assertEqual(instance.resumed_typing_chats, ["primary"])
        self.assertEqual(instance._pending_interactions, {})
        final_payload = instance._cipher.decrypt_message(
            sent_frames[-1]["message"],
            expected_sender="agent",
        )
        self.assertEqual(final_payload["interaction"]["state"], "resolved")
        self.assertEqual(final_payload["interaction"]["status"], "已批准：仅本次")

    def test_interaction_callback_does_not_block_the_websocket_receive_loop(self):
        instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
        started = asyncio.Event()
        release = asyncio.Event()

        async def handle_response(_response, *, relay_user):
            self.assertEqual(relay_user, "authenticated-notes-owner")
            started.set()
            await release.wait()

        async def scenario():
            action = instance._cipher.encrypt_message(
                sender="client",
                text="",
                interaction_response={
                    "promptId": "550e8400-e29b-41d4-a716-446655440040",
                    "optionId": "once",
                },
                message_id="550e8400-e29b-41d4-a716-446655440041",
                sent_at=1_800_000_000_002,
            )
            with patch.object(
                instance,
                "_handle_interaction_response",
                side_effect=handle_response,
            ):
                await asyncio.wait_for(instance._handle_frame(json.dumps({
                    "v": 1,
                    "type": "action",
                    "userId": "authenticated-notes-owner",
                    "message": action,
                })), timeout=0.2)
                await asyncio.wait_for(started.wait(), timeout=0.2)
                self.assertEqual(len(instance._interaction_tasks), 1)
                release.set()
                await asyncio.gather(*list(instance._interaction_tasks))

        asyncio.run(scenario())
        self.assertEqual(instance._interaction_tasks, set())

    def test_multi_select_clarify_keeps_the_official_text_fallback(self):
        instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
        tools_module = types.ModuleType("tools")
        clarify_module = types.ModuleType("tools.clarify_gateway")
        clarify_module._lock = threading.Lock()
        clarify_module._entries = {
            "clarify-multi": types.SimpleNamespace(multi_select=True),
        }
        tools_module.clarify_gateway = clarify_module

        with patch.dict(sys.modules, {
            "tools": tools_module,
            "tools.clarify_gateway": clarify_module,
        }):
            result = asyncio.run(instance.send_clarify(
                chat_id="primary",
                question="请选择多个项目",
                choices=["A", "B", "C"],
                clarify_id="clarify-multi",
                session_key="session-primary",
            ))

        self.assertFalse(result.success)
        self.assertEqual(result.error, "text fallback")
        self.assertEqual(instance._pending_interactions, {})

    def test_resume_sequence_is_scoped_and_persisted_per_profile(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            self.adapter,
            "get_hermes_home",
            return_value=Path(directory),
        ):
            config = types.SimpleNamespace(extra={})
            first = self.adapter.CloudflareChatAdapter(config)
            first._last_sequence = 42
            first._save_last_sequence()
            second = self.adapter.CloudflareChatAdapter(config)
            self.assertEqual(second._last_sequence, 42)
            self.assertIn("primary", str(second._state_path))

    def test_inbound_message_announces_typing_before_gateway_dispatch(self):
        instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
        event = types.SimpleNamespace(media_urls=[])
        order = []

        async def send_frame(frame):
            order.append(("frame", frame["type"], frame.get("active")))

        async def handle_message(received_event):
            order.append(("handle", received_event, None))

        with patch.object(
            instance,
            "_prepare_inbound_message",
            AsyncMock(return_value=event),
        ), patch.object(
            instance,
            "_save_last_sequence",
        ), patch.object(
            instance,
            "_send_frame",
            side_effect=send_frame,
        ), patch.object(
            instance,
            "handle_message",
            side_effect=handle_message,
        ):
            asyncio.run(instance._handle_frame(json.dumps({
                "v": 1,
                "type": "message",
                "seq": 1,
                "message": {"id": "client-message-1"},
            })))

        self.assertEqual(order, [
            ("frame", "typing", True),
            ("handle", event, None),
            ("frame", "received", None),
        ])

    def test_local_image_is_encrypted_uploaded_and_sent_as_attachment(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            self.adapter,
            "get_hermes_home",
            return_value=Path(directory),
        ):
            image_path = Path(directory) / "generated-image.png"
            image_bytes = b"\x89PNG\r\n\x1a\n" + b"test-image-payload"
            image_path.write_bytes(image_bytes)
            instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
            send_payload = AsyncMock(
                return_value=self.adapter.SendResult(success=True, message_id="43")
            )

            with patch.object(instance, "_upload_attachment") as upload, patch.object(
                instance,
                "_send_payload",
                send_payload,
            ):
                result = asyncio.run(instance.send_image_file(
                    chat_id="primary",
                    image_path=str(image_path),
                    caption="生成的图片",
                ))

            self.assertTrue(result.success)
            upload.assert_called_once()
            attachment_id, ciphertext = upload.call_args.args
            sent_text, attachments = send_payload.await_args.args
            self.assertEqual(sent_text, "生成的图片")
            self.assertEqual(len(attachments), 1)
            descriptor = attachments[0]
            self.assertEqual(descriptor["id"], attachment_id)
            self.assertEqual(descriptor["contentType"], "image/png")
            self.assertEqual(
                instance._cipher.decrypt_attachment(ciphertext, descriptor),
                image_bytes,
            )

    def test_document_is_encrypted_uploaded_and_sent_as_attachment(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            self.adapter,
            "get_hermes_home",
            return_value=Path(directory),
        ):
            document_path = Path(directory) / "report.pdf"
            document_bytes = b"%PDF-1.7\nprivate report\n"
            document_path.write_bytes(document_bytes)
            instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
            send_payload = AsyncMock(
                return_value=self.adapter.SendResult(success=True, message_id="48")
            )

            with patch.object(instance, "_upload_attachment") as upload, patch.object(
                instance,
                "_send_payload",
                send_payload,
            ):
                result = asyncio.run(instance.send_document(
                    chat_id="primary",
                    file_path=str(document_path),
                    caption="检查报告",
                ))

            self.assertTrue(result.success)
            attachment_id, ciphertext = upload.call_args.args
            sent_text, attachments = send_payload.await_args.args
            self.assertEqual(sent_text, "检查报告")
            descriptor = attachments[0]
            self.assertEqual(descriptor["id"], attachment_id)
            self.assertEqual(descriptor["contentType"], "application/pdf")
            self.assertEqual(
                instance._cipher.decrypt_attachment(ciphertext, descriptor),
                document_bytes,
            )

    def test_large_agent_file_uses_streaming_private_r2_upload(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            self.adapter,
            "get_hermes_home",
            return_value=Path(directory),
        ):
            video_path = Path(directory) / "generated.mp4"
            video_bytes = b"v" * (10 * 1024 * 1024 + 1)
            video_path.write_bytes(video_bytes)
            instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
            attachment_id = "550e8400-e29b-41d4-a716-446655440099"
            sha256 = __import__("hashlib").sha256(video_bytes).hexdigest()
            captured = []

            class Response:
                def __init__(self, status, payload=b""):
                    self.status = status
                    self.payload = payload

                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    return False

                def read(self, limit=-1):
                    return self.payload if limit < 0 else self.payload[:limit]

            def open_request(request, timeout):
                captured.append((request, timeout))
                if request.get_method() == "PUT":
                    self.assertNotIn("Authorization", request.headers)
                    self.assertEqual(request.get_header("Content-length"), str(len(video_bytes)))
                    self.assertEqual(sum(len(chunk) for chunk in request.data), len(video_bytes))
                    return Response(200)
                payload = json.loads(request.data.decode("utf-8"))
                self.assertEqual(payload["plaintextBytes"], len(video_bytes))
                if request.full_url.endswith("/complete"):
                    return Response(200, json.dumps({
                        "attachment": {
                            "id": attachment_id,
                            "storage": "r2-private-v1",
                            "plaintextBytes": len(video_bytes),
                            "sha256": sha256,
                        },
                    }).encode("utf-8"))
                payload["attachmentId"] = attachment_id
                return Response(201, json.dumps({
                    "ticket": {
                        "attachmentId": attachment_id,
                        "storage": "r2-private-v1",
                        "plaintextBytes": len(video_bytes),
                        "sha256": sha256,
                        "uploadUrl": "https://test.r2.cloudflarestorage.com/notes/object?signature=1",
                        "requiredHeaders": {
                            "Content-Type": "application/octet-stream",
                            "If-None-Match": "*",
                            "x-amz-checksum-sha256": "test-checksum",
                        },
                    },
                }).encode("utf-8"))

            with patch.object(self.adapter.uuid, "uuid4", return_value=attachment_id), patch.object(
                self.adapter,
                "urlopen",
                side_effect=open_request,
            ):
                descriptor = asyncio.run(instance._encrypt_and_upload_local_file(
                    str(video_path),
                    file_name=None,
                    allowed_categories={"video"},
                ))

        self.assertEqual(descriptor, {
            "id": attachment_id,
            "name": "generated.mp4",
            "contentType": "video/mp4",
            "plaintextBytes": len(video_bytes),
            "storage": "r2-private-v1",
            "sha256": sha256,
        })
        self.assertEqual([request.get_method() for request, _ in captured], ["POST", "PUT", "POST"])

    def test_failed_message_publish_preserves_confirmed_private_objects(self):
        instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
        descriptor = {
            "id": "550e8400-e29b-41d4-a716-446655440099",
            "name": "generated.mp4",
            "contentType": "video/mp4",
            "plaintextBytes": 10 * 1024 * 1024 + 1,
            "storage": "r2-private-v1",
            "sha256": "ab" * 32,
        }
        with patch.object(
            instance,
            "_send_and_wait_for_ack",
            AsyncMock(side_effect=ConnectionError("socket closed")),
        ), patch.object(instance, "_cancel_direct_attachment") as cancel:
            result = asyncio.run(instance._send_payload("video", [descriptor]))

        self.assertFalse(result.success)
        cancel.assert_not_called()

    def test_failed_direct_upload_cancels_unconfirmed_private_object(self):
        instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
        attachment_id = "550e8400-e29b-41d4-a716-446655440099"
        payload = b"generated-video"
        sha256 = __import__("hashlib").sha256(payload).hexdigest()
        ticket = {
            "ticket": {
                "attachmentId": attachment_id,
                "storage": "r2-private-v1",
                "plaintextBytes": len(payload),
                "sha256": sha256,
                "uploadUrl": "https://test.r2.cloudflarestorage.com/notes/object?signature=1",
                "requiredHeaders": {"Content-Type": "application/octet-stream"},
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "generated.mp4"
            path.write_bytes(payload)
            with patch.object(self.adapter.uuid, "uuid4", return_value=attachment_id), patch.object(
                instance,
                "_direct_upload_json",
                return_value=ticket,
            ), patch.object(
                self.adapter,
                "urlopen",
                side_effect=ConnectionError("upload failed"),
            ), patch.object(instance, "_cancel_direct_attachment") as cancel:
                with self.assertRaisesRegex(ConnectionError, "upload failed"):
                    instance._upload_direct_file(
                        path,
                        plaintext_bytes=len(payload),
                        content_type="video/mp4",
                        filename=path.name,
                    )

        cancel.assert_called_once_with(attachment_id)

    def test_voice_and_video_use_their_platform_delivery_methods(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            self.adapter,
            "get_hermes_home",
            return_value=Path(directory),
        ):
            instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
            for method_name, filename, expected_type in (
                ("send_voice", "reply.mp3", "audio/mpeg"),
                ("send_video", "walkthrough.mp4", "video/mp4"),
            ):
                with self.subTest(method=method_name):
                    path = Path(directory) / filename
                    path.write_bytes((method_name + "-payload").encode("utf-8"))
                    send_payload = AsyncMock(
                        return_value=self.adapter.SendResult(success=True, message_id="49")
                    )
                    with patch.object(instance, "_upload_attachment") as upload, patch.object(
                        instance,
                        "_send_payload",
                        send_payload,
                    ):
                        result = asyncio.run(getattr(instance, method_name)(
                            chat_id="primary",
                            **({"audio_path": str(path)} if method_name == "send_voice"
                               else {"video_path": str(path)}),
                        ))
                    self.assertTrue(result.success)
                    self.assertEqual(
                        send_payload.await_args.args[1][0]["contentType"],
                        expected_type,
                    )
                    upload.assert_called_once()

    def test_unsupported_executable_is_not_uploaded(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            self.adapter,
            "get_hermes_home",
            return_value=Path(directory),
        ):
            executable = Path(directory) / "unsafe.exe"
            executable.write_bytes(b"MZ-not-delivered")
            instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
            with patch.object(instance, "_upload_attachment") as upload:
                result = asyncio.run(instance.send_file(
                    chat_id="primary",
                    file_path=str(executable),
                ))

            self.assertFalse(result.success)
            self.assertIn("unsupported attachment format", result.error)
            upload.assert_not_called()

    def test_inbound_document_is_dispatched_as_document_message(self):
        instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
        envelope = instance._cipher.encrypt_message(
            sender="client",
            text="请分析附件",
            attachments=[{
                "id": "00000000-0000-4000-8000-000000000001",
                "name": "report.pdf",
                "contentType": "application/pdf",
                "plaintextBytes": 8,
                "nonce": "AAAAAAAAAAAAAAAA",
            }],
        )
        with patch.object(
            instance,
            "_download_and_decrypt_attachment",
            AsyncMock(return_value=(Path("/tmp/report.pdf"), "application/pdf", "document")),
        ):
            event = asyncio.run(instance._prepare_inbound_message(envelope))

        self.assertEqual(event.message_type, self.adapter.MessageType.DOCUMENT)
        self.assertEqual(event.media_types, ["application/pdf"])
        self.assertEqual(event.text, "请分析附件")
        self.assertEqual(
            self.adapter._message_type_for_categories(["audio"]),
            self.adapter.MessageType.VOICE,
        )
        self.assertEqual(
            self.adapter._message_type_for_categories(["video"]),
            self.adapter.MessageType.VIDEO,
        )

    def test_send_recovers_extensionless_markdown_image_as_attachment(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            self.adapter,
            "get_hermes_home",
            return_value=Path(directory),
        ):
            image_path = Path(directory) / "cached-image.png"
            image_path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"remote-image")
            instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
            send_payload = AsyncMock(
                return_value=self.adapter.SendResult(success=True, message_id="44")
            )

            with patch.object(
                self.adapter,
                "cache_image_from_url",
                AsyncMock(return_value=str(image_path)),
            ) as cache_image, patch.object(
                instance,
                "_upload_attachment",
            ) as upload, patch.object(
                instance,
                "_send_payload",
                send_payload,
            ):
                result = asyncio.run(instance.send(
                    chat_id="primary",
                    content=(
                        "图片如下：\n"
                        "![生成图](https://images.example.test/render?id=42)"
                    ),
                ))

            self.assertTrue(result.success)
            cache_image.assert_awaited_once_with(
                "https://images.example.test/render?id=42"
            )
            upload.assert_called_once()
            sent_text, attachments = send_payload.await_args.args
            self.assertEqual(sent_text, "图片如下：")
            self.assertEqual(len(attachments), 1)

    def test_send_recovers_local_media_directive_as_attachment(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            self.adapter,
            "get_hermes_home",
            return_value=Path(directory),
        ):
            image_path = Path(directory) / "generated chart.png"
            image_path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"local-media")
            instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
            send_payload = AsyncMock(
                return_value=self.adapter.SendResult(success=True, message_id="45")
            )

            with patch.object(instance, "_upload_attachment") as upload, patch.object(
                instance,
                "_send_payload",
                send_payload,
            ):
                result = asyncio.run(instance.send(
                    chat_id="primary",
                    content=f"已生成图片。\nMEDIA:`{image_path}`",
                ))

            self.assertTrue(result.success)
            upload.assert_called_once()
            sent_text, attachments = send_payload.await_args.args
            self.assertEqual(sent_text, "已生成图片。")
            self.assertEqual(len(attachments), 1)

    def test_send_preserves_inline_image_markup_when_upload_fails(self):
        instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
        content = "图片：![预览](https://images.example.test/render?id=failed)"
        send_payload = AsyncMock(
            return_value=self.adapter.SendResult(success=True, message_id="46")
        )

        with patch.object(
            instance,
            "_encrypt_and_upload_image",
            AsyncMock(side_effect=ConnectionError("upload failed")),
        ), patch.object(instance, "_send_payload", send_payload):
            result = asyncio.run(instance.send(chat_id="primary", content=content))

        self.assertTrue(result.success)
        send_payload.assert_awaited_once_with(content, [])

    def test_send_never_reads_inline_local_image_that_fails_hermes_validation(self):
        instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
        content = "MEDIA:/root/private-image.png"
        send_payload = AsyncMock(
            return_value=self.adapter.SendResult(success=True, message_id="47")
        )

        with patch.object(
            instance,
            "validate_media_delivery_path",
            return_value=None,
        ) as validate_path, patch.object(
            instance,
            "_read_outbound_image",
        ) as read_image, patch.object(instance, "_send_payload", send_payload):
            result = asyncio.run(instance.send(chat_id="primary", content=content))

        self.assertTrue(result.success)
        validate_path.assert_called_once_with("/root/private-image.png")
        read_image.assert_not_called()
        send_payload.assert_awaited_once_with(content, [])

    def test_duplicate_and_out_of_order_sequences_are_not_dispatched(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            self.adapter,
            "get_hermes_home",
            return_value=Path(directory),
        ):
            instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
            instance._last_sequence = 42
            with patch.object(
                instance,
                "_prepare_inbound_message",
            ) as prepare_inbound, patch.object(instance, "_save_last_sequence") as save:
                asyncio.run(instance._handle_frame(json.dumps({
                    "v": 1,
                    "type": "message",
                    "seq": 42,
                    "message": {"id": "duplicate"},
                })))
                asyncio.run(instance._handle_frame(json.dumps({
                    "v": 1,
                    "type": "message",
                    "seq": 41,
                    "message": {"id": "out-of-order"},
                })))

            prepare_inbound.assert_not_called()
            save.assert_not_called()
            self.assertEqual(instance._last_sequence, 42)

    def test_new_sequence_is_checkpointed_and_confirmed_after_dispatch(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            self.adapter,
            "get_hermes_home",
            return_value=Path(directory),
        ):
            instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
            instance._last_sequence = 42
            event = types.SimpleNamespace(media_urls=["cached-image"])
            with patch.object(
                instance,
                "_prepare_inbound_message",
                AsyncMock(return_value=event),
            ) as prepare_inbound, patch.object(
                instance,
                "handle_message",
                AsyncMock(),
            ) as handle_inbound, patch.object(
                instance,
                "_send_frame",
                AsyncMock(),
            ) as send_frame, patch.object(instance, "_save_last_sequence") as save:
                asyncio.run(instance._handle_frame(json.dumps({
                    "v": 1,
                    "type": "message",
                    "seq": 43,
                    "message": {"id": "new"},
                })))

            prepare_inbound.assert_awaited_once_with({"id": "new"})
            handle_inbound.assert_awaited_once_with(event)
            save.assert_called_once_with()
            send_frame.assert_has_awaits([
                call({"v": 1, "type": "typing", "active": True}),
                call({"v": 1, "type": "received", "seq": 43}),
            ])
            self.assertEqual(send_frame.await_count, 2)
            self.assertEqual(instance._last_sequence, 43)

    def test_failed_dispatch_does_not_replay_an_already_prepared_message(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            self.adapter,
            "get_hermes_home",
            return_value=Path(directory),
        ):
            instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
            instance._last_sequence = 42
            with patch.object(
                instance,
                "_prepare_inbound_message",
                AsyncMock(return_value=types.SimpleNamespace(media_urls=[])),
            ), patch.object(
                instance,
                "handle_message",
                AsyncMock(side_effect=RuntimeError("dispatch failed")),
            ), patch.object(
                instance,
                "_send_frame",
                AsyncMock(),
            ) as send_frame, patch.object(instance, "_save_last_sequence") as save:
                with self.assertRaisesRegex(RuntimeError, "dispatch failed"):
                    asyncio.run(instance._handle_frame(json.dumps({
                        "v": 1,
                        "type": "message",
                        "seq": 43,
                        "message": {"id": "retryable"},
                    })))

            save.assert_called_once_with()
            send_frame.assert_awaited_once_with({
                "v": 1,
                "type": "typing",
                "active": True,
            })
            self.assertEqual(instance._last_sequence, 43)

    def test_checkpoint_write_failure_does_not_reconnect_or_redispatch(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            self.adapter,
            "get_hermes_home",
            return_value=Path(directory),
        ):
            instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
            instance._last_sequence = 42
            event = types.SimpleNamespace(media_urls=[])
            with patch.object(
                instance,
                "_prepare_inbound_message",
                AsyncMock(return_value=event),
            ), patch.object(
                instance,
                "handle_message",
                AsyncMock(),
            ) as handle_inbound, patch.object(
                instance,
                "_send_frame",
                AsyncMock(),
            ) as send_frame, patch.object(
                instance,
                "_save_last_sequence",
                side_effect=OSError("read-only state"),
            ):
                asyncio.run(instance._handle_frame(json.dumps({
                    "v": 1,
                    "type": "message",
                    "seq": 43,
                    "message": {"id": "checkpoint-failure"},
                })))

            handle_inbound.assert_awaited_once_with(event)
            send_frame.assert_has_awaits([
                call({"v": 1, "type": "typing", "active": True}),
                call({"v": 1, "type": "received", "seq": 43}),
            ])
            self.assertEqual(send_frame.await_count, 2)
            self.assertEqual(instance._last_sequence, 43)


if __name__ == "__main__":
    unittest.main()
