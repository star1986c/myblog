import base64
import asyncio
import dataclasses
import enum
import importlib
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


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

    class MessageType(enum.Enum):
        TEXT = "text"
        PHOTO = "photo"

    @dataclasses.dataclass
    class MessageEvent:
        text: str

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
        self.assertIn("HERMES_CF_CHAT_KEY", context.kwargs["required_env"])
        self.assertIn("HERMES_CF_SPACE_ID", context.kwargs["required_env"])

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
                "_handle_inbound_message",
            ) as handle_inbound, patch.object(instance, "_save_last_sequence") as save:
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

            handle_inbound.assert_not_called()
            save.assert_not_called()
            self.assertEqual(instance._last_sequence, 42)

    def test_new_sequence_advances_only_after_dispatch_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            self.adapter,
            "get_hermes_home",
            return_value=Path(directory),
        ):
            instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
            instance._last_sequence = 42
            with patch.object(
                instance,
                "_handle_inbound_message",
            ) as handle_inbound, patch.object(instance, "_save_last_sequence") as save:
                asyncio.run(instance._handle_frame(json.dumps({
                    "v": 1,
                    "type": "message",
                    "seq": 43,
                    "message": {"id": "new"},
                })))

            handle_inbound.assert_called_once_with({"id": "new"})
            save.assert_called_once_with()
            self.assertEqual(instance._last_sequence, 43)

    def test_failed_dispatch_keeps_sequence_available_for_replay(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            self.adapter,
            "get_hermes_home",
            return_value=Path(directory),
        ):
            instance = self.adapter.CloudflareChatAdapter(types.SimpleNamespace(extra={}))
            instance._last_sequence = 42

            async def reject(_message):
                raise RuntimeError("dispatch failed")

            with patch.object(
                instance,
                "_handle_inbound_message",
                side_effect=reject,
            ), patch.object(instance, "_save_last_sequence") as save:
                with self.assertRaisesRegex(RuntimeError, "dispatch failed"):
                    asyncio.run(instance._handle_frame(json.dumps({
                        "v": 1,
                        "type": "message",
                        "seq": 43,
                        "message": {"id": "retryable"},
                    })))

            save.assert_not_called()
            self.assertEqual(instance._last_sequence, 42)


if __name__ == "__main__":
    unittest.main()
