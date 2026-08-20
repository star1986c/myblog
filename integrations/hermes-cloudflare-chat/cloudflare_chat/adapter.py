"""Hermes platform adapter for the private Cloudflare chat relay."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import logging
import mimetypes
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import unquote, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from agent.secret_scope import UnscopedSecretError as _UnscopedSecretError
from agent.secret_scope import get_secret as _scoped_get_secret
from gateway.config import Platform
from hermes_constants import get_hermes_home
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
    cache_image_from_url,
)
try:
    from websockets.asyncio.client import connect as websocket_connect
    from .crypto_codec import (
        ChatCipher,
        MAX_AGENT_ATTACHMENT_BYTES,
        MAX_ATTACHMENT_BYTES,
        PRIVATE_ATTACHMENT_STORAGE,
        decode_chat_key,
    )
except ImportError:
    websocket_connect = None
    ChatCipher = None
    MAX_AGENT_ATTACHMENT_BYTES = 512 * 1024 * 1024
    MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
    PRIVATE_ATTACHMENT_STORAGE = "r2-private-v1"
    decode_chat_key = None


logger = logging.getLogger(__name__)
MAX_FRAME_BYTES = 64 * 1024
MAX_MESSAGE_ATTACHMENTS = 8
MAX_PENDING_INTERACTIONS = 128
INTERACTION_TIMEOUT_SECONDS = 300
PICKER_TIMEOUT_SECONDS = 15 * 60
HTTP_USER_AGENT = "Hermes-Cloudflare-Chat/0.3.0"
DIRECT_UPLOAD_RESPONSE_MAX_BYTES = 64 * 1024
DIRECT_UPLOAD_CHUNK_BYTES = 1024 * 1024
_SUPPORTED_FILE_TYPES: dict[str, tuple[str, str]] = {
    ".png": ("image/png", "image"),
    ".jpg": ("image/jpeg", "image"),
    ".jpeg": ("image/jpeg", "image"),
    ".gif": ("image/gif", "image"),
    ".webp": ("image/webp", "image"),
    ".bmp": ("image/bmp", "image"),
    ".tif": ("image/tiff", "image"),
    ".tiff": ("image/tiff", "image"),
    ".svg": ("image/svg+xml", "image"),
    ".mp3": ("audio/mpeg", "audio"),
    ".wav": ("audio/wav", "audio"),
    ".ogg": ("audio/ogg", "audio"),
    ".m4a": ("audio/mp4", "audio"),
    ".opus": ("audio/opus", "audio"),
    ".flac": ("audio/flac", "audio"),
    ".aac": ("audio/aac", "audio"),
    ".mp4": ("video/mp4", "video"),
    ".mov": ("video/quicktime", "video"),
    ".webm": ("video/webm", "video"),
    ".mkv": ("video/x-matroska", "video"),
    ".avi": ("video/x-msvideo", "video"),
    ".pdf": ("application/pdf", "document"),
    ".txt": ("text/plain", "document"),
    ".md": ("text/markdown", "document"),
    ".csv": ("text/csv", "document"),
    ".json": ("application/json", "document"),
    ".xml": ("application/xml", "document"),
    ".html": ("text/html", "document"),
    ".yaml": ("application/yaml", "document"),
    ".yml": ("application/yaml", "document"),
    ".log": ("text/plain", "document"),
    ".doc": ("application/msword", "office"),
    ".docx": (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "office",
    ),
    ".xls": ("application/vnd.ms-excel", "office"),
    ".xlsx": (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "office",
    ),
    ".ppt": ("application/vnd.ms-powerpoint", "office"),
    ".pptx": (
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "office",
    ),
    ".odt": ("application/vnd.oasis.opendocument.text", "office"),
    ".ods": ("application/vnd.oasis.opendocument.spreadsheet", "office"),
    ".odp": ("application/vnd.oasis.opendocument.presentation", "office"),
    ".zip": ("application/zip", "archive"),
    ".rar": ("application/vnd.rar", "archive"),
    ".7z": ("application/x-7z-compressed", "archive"),
    ".tar": ("application/x-tar", "archive"),
    ".gz": ("application/gzip", "archive"),
    ".bz2": ("application/x-bzip2", "archive"),
    ".epub": ("application/epub+zip", "book"),
    ".apk": ("application/vnd.android.package-archive", "package"),
    ".ipa": ("application/octet-stream", "package"),
}
_CONTENT_TYPE_ALIASES = {
    "image/jpg": "image/jpeg",
    "audio/x-wav": "audio/wav",
    "audio/x-flac": "audio/flac",
    "application/x-rar-compressed": "application/vnd.rar",
    "application/x-gzip": "application/gzip",
    "application/x-bzip2": "application/x-bzip2",
    "text/x-markdown": "text/markdown",
    "text/xml": "application/xml",
    "application/x-yaml": "application/yaml",
    "text/yaml": "application/yaml",
}
_IMAGE_EXTENSIONS = frozenset(
    extension
    for extension, (_, category) in _SUPPORTED_FILE_TYPES.items()
    if category == "image"
)
_MARKDOWN_IMAGE_RE = re.compile(
    r"!\[[^\]\r\n]*\]\(\s*(?P<source>(?:https?://|file://|/)[^\s)]+)\s*\)",
    re.IGNORECASE,
)
_MEDIA_IMAGE_RE = re.compile(
    r"^[ \t]*MEDIA:[ \t]*(?P<source>[^\r\n]+?)[ \t]*$",
    re.IGNORECASE | re.MULTILINE,
)


class _FileChunkIterable:
    def __init__(self, path: Path, expected_size: int):
        self.path = path
        self.expected_size = expected_size

    def __iter__(self):
        total = 0
        with self.path.open("rb") as source:
            while True:
                chunk = source.read(DIRECT_UPLOAD_CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > self.expected_size:
                    raise ValueError("outbound attachment changed during direct upload")
                yield chunk
        if total != self.expected_size:
            raise ValueError("outbound attachment changed during direct upload")


def _agent_attachment_max_bytes() -> int:
    raw = str(os.getenv("HERMES_CF_AGENT_ATTACHMENT_MAX_BYTES") or "").strip()
    try:
        configured = int(raw)
    except ValueError:
        configured = 0
    if MAX_ATTACHMENT_BYTES < configured <= MAX_AGENT_ATTACHMENT_BYTES:
        return configured
    return MAX_AGENT_ATTACHMENT_BYTES


def _direct_upload_timeout_seconds() -> int:
    raw = str(os.getenv("HERMES_CF_DIRECT_UPLOAD_TIMEOUT_SECONDS") or "").strip()
    try:
        configured = int(raw)
    except ValueError:
        configured = 0
    return configured if 60 <= configured <= 3600 else 900


def _sha256_file(path: Path, expected_size: int) -> str:
    before = path.stat()
    if before.st_size != expected_size:
        raise ValueError("outbound attachment changed before hashing")
    digest = hashlib.sha256()
    total = 0
    with path.open("rb") as source:
        while True:
            chunk = source.read(DIRECT_UPLOAD_CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > expected_size:
                raise ValueError("outbound attachment changed while hashing")
            digest.update(chunk)
    after = path.stat()
    if (
        total != expected_size
        or after.st_size != before.st_size
        or after.st_mtime_ns != before.st_mtime_ns
    ):
        raise ValueError("outbound attachment changed while hashing")
    return digest.hexdigest()


def _get_secret(name: str, default: str = "") -> str:
    try:
        value = _scoped_get_secret(name, default)
    except _UnscopedSecretError:
        value = os.getenv(name, default)
    return str(value or default)


class CloudflareChatAdapter(BasePlatformAdapter):
    REQUIRES_EDIT_FINALIZE = True

    def __init__(self, config, **kwargs):
        super().__init__(config=config, platform=Platform("cloudflare_chat"))
        extra = getattr(config, "extra", {}) or {}
        self.relay_url = str(
            os.getenv("HERMES_CF_RELAY_URL") or extra.get("relay_url") or ""
        ).strip()
        self.agent_secret = _get_secret("HERMES_CF_AGENT_SECRET") or str(
            extra.get("agent_secret") or ""
        )
        self.agent_id = str(
            os.getenv("HERMES_CF_AGENT_ID") or extra.get("agent_id") or "nas-hermes"
        ).strip()
        self.space_id = str(
            os.getenv("HERMES_CF_SPACE_ID") or extra.get("space_id") or ""
        ).strip()
        if ChatCipher is None or decode_chat_key is None:
            raise RuntimeError("Cloudflare Chat Python dependencies are not installed")
        self._cipher = ChatCipher(decode_chat_key(_get_secret("HERMES_CF_CHAT_KEY")))
        self._socket = None
        self._connection_task: asyncio.Task | None = None
        self._ready = asyncio.Event()
        self._closing = False
        self._state_path = (
            get_hermes_home() / "state" / "cloudflare_chat" / f"{self.space_id}.json"
        )
        self._last_sequence = self._load_last_sequence()
        self._pending_acks: dict[str, asyncio.Future] = {}
        self._pending_interactions: dict[str, dict[str, Any]] = {}
        self._interaction_tasks: set[asyncio.Task] = set()
        self._interaction_lock = asyncio.Lock()
        self._lock_key: str | None = None
        self._media_directory = Path(
            os.getenv("HERMES_CF_MEDIA_DIR")
            or get_hermes_home() / "cache" / "cloudflare_chat"
        )

    @property
    def name(self) -> str:
        return "Cloudflare Chat"

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not _valid_configuration(self.relay_url, self.agent_secret, self.agent_id, self.space_id):
            self._set_fatal_error(
                "config_missing",
                "Cloudflare Chat relay URL, agent secret, chat key, agent id, and space are required",
                retryable=False,
            )
            return False
        if self._connection_task and not self._connection_task.done():
            return self._ready.is_set()
        if not self._acquire_lock():
            self._set_fatal_error(
                "lock_conflict",
                "Cloudflare Chat agent identity is already in use by another profile",
                retryable=False,
            )
            return False

        self._closing = False
        self._ready.clear()
        self._connection_task = asyncio.create_task(self._connection_loop())
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=30.0)
            return True
        except asyncio.TimeoutError:
            await self.disconnect()
            self._set_fatal_error(
                "connect_timeout",
                "Cloudflare Chat relay did not connect within 30 seconds",
                retryable=True,
            )
            return False

    async def disconnect(self) -> None:
        self._closing = True
        self._ready.clear()
        self._mark_disconnected()
        if self._socket is not None:
            try:
                await self._socket.close(code=1000, reason="Hermes gateway stopping")
            except Exception:
                logger.debug("Cloudflare Chat socket close failed", exc_info=True)
        task = self._connection_task
        self._connection_task = None
        if task and task is not asyncio.current_task():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        interaction_tasks = list(self._interaction_tasks)
        self._interaction_tasks.clear()
        for interaction_task in interaction_tasks:
            interaction_task.cancel()
        if interaction_tasks:
            await asyncio.gather(*interaction_tasks, return_exceptions=True)
        self._socket = None
        for future in self._pending_acks.values():
            if not future.done():
                future.set_exception(ConnectionError("Cloudflare Chat disconnected"))
        self._pending_acks.clear()
        async with self._interaction_lock:
            self._pending_interactions.clear()
        self._release_lock()

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        text = str(content or "")
        attachments: list[dict[str, Any]] = []
        delivered_spans: list[tuple[int, int]] = []
        for start, end, source in _inline_image_candidates(text):
            if len(attachments) >= MAX_MESSAGE_ATTACHMENTS:
                break
            try:
                attachments.append(await self._encrypt_and_upload_image(source))
                delivered_spans.append((start, end))
            except Exception as error:
                # Preserve the original Markdown/MEDIA directive when the
                # fallback upload fails, so the image is never silently lost.
                logger.warning("Cloudflare Chat inline image fallback failed: %s", error)
        return await self._send_payload(
            _remove_delivered_spans(text, delivered_spans),
            attachments,
        )

    async def edit_message(
        self,
        chat_id: str,
        message_id: str,
        content: str,
        *,
        finalize: bool = False,
        metadata: dict[str, Any] | None = None,
    ):
        try:
            target_seq = int(str(message_id))
            if target_seq < 1 or str(target_seq) != str(message_id):
                raise ValueError("stream message id must be a positive relay sequence")
            envelope = self._cipher.encrypt_message(
                sender="agent",
                text=str(content or ""),
                attachments=[],
                replace_seq=target_seq,
                final=bool(finalize),
            )
            frame = {
                "v": 1,
                "type": "edit",
                "targetSeq": target_seq,
                "final": bool(finalize),
                "message": envelope,
            }
            await self._send_and_wait_for_ack(frame, envelope["id"])
            return SendResult(success=True, message_id=str(target_seq))
        except ValueError as error:
            return SendResult(success=False, error=str(error), retryable=False)
        except Exception as error:
            return SendResult(success=False, error=str(error), retryable=True)

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        await self._send_frame({
            "v": 1,
            "type": "typing",
            "active": True,
        })

    async def send_image(
        self,
        chat_id: str,
        image_url: str,
        caption: str | None = None,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
    ):
        try:
            descriptor = await self._encrypt_and_upload_image(image_url)
            return await self._send_payload(caption or "", [descriptor])
        except Exception as error:
            logger.warning("Cloudflare Chat image send failed: %s", error)
            return SendResult(success=False, error=str(error), retryable=False)

    async def send_image_file(
        self,
        chat_id: str,
        image_path: str,
        caption: str | None = None,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs,
    ):
        safe_path = self.validate_media_delivery_path(image_path)
        if not safe_path:
            return SendResult(success=False, error="Unsafe or unreadable image path")
        return await self.send_image(
            chat_id=chat_id,
            image_url=safe_path,
            caption=caption,
            reply_to=reply_to,
            metadata=metadata,
        )

    async def send_document(
        self,
        chat_id: str,
        file_path: str,
        caption: str | None = None,
        file_name: str | None = None,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs,
    ):
        return await self._send_local_attachment(
            file_path,
            caption=caption,
            file_name=file_name,
            allowed_categories={"document", "office", "archive", "book", "package"},
        )

    async def send_file(
        self,
        chat_id: str,
        file_path: str,
        caption: str | None = None,
        file_name: str | None = None,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs,
    ):
        return await self._send_local_attachment(
            file_path,
            caption=caption,
            file_name=file_name,
            allowed_categories=set(_supported_categories()),
        )

    async def send_voice(
        self,
        chat_id: str,
        audio_path: str,
        caption: str | None = None,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs,
    ):
        return await self._send_local_attachment(
            audio_path,
            caption=caption,
            file_name=kwargs.get("file_name"),
            allowed_categories={"audio"},
        )

    async def send_video(
        self,
        chat_id: str,
        video_path: str,
        caption: str | None = None,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs,
    ):
        return await self._send_local_attachment(
            video_path,
            caption=caption,
            file_name=kwargs.get("file_name"),
            allowed_categories={"video"},
        )

    async def _send_local_attachment(
        self,
        file_path: str,
        *,
        caption: str | None,
        file_name: str | None,
        allowed_categories: set[str],
    ):
        safe_path = self.validate_media_delivery_path(str(file_path or ""))
        if not safe_path:
            return SendResult(success=False, error="Unsafe or unreadable attachment path")
        try:
            descriptor = await self._encrypt_and_upload_local_file(
                safe_path,
                file_name=file_name,
                allowed_categories=allowed_categories,
            )
            return await self._send_payload(caption or "", [descriptor])
        except Exception as error:
            logger.warning("Cloudflare Chat attachment send failed: %s", error)
            return SendResult(success=False, error=str(error), retryable=False)

    async def send_exec_approval(
        self,
        chat_id: str,
        command: str,
        session_key: str,
        description: str = "dangerous command",
        metadata: dict[str, Any] | None = None,
        allow_permanent: bool = True,
        allow_session: bool = True,
        smart_denied: bool = False,
    ) -> SendResult:
        options = [
            _interaction_option("once", "仅本次允许", style="primary"),
        ]
        values: dict[str, Any] = {"once": "once"}
        if not smart_denied and allow_session:
            options.append(_interaction_option("session", "本会话允许"))
            values["session"] = "session"
            if allow_permanent:
                options.append(_interaction_option(
                    "always",
                    "始终允许",
                    style="warning",
                    wide=True,
                ))
                values["always"] = "always"
        options.append(_interaction_option(
            "deny",
            "拒绝",
            style="danger",
            wide=True,
        ))
        values["deny"] = "deny"
        preview = str(command or "")
        if len(preview) > 1500:
            preview = preview[:1500] + "..."
        text = (
            "**需要授权执行命令**\n\n"
            f"```shell\n{preview}\n```\n"
            f"原因：{description}"
        )
        if smart_denied:
            text += "\n\n此操作只允许进行一次所有者授权。"
        return await self._send_interaction_prompt(
            chat_id=chat_id,
            kind="approval",
            text=text,
            options=options,
            option_values=values,
            timeout_seconds=INTERACTION_TIMEOUT_SECONDS,
            session_key=session_key,
        )

    async def send_slash_confirm(
        self,
        chat_id: str,
        title: str,
        message: str,
        session_key: str,
        confirm_id: str,
        metadata: dict[str, Any] | None = None,
    ) -> SendResult:
        text = f"**{title}**\n\n{message}" if title else str(message or "")
        return await self._send_interaction_prompt(
            chat_id=chat_id,
            kind="slash_confirm",
            text=text,
            options=[
                _interaction_option("once", "仅本次批准", style="primary"),
                _interaction_option("always", "始终批准", style="warning", wide=True),
                _interaction_option("cancel", "取消", style="danger", wide=True),
            ],
            option_values={
                "once": "once",
                "always": "always",
                "cancel": "cancel",
            },
            timeout_seconds=INTERACTION_TIMEOUT_SECONDS,
            session_key=session_key,
            confirm_id=confirm_id,
        )

    async def send_clarify(
        self,
        chat_id: str,
        question: str,
        choices: list | None,
        clarify_id: str,
        session_key: str,
        metadata: dict[str, Any] | None = None,
    ) -> SendResult:
        if not choices:
            return await super().send_clarify(
                chat_id,
                question,
                choices,
                clarify_id,
                session_key,
                metadata=metadata,
            )
        # Hermes supports multi-select clarifications as typed comma/space
        # separated answers. A single-tap button would resolve too early, so
        # preserve the official text fallback for that prompt shape.
        try:
            from tools import clarify_gateway as clarify_gateway_mod

            with clarify_gateway_mod._lock:
                entry = clarify_gateway_mod._entries.get(clarify_id)
            is_multi_select = bool(entry and getattr(entry, "multi_select", False))
        except Exception:
            is_multi_select = False
        if is_multi_select:
            return await super().send_clarify(
                chat_id,
                question,
                choices,
                clarify_id,
                session_key,
                metadata=metadata,
            )
        if len(choices) > 23:
            # Reserve the 24th protocol slot for “Other”. The base adapter's
            # numbered text fallback preserves every choice when a prompt is
            # larger than the native button surface.
            return await super().send_clarify(
                chat_id,
                question,
                choices,
                clarify_id,
                session_key,
                metadata=metadata,
            )
        safe_choices = [str(choice) for choice in choices]
        options = [
            _interaction_option(
                f"c{index}",
                choice,
                wide=len(choice) > 18,
            )
            for index, choice in enumerate(safe_choices)
        ]
        options.append(_interaction_option("other", "其他（输入文字）", wide=True))
        values = {f"c{index}": index for index in range(len(safe_choices))}
        values["other"] = "other"
        return await self._send_interaction_prompt(
            chat_id=chat_id,
            kind="clarify",
            text=f"**需要你的选择**\n\n{question}",
            options=options,
            option_values=values,
            timeout_seconds=INTERACTION_TIMEOUT_SECONDS,
            session_key=session_key,
            clarify_id=clarify_id,
            choices=safe_choices,
        )

    async def send_choice_picker(
        self,
        chat_id: str,
        title: str,
        choices: list,
        session_key: str,
        on_choice_selected,
        metadata: dict[str, Any] | None = None,
    ) -> SendResult:
        if not choices:
            return SendResult(success=False, error="No choices")
        options: list[dict[str, Any]] = []
        values: dict[str, Any] = {}
        safe_choices: list[dict[str, Any]] = []
        # One protocol slot is reserved for Cancel.
        for index, raw in enumerate(choices[:23]):
            choice = dict(raw or {})
            label = str(choice.get("label") or choice.get("value") or "")
            if not label:
                continue
            option_id = f"c{index}"
            options.append(_interaction_option(
                option_id,
                label,
                selected=bool(choice.get("is_current")),
                wide=len(label) > 18,
            ))
            values[option_id] = str(choice.get("value") or "")
            safe_choices.append(choice)
        if not options:
            return SendResult(success=False, error="No valid choices")
        options.append(_interaction_option("cancel", "取消", style="danger", wide=True))
        values["cancel"] = "cancel"
        return await self._send_interaction_prompt(
            chat_id=chat_id,
            kind="choice",
            text=str(title or "请选择"),
            options=options,
            option_values=values,
            timeout_seconds=PICKER_TIMEOUT_SECONDS,
            session_key=session_key,
            on_choice_selected=on_choice_selected,
            choices=safe_choices,
        )

    async def send_model_picker(
        self,
        chat_id: str,
        providers: list,
        current_model: str,
        current_provider: str,
        session_key: str,
        on_model_selected,
        metadata: dict[str, Any] | None = None,
    ) -> SendResult:
        safe_providers = [dict(provider or {}) for provider in providers if provider]
        if not safe_providers:
            return SendResult(success=False, error="No model providers")
        state: dict[str, Any] = {
            "providers": safe_providers,
            "current_model": str(current_model or ""),
            "current_provider": str(current_provider or ""),
            "provider_page": 0,
            "on_model_selected": on_model_selected,
        }
        text, options, values, page_info = self._model_provider_view(state, 0)
        return await self._send_interaction_prompt(
            chat_id=chat_id,
            kind="model",
            text=text,
            options=options,
            option_values=values,
            timeout_seconds=PICKER_TIMEOUT_SECONDS,
            stage="providers",
            page_info=page_info,
            session_key=session_key,
            **state,
        )

    async def _send_interaction_prompt(
        self,
        *,
        chat_id: str,
        kind: str,
        text: str,
        options: list[dict[str, Any]],
        option_values: dict[str, Any],
        timeout_seconds: int,
        stage: str = "",
        page_info: str = "",
        **state_data,
    ) -> SendResult:
        prompt_id = str(uuid.uuid4())
        expires_at = int(time.time() * 1000) + max(1, timeout_seconds) * 1000
        interaction = _interaction_payload(
            prompt_id,
            kind,
            "pending",
            expires_at,
            options,
            stage=stage,
            page_info=page_info,
        )
        state = {
            "id": prompt_id,
            "chat_id": str(chat_id),
            "kind": kind,
            "text": str(text or ""),
            "options": options,
            "option_values": dict(option_values),
            "expires_at": expires_at,
            "stage": stage,
            "page_info": page_info,
            "message_seq": 0,
            "busy": False,
            **state_data,
        }
        async with self._interaction_lock:
            self._prune_interactions_locked()
            while len(self._pending_interactions) >= MAX_PENDING_INTERACTIONS:
                oldest = next(iter(self._pending_interactions))
                self._pending_interactions.pop(oldest, None)
            self._pending_interactions[prompt_id] = state
        result = await self._send_payload(text, [], interaction=interaction)
        if not result.success:
            async with self._interaction_lock:
                self._pending_interactions.pop(prompt_id, None)
            return result
        try:
            state["message_seq"] = int(str(result.message_id))
        except (TypeError, ValueError):
            async with self._interaction_lock:
                self._pending_interactions.pop(prompt_id, None)
            return SendResult(success=False, error="Interaction relay sequence is invalid")
        return result

    async def _handle_interaction_response(
        self,
        response: dict[str, Any],
        *,
        relay_user: str,
    ) -> None:
        if not self._logical_user_authorized():
            raise PermissionError("Cloudflare Chat action user is not authorized")
        prompt_id = str(response.get("promptId") or "")
        option_id = str(response.get("optionId") or "")
        expired = False
        async with self._interaction_lock:
            state = self._pending_interactions.get(prompt_id)
            if state is None:
                logger.info(
                    "Cloudflare Chat ignored unknown interaction id=%s user=%s",
                    prompt_id,
                    relay_user,
                )
                return
            if int(state.get("expires_at") or 0) <= int(time.time() * 1000):
                self._pending_interactions.pop(prompt_id, None)
                expired = True
            elif state.get("busy"):
                logger.debug("Cloudflare Chat ignored duplicate interaction id=%s", prompt_id)
                return
            elif option_id not in state.get("option_values", {}):
                raise ValueError("Cloudflare Chat interaction option is invalid")
            else:
                state["busy"] = True
                selected = state["option_values"][option_id]
        if expired:
            await self._finish_interaction(
                state,
                "此操作已过期，请重新发送指令。",
                status="已过期",
                interaction_state="expired",
                already_removed=True,
            )
            return
        try:
            await self._dispatch_interaction(state, selected)
        except Exception as error:
            logger.warning("Cloudflare Chat interaction resolution failed", exc_info=True)
            await self._finish_interaction(
                state,
                f"操作失败：{error}",
                status="操作失败",
                interaction_state="error",
            )

    async def _dispatch_interaction(self, state: dict[str, Any], selected: Any) -> None:
        kind = state.get("kind")
        if kind == "approval":
            from tools.approval import resolve_gateway_approval

            choice = str(selected)
            count = resolve_gateway_approval(str(state.get("session_key") or ""), choice)
            labels = {
                "once": "已批准：仅本次",
                "session": "已批准：本会话",
                "always": "已批准：始终允许",
                "deny": "已拒绝",
            }
            if count:
                await self._finish_interaction(state, labels.get(choice, "已处理"), status=labels.get(choice, "已处理"))
                self.resume_typing_for_chat(str(state.get("chat_id") or self.space_id))
            else:
                await self._finish_interaction(
                    state,
                    "授权已超时或已在其他位置处理。",
                    status="授权已过期",
                    interaction_state="expired",
                )
            return
        if kind == "slash_confirm":
            from tools import slash_confirm as slash_confirm_mod

            choice = str(selected)
            result_text = await slash_confirm_mod.resolve(
                str(state.get("session_key") or ""),
                str(state.get("confirm_id") or ""),
                choice,
            )
            label = {
                "once": "已批准：仅本次",
                "always": "已批准：始终允许",
                "cancel": "已取消",
            }.get(choice, "已处理")
            await self._finish_interaction(state, label, status=label)
            if result_text:
                await self.send(str(state.get("chat_id") or self.space_id), str(result_text))
            return
        if kind == "clarify":
            from tools.clarify_gateway import mark_awaiting_text, resolve_gateway_clarify

            clarify_id = str(state.get("clarify_id") or "")
            if selected == "other":
                if mark_awaiting_text(clarify_id):
                    await self._finish_interaction(
                        state,
                        "请直接在输入框中输入你的回答。",
                        status="等待文字回答",
                    )
                else:
                    await self._finish_interaction(
                        state,
                        "问题已过期，请重试。",
                        status="问题已过期",
                        interaction_state="expired",
                    )
                return
            choices = state.get("choices") or []
            index = int(selected)
            if index < 0 or index >= len(choices):
                raise ValueError("clarify choice is unavailable")
            choice_text = str(choices[index])
            resolved = resolve_gateway_clarify(clarify_id, choice_text)
            await self._finish_interaction(
                state,
                f"已选择：{choice_text}" if resolved else "问题已过期，请重试。",
                status="已回答" if resolved else "问题已过期",
                interaction_state="resolved" if resolved else "expired",
            )
            return
        if kind == "choice":
            if selected == "cancel":
                await self._finish_interaction(state, "已取消选择。", status="已取消")
                return
            result = await _await_callback(
                state.get("on_choice_selected"),
                str(state.get("chat_id") or self.space_id),
                str(selected),
            )
            await self._finish_interaction(
                state,
                str(result or "设置已更新。"),
                status="设置已更新",
            )
            return
        if kind == "model":
            await self._dispatch_model_interaction(state, selected)
            return
        raise ValueError("unknown interaction kind")

    async def _dispatch_model_interaction(
        self,
        state: dict[str, Any],
        selected: Any,
    ) -> None:
        action = dict(selected or {})
        action_type = action.get("type")
        if action_type == "cancel":
            await self._finish_interaction(state, "模型选择已取消。", status="已取消")
            return
        if action_type == "provider_page":
            text, options, values, page_info = self._model_provider_view(
                state,
                int(action.get("page") or 0),
            )
            await self._refresh_interaction(
                state,
                text,
                options,
                values,
                stage="providers",
                page_info=page_info,
            )
            return
        if action_type == "provider":
            state["selected_provider_index"] = int(action["index"])
            state["model_page"] = 0
            text, options, values, page_info = self._model_models_view(state, 0)
            await self._refresh_interaction(
                state,
                text,
                options,
                values,
                stage="models",
                page_info=page_info,
            )
            return
        if action_type == "model_page":
            text, options, values, page_info = self._model_models_view(
                state,
                int(action.get("page") or 0),
            )
            await self._refresh_interaction(
                state,
                text,
                options,
                values,
                stage="models",
                page_info=page_info,
            )
            return
        if action_type == "back_providers":
            text, options, values, page_info = self._model_provider_view(
                state,
                int(state.get("provider_page") or 0),
            )
            await self._refresh_interaction(
                state,
                text,
                options,
                values,
                stage="providers",
                page_info=page_info,
            )
            return
        if action_type == "back_models":
            text, options, values, page_info = self._model_models_view(
                state,
                int(state.get("model_page") or 0),
            )
            await self._refresh_interaction(
                state,
                text,
                options,
                values,
                stage="models",
                page_info=page_info,
            )
            return
        if action_type in {"model", "confirm_model"}:
            model_index = int(action["index"])
            provider = self._selected_model_provider(state)
            models = [str(value) for value in provider.get("models", [])]
            if model_index < 0 or model_index >= len(models):
                raise ValueError("model is unavailable")
            model_id = models[model_index]
            provider_slug = str(provider.get("slug") or "")
            if action_type == "model":
                try:
                    from hermes_cli.model_cost_guard import expensive_model_warning

                    warning = await asyncio.to_thread(
                        expensive_model_warning,
                        model_id,
                        provider=provider_slug,
                    )
                except Exception:
                    warning = None
                if warning is not None:
                    state["selected_model_index"] = model_index
                    text = f"**高费用模型提醒**\n\n{getattr(warning, 'message', warning)}"
                    options = [
                        _interaction_option("confirm", "仍然切换", style="warning", wide=True),
                        _interaction_option("back", "返回模型列表"),
                        _interaction_option("cancel", "取消", style="danger"),
                    ]
                    values = {
                        "confirm": {"type": "confirm_model", "index": model_index},
                        "back": {"type": "back_models"},
                        "cancel": {"type": "cancel"},
                    }
                    await self._refresh_interaction(
                        state,
                        text,
                        options,
                        values,
                        stage="confirm",
                    )
                    return
            result = await _await_callback(
                state.get("on_model_selected"),
                str(state.get("chat_id") or self.space_id),
                model_id,
                provider_slug,
            )
            await self._finish_interaction(
                state,
                str(result or "模型已切换。"),
                status="模型已切换",
            )
            return
        raise ValueError("model action is invalid")

    async def _refresh_interaction(
        self,
        state: dict[str, Any],
        text: str,
        options: list[dict[str, Any]],
        option_values: dict[str, Any],
        *,
        stage: str,
        page_info: str = "",
    ) -> None:
        interaction = _interaction_payload(
            str(state["id"]),
            str(state["kind"]),
            "pending",
            int(state["expires_at"]),
            options,
            stage=stage,
            page_info=page_info,
        )
        sent = await self._edit_interaction_prompt(state, text, interaction)
        async with self._interaction_lock:
            current = self._pending_interactions.get(str(state["id"]))
            if current is not state:
                return
            if sent:
                state.update({
                    "text": text,
                    "options": options,
                    "option_values": dict(option_values),
                    "stage": stage,
                    "page_info": page_info,
                })
            state["busy"] = False
        if not sent:
            raise ConnectionError("无法更新交互消息")

    async def _finish_interaction(
        self,
        state: dict[str, Any],
        text: str,
        *,
        status: str,
        interaction_state: str = "resolved",
        already_removed: bool = False,
    ) -> None:
        if not already_removed:
            async with self._interaction_lock:
                self._pending_interactions.pop(str(state.get("id") or ""), None)
        interaction = _interaction_payload(
            str(state["id"]),
            str(state["kind"]),
            interaction_state,
            int(state["expires_at"]),
            [],
            stage=str(state.get("stage") or ""),
            status=status,
        )
        sent = await self._edit_interaction_prompt(state, text, interaction)
        if not sent:
            await self.send(str(state.get("chat_id") or self.space_id), text)

    async def _edit_interaction_prompt(
        self,
        state: dict[str, Any],
        text: str,
        interaction: dict[str, Any],
    ) -> bool:
        target_seq = int(state.get("message_seq") or 0)
        if target_seq < 1:
            return False
        envelope = self._cipher.encrypt_message(
            sender="agent",
            text=str(text or ""),
            attachments=[],
            replace_seq=target_seq,
            final=True,
            interaction=interaction,
        )
        frame = {
            "v": 1,
            "type": "edit",
            "targetSeq": target_seq,
            "final": True,
            "message": envelope,
        }
        try:
            await self._send_and_wait_for_ack(frame, envelope["id"])
            return True
        except Exception:
            logger.warning("Cloudflare Chat interaction edit failed", exc_info=True)
            return False

    def _model_provider_view(
        self,
        state: dict[str, Any],
        page: int,
    ) -> tuple[str, list[dict[str, Any]], dict[str, Any], str]:
        providers = state.get("providers") or []
        page_values, page, total_pages, start = _paginate(providers, page, 10)
        state["provider_page"] = page
        options: list[dict[str, Any]] = []
        values: dict[str, Any] = {}
        for offset, provider in enumerate(page_values):
            absolute = start + offset
            slug = str(provider.get("slug") or "")
            name = str(provider.get("name") or slug or "Provider")
            count = int(provider.get("total_models") or len(provider.get("models", [])))
            option_id = f"p{absolute}"
            options.append(_interaction_option(
                option_id,
                f"{name} ({count})",
                selected=bool(provider.get("is_current")) or slug == state.get("current_provider"),
            ))
            values[option_id] = {"type": "provider", "index": absolute}
        _append_page_actions(options, values, page, total_pages, "provider_page")
        options.append(_interaction_option("cancel", "取消", style="danger", wide=True))
        values["cancel"] = {"type": "cancel"}
        current_provider = str(state.get("current_provider") or "unknown")
        for provider in providers:
            if str(provider.get("slug") or "") == current_provider:
                current_provider = str(provider.get("name") or current_provider)
                break
        page_info = f"{page + 1}/{total_pages}" if total_pages > 1 else ""
        text = (
            "**模型配置**\n\n"
            f"当前模型：`{state.get('current_model') or 'unknown'}`\n"
            f"提供商：{current_provider}\n\n"
            "请选择提供商："
        )
        return text, options, values, page_info

    def _model_models_view(
        self,
        state: dict[str, Any],
        page: int,
    ) -> tuple[str, list[dict[str, Any]], dict[str, Any], str]:
        provider = self._selected_model_provider(state)
        models = [str(value) for value in provider.get("models", [])]
        page_values, page, total_pages, start = _paginate(models, page, 8)
        state["model_page"] = page
        options: list[dict[str, Any]] = []
        values: dict[str, Any] = {}
        for offset, model_id in enumerate(page_values):
            absolute = start + offset
            label = model_id.split("/")[-1]
            option_id = f"m{absolute}"
            options.append(_interaction_option(
                option_id,
                label,
                selected=(
                    model_id == state.get("current_model")
                    and str(provider.get("slug") or "") == state.get("current_provider")
                ),
                wide=len(label) > 24,
            ))
            values[option_id] = {"type": "model", "index": absolute}
        _append_page_actions(options, values, page, total_pages, "model_page")
        options.append(_interaction_option("back", "返回提供商"))
        values["back"] = {"type": "back_providers"}
        options.append(_interaction_option("cancel", "取消", style="danger"))
        values["cancel"] = {"type": "cancel"}
        name = str(provider.get("name") or provider.get("slug") or "Provider")
        total = int(provider.get("total_models") or len(models))
        extra = f"\n另有 {total - len(models)} 个模型，可直接输入 `/model <名称>`。" if total > len(models) else ""
        page_info = f"{page + 1}/{total_pages}" if total_pages > 1 else ""
        text = f"**模型配置**\n\n提供商：**{name}**\n请选择模型：{extra}"
        return text, options, values, page_info

    @staticmethod
    def _selected_model_provider(state: dict[str, Any]) -> dict[str, Any]:
        providers = state.get("providers") or []
        index = int(state.get("selected_provider_index", -1))
        if index < 0 or index >= len(providers):
            raise ValueError("model provider is unavailable")
        return providers[index]

    def _logical_user_authorized(self) -> bool:
        if str(os.getenv("HERMES_CF_ALLOW_ALL_USERS") or "").strip().lower() in {
            "1", "true", "yes", "on",
        }:
            return True
        allowed = {
            value.strip()
            for value in str(os.getenv("HERMES_CF_ALLOWED_USERS") or "").split(",")
            if value.strip()
        }
        return "android-owner" in allowed

    def _prune_interactions_locked(self) -> None:
        now = int(time.time() * 1000)
        expired = [
            prompt_id
            for prompt_id, state in self._pending_interactions.items()
            if int(state.get("expires_at") or 0) <= now
        ]
        for prompt_id in expired:
            self._pending_interactions.pop(prompt_id, None)

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        return {"name": "Android Notes", "type": "dm", "chat_id": chat_id}

    async def _connection_loop(self) -> None:
        delay = 1.0
        while not self._closing:
            try:
                async with websocket_connect(
                    self.relay_url,
                    additional_headers={
                        "Authorization": f"Bearer {self.agent_secret}",
                        "X-Hermes-Role": "agent",
                        "X-Hermes-Agent-Id": self.agent_id,
                        "X-Hermes-Space": self.space_id,
                    },
                    max_size=MAX_FRAME_BYTES,
                    open_timeout=20,
                    ping_interval=20,
                    ping_timeout=20,
                    close_timeout=10,
                ) as socket:
                    self._socket = socket
                    self._mark_connected()
                    self._ready.set()
                    delay = 1.0
                    if self._last_sequence > 0:
                        await self._send_frame({
                            "v": 1,
                            "type": "received",
                            "seq": self._last_sequence,
                        })
                    await self._send_frame({
                        "v": 1,
                        "type": "resume",
                        "afterSeq": self._last_sequence,
                    })
                    async for raw in socket:
                        await self._handle_frame(raw)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                if not self._closing:
                    logger.warning("Cloudflare Chat connection lost: %s", error)
            finally:
                self._socket = None
                self._ready.clear()
                self._mark_disconnected()
            if not self._closing:
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30.0)

    async def _handle_frame(self, raw: str | bytes) -> None:
        if isinstance(raw, bytes):
            raise ValueError("binary WebSocket frames are not supported")
        frame = json.loads(raw)
        frame_type = frame.get("type")
        if frame_type == "ack":
            future = self._pending_acks.pop(str(frame.get("id") or ""), None)
            if future and not future.done():
                future.set_result(frame)
            return
        if frame_type == "message":
            sequence = int(frame.get("seq") or 0)
            if sequence < 1:
                raise ValueError("Cloudflare Chat message sequence is invalid")
            if sequence <= self._last_sequence:
                logger.debug(
                    "Cloudflare Chat ignored duplicate or out-of-order sequence %s (last=%s)",
                    sequence,
                    self._last_sequence,
                )
                return
            envelope = frame.get("message") or {}
            event = await self._prepare_inbound_message(envelope)
            self._last_sequence = sequence
            try:
                await asyncio.to_thread(self._save_last_sequence)
            except Exception:
                logger.error(
                    "Cloudflare Chat could not persist inbound checkpoint %s",
                    sequence,
                    exc_info=True,
                )
            try:
                await self.send_typing(self.space_id)
            except Exception:
                logger.debug(
                    "Cloudflare Chat could not announce inbound processing",
                    exc_info=True,
                )
            await self.handle_message(event)
            try:
                await self._send_frame({
                    "v": 1,
                    "type": "received",
                    "seq": sequence,
                })
            except Exception:
                logger.warning(
                    "Cloudflare Chat could not confirm inbound checkpoint %s",
                    sequence,
                    exc_info=True,
                )
            logger.info(
                "Cloudflare Chat accepted inbound message seq=%s id=%s attachments=%s",
                sequence,
                str(envelope.get("id") or ""),
                len(event.media_urls or []),
            )
            return
        if frame_type == "action":
            try:
                relay_user = str(frame.get("userId") or "").strip()
                if not relay_user or len(relay_user) > 256:
                    raise ValueError("Cloudflare Chat action user is invalid")
                payload = self._cipher.decrypt_message(
                    frame.get("message") or {},
                    expected_sender="client",
                )
                if payload.get("text") or payload.get("attachments"):
                    raise ValueError("Cloudflare Chat action payload is invalid")
                response = payload.get("interactionResponse")
                if not isinstance(response, dict):
                    raise ValueError("Cloudflare Chat action response is missing")
            except Exception as error:
                logger.warning("Cloudflare Chat rejected an interaction action: %s", error)
                return
            # Do not await the callback from the WebSocket receive loop. The
            # callback sends an edit and waits for its ACK, which must be read
            # by this same loop. Running it as a tracked task avoids a
            # self-deadlock while retaining single-use prompt state.
            task = asyncio.create_task(
                self._run_interaction_response(response, relay_user=relay_user)
            )
            self._interaction_tasks.add(task)
            task.add_done_callback(self._interaction_tasks.discard)
            return
        if frame_type == "resume_complete":
            if frame.get("hasMore") is True:
                await self._send_frame({
                    "v": 1,
                    "type": "resume",
                    "afterSeq": self._last_sequence,
                })
            return
        if frame_type in {"ready", "pong", "typing"}:
            return
        if frame_type == "error":
            logger.warning("Cloudflare Chat relay rejected a frame: %s", frame.get("message"))

    async def _run_interaction_response(
        self,
        response: dict[str, Any],
        *,
        relay_user: str,
    ) -> None:
        try:
            await self._handle_interaction_response(response, relay_user=relay_user)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.warning("Cloudflare Chat rejected an interaction action: %s", error)

    async def _prepare_inbound_message(self, envelope: dict[str, Any]) -> MessageEvent:
        payload = self._cipher.decrypt_message(envelope, expected_sender="client")
        media_urls: list[str] = []
        media_types: list[str] = []
        media_categories: list[str] = []
        for descriptor in payload["attachments"]:
            path, content_type, category = await self._download_and_decrypt_attachment(
                descriptor
            )
            media_urls.append(str(path))
            media_types.append(content_type)
            media_categories.append(category)

        source = self.build_source(
            chat_id=self.space_id,
            chat_name="Android Notes",
            chat_type="dm",
            user_id="android-owner",
            user_name="Android Owner",
            message_id=str(envelope.get("id") or ""),
        )
        event = MessageEvent(
            text=payload["text"],
            message_type=_message_type_for_categories(media_categories),
            user_id="android-owner",
            user_name="Android Owner",
            source=source,
            message_id=str(envelope.get("id") or ""),
            media_urls=media_urls,
            media_types=media_types,
            raw_message=envelope,
        )
        return event

    async def _send_payload(
        self,
        text: str,
        attachments: list[dict[str, Any]],
        *,
        interaction: dict[str, Any] | None = None,
    ):
        envelope = self._cipher.encrypt_message(
            sender="agent",
            text=text,
            attachments=attachments,
            interaction=interaction,
        )
        try:
            ack = await self._send_and_wait_for_ack(envelope, envelope["id"])
            return SendResult(success=True, message_id=str(ack.get("seq") or envelope["id"]))
        except Exception as error:
            # The relay may have persisted the message even when its ACK was lost.
            # Keep confirmed objects in that ambiguous case; lifecycle expiration is
            # safer than deleting a file referenced by an already durable message.
            return SendResult(success=False, error=str(error), retryable=True)

    async def _send_and_wait_for_ack(
        self,
        frame: dict[str, Any],
        acknowledgement_id: str,
    ) -> dict[str, Any]:
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._pending_acks[acknowledgement_id] = future
        try:
            await self._send_frame(frame)
            return await asyncio.wait_for(future, timeout=15.0)
        finally:
            self._pending_acks.pop(acknowledgement_id, None)

    async def _send_frame(self, frame: dict[str, Any]) -> None:
        socket = self._socket
        if socket is None:
            raise ConnectionError("Cloudflare Chat is not connected")
        encoded = json.dumps(frame, separators=(",", ":"), ensure_ascii=False)
        if len(encoded.encode("utf-8")) > MAX_FRAME_BYTES:
            raise ValueError("Cloudflare Chat frame exceeds 64 KiB")
        await socket.send(encoded)

    async def _download_and_decrypt_attachment(self, descriptor: dict[str, Any]):
        attachment_id = str(descriptor.get("id") or "")
        if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", attachment_id):
            raise ValueError("invalid attachment id")
        filename = Path(str(descriptor.get("name") or "attachment.bin")).name
        content_type, category = _resolve_file_type(
            filename,
            str(descriptor.get("contentType") or "application/octet-stream"),
        )
        ciphertext = await asyncio.to_thread(self._download_attachment, attachment_id)
        plaintext = self._cipher.decrypt_attachment(ciphertext, descriptor)
        self._media_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._cleanup_media_cache()
        target = self._media_directory / f"{attachment_id}-{filename}"
        target.write_bytes(plaintext)
        target.chmod(0o600)
        return target, content_type, category

    def _download_attachment(self, attachment_id: str) -> bytes:
        request = Request(
            self._attachment_url(attachment_id),
            headers=self._http_headers(),
            method="GET",
        )
        try:
            with urlopen(request, timeout=30) as response:
                content_length = int(response.headers.get("Content-Length", "0"))
                if content_length < 17 or content_length > MAX_ATTACHMENT_BYTES + 16:
                    raise ValueError("invalid encrypted attachment size")
                data = response.read(MAX_ATTACHMENT_BYTES + 17)
        except HTTPError as error:
            raise _attachment_http_error("download", error) from error
        if len(data) != content_length:
            raise ValueError("encrypted attachment download was incomplete")
        return data

    def _upload_attachment(self, attachment_id: str, ciphertext: bytes) -> None:
        headers = self._http_headers()
        headers.update({
            "Content-Type": "application/octet-stream",
            "Content-Length": str(len(ciphertext)),
        })
        request = Request(
            self._attachment_url(attachment_id),
            data=ciphertext,
            headers=headers,
            method="POST",
        )
        try:
            with urlopen(request, timeout=45) as response:
                if response.status != 201:
                    raise ConnectionError(f"attachment upload returned HTTP {response.status}")
        except HTTPError as error:
            raise _attachment_http_error("upload", error) from error

    def _upload_direct_file(
        self,
        path: Path,
        *,
        plaintext_bytes: int,
        content_type: str,
        filename: str,
    ) -> dict[str, Any]:
        attachment_id = str(uuid.uuid4())
        sha256 = _sha256_file(path, plaintext_bytes)
        request_payload = {
            "attachmentId": attachment_id,
            "plaintextBytes": plaintext_bytes,
            "sha256": sha256,
        }
        ticket_response = self._direct_upload_json(
            "",
            request_payload,
            method="POST",
            expected_statuses={201},
        )
        ticket = ticket_response.get("ticket")
        if not isinstance(ticket, dict):
            raise ConnectionError("direct upload ticket response is invalid")
        upload_url = str(ticket.get("uploadUrl") or "")
        parsed_upload_url = urlsplit(upload_url)
        required_headers = ticket.get("requiredHeaders")
        if (
            ticket.get("attachmentId") != attachment_id
            or ticket.get("storage") != PRIVATE_ATTACHMENT_STORAGE
            or int(ticket.get("plaintextBytes") or 0) != plaintext_bytes
            or str(ticket.get("sha256") or "").lower() != sha256
            or parsed_upload_url.scheme != "https"
            or not parsed_upload_url.hostname
            or not parsed_upload_url.hostname.endswith(".r2.cloudflarestorage.com")
            or not isinstance(required_headers, dict)
        ):
            raise ConnectionError("direct upload ticket does not match the attachment")
        headers = {
            str(name): str(value)
            for name, value in required_headers.items()
            if isinstance(name, str) and isinstance(value, str)
        }
        if headers.get("Content-Type") != "application/octet-stream":
            raise ConnectionError("direct upload ticket is missing its content type")
        headers.update({
            "Content-Length": str(plaintext_bytes),
            "User-Agent": HTTP_USER_AGENT,
        })
        upload_request = Request(
            upload_url,
            data=_FileChunkIterable(path, plaintext_bytes),
            headers=headers,
            method="PUT",
        )
        timeout = _direct_upload_timeout_seconds()
        try:
            with urlopen(upload_request, timeout=timeout) as response:
                if response.status not in {200, 201}:
                    raise ConnectionError(
                        f"direct R2 upload returned HTTP {response.status}"
                    )
        except HTTPError as error:
            self._cancel_direct_attachment(attachment_id)
            raise _attachment_http_error("direct R2 upload", error) from error
        except Exception:
            self._cancel_direct_attachment(attachment_id)
            raise

        try:
            confirmation = self._direct_upload_json(
                "/complete",
                request_payload,
                method="POST",
                expected_statuses={200},
            ).get("attachment")
            if (
                not isinstance(confirmation, dict)
                or confirmation.get("id") != attachment_id
                or confirmation.get("storage") != PRIVATE_ATTACHMENT_STORAGE
                or int(confirmation.get("plaintextBytes") or 0) != plaintext_bytes
                or str(confirmation.get("sha256") or "").lower() != sha256
            ):
                raise ConnectionError("direct upload confirmation is invalid")
        except Exception:
            self._cancel_direct_attachment(attachment_id)
            raise

        return {
            "id": attachment_id,
            "name": filename,
            "contentType": content_type,
            "plaintextBytes": plaintext_bytes,
            "storage": PRIVATE_ATTACHMENT_STORAGE,
            "sha256": sha256,
        }

    def _direct_upload_json(
        self,
        suffix: str,
        payload: dict[str, Any],
        *,
        method: str,
        expected_statuses: set[int],
    ) -> dict[str, Any]:
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers = self._http_headers()
        headers.update({
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": str(len(encoded)),
        })
        request = Request(
            self._direct_upload_url(suffix),
            data=encoded,
            headers=headers,
            method=method,
        )
        try:
            with urlopen(request, timeout=45) as response:
                if response.status not in expected_statuses:
                    raise ConnectionError(
                        f"direct upload API returned HTTP {response.status}"
                    )
                raw = response.read(DIRECT_UPLOAD_RESPONSE_MAX_BYTES + 1)
        except HTTPError as error:
            raise _attachment_http_error("direct upload API", error) from error
        if len(raw) > DIRECT_UPLOAD_RESPONSE_MAX_BYTES:
            raise ConnectionError("direct upload API response is too large")
        try:
            decoded = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ConnectionError("direct upload API returned invalid JSON") from error
        if not isinstance(decoded, dict):
            raise ConnectionError("direct upload API response is invalid")
        return decoded

    def _cancel_direct_attachment(self, attachment_id: str) -> None:
        request = Request(
            self._direct_upload_url(f"/{attachment_id}"),
            headers=self._http_headers(),
            method="DELETE",
        )
        try:
            with urlopen(request, timeout=30) as response:
                if response.status != 200:
                    logger.warning(
                        "Cloudflare Chat direct attachment cancel returned HTTP %s",
                        response.status,
                    )
        except HTTPError as error:
            if error.code != 404:
                logger.warning(
                    "Cloudflare Chat direct attachment cancel failed: %s",
                    _attachment_http_error("cancel", error),
                )
        except Exception as error:
            logger.warning("Cloudflare Chat direct attachment cancel failed: %s", error)

    def _attachment_url(self, attachment_id: str) -> str:
        parsed = urlsplit(self.relay_url)
        scheme = "https" if parsed.scheme == "wss" else "http"
        return urlunsplit((scheme, parsed.netloc, f"/api/hermes-chat/attachments/{attachment_id}", "", ""))

    def _direct_upload_url(self, suffix: str) -> str:
        parsed = urlsplit(self.relay_url)
        scheme = "https" if parsed.scheme == "wss" else "http"
        return urlunsplit((
            scheme,
            parsed.netloc,
            f"/api/hermes-chat/direct-uploads{suffix}",
            "",
            "",
        ))

    def _message_url(self) -> str:
        parsed = urlsplit(self.relay_url)
        scheme = "https" if parsed.scheme == "wss" else "http"
        return urlunsplit((scheme, parsed.netloc, "/api/hermes-chat/messages", "", ""))

    def _publish_message(self, envelope: dict[str, Any]) -> dict[str, Any]:
        encoded = json.dumps(
            envelope,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
        if len(encoded) > MAX_FRAME_BYTES:
            raise ValueError("Cloudflare Chat frame exceeds 64 KiB")
        headers = self._http_headers()
        headers.update({
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": str(len(encoded)),
        })
        request = Request(
            self._message_url(),
            data=encoded,
            headers=headers,
            method="POST",
        )
        try:
            with urlopen(request, timeout=30) as response:
                if response.status not in {200, 201}:
                    raise ConnectionError(
                        f"message publish returned HTTP {response.status}"
                    )
                response_body = response.read(MAX_FRAME_BYTES + 1)
        except HTTPError as error:
            raise _relay_http_error("message publish", error) from error
        if len(response_body) > MAX_FRAME_BYTES:
            raise ConnectionError("message publish response exceeds 64 KiB")
        try:
            payload = json.loads(response_body.decode("utf-8"))
            ack = payload["ack"]
            sequence = int(ack["seq"])
        except (KeyError, TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ConnectionError("message publish returned an invalid acknowledgement") from error
        if (
            payload.get("ok") is not True
            or ack.get("type") != "ack"
            or ack.get("id") != envelope.get("id")
            or sequence < 1
        ):
            raise ConnectionError("message publish acknowledgement does not match the request")
        return ack

    def _http_headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.agent_secret}",
            "Accept": "application/json",
            "User-Agent": HTTP_USER_AGENT,
            "X-Hermes-Role": "agent",
            "X-Hermes-Agent-Id": self.agent_id,
            "X-Hermes-Space": self.space_id,
        }

    async def _encrypt_and_upload_image(self, image_url: str) -> dict[str, Any]:
        parsed = urlsplit(str(image_url or ""))
        source = image_url
        if parsed.scheme in {"https", "http"}:
            source = await cache_image_from_url(image_url)
        elif parsed.scheme == "file":
            source = self.validate_media_delivery_path(unquote(parsed.path))
            if not source:
                raise ValueError("Unsafe or unreadable image path")
        elif parsed.scheme == "":
            source = self.validate_media_delivery_path(str(image_url or ""))
            if not source:
                raise ValueError("Unsafe or unreadable image path")
        return await self._encrypt_and_upload_local_file(
            source,
            file_name=None,
            allowed_categories={"image"},
        )

    async def _encrypt_and_upload_local_file(
        self,
        file_path: str,
        *,
        file_name: str | None,
        allowed_categories: set[str],
    ) -> dict[str, Any]:
        path, size, content_type, filename = await asyncio.to_thread(
            self._inspect_outbound_file,
            file_path,
            file_name,
            allowed_categories,
        )
        if size > MAX_ATTACHMENT_BYTES:
            return await asyncio.to_thread(
                self._upload_direct_file,
                path,
                plaintext_bytes=size,
                content_type=content_type,
                filename=filename,
            )
        data = await asyncio.to_thread(self._read_small_outbound_file, path, size)
        encrypted = self._cipher.encrypt_attachment(
            data,
            content_type=content_type,
            filename=filename,
        )
        await asyncio.to_thread(
            self._upload_attachment,
            encrypted.descriptor["id"],
            encrypted.ciphertext,
        )
        return encrypted.descriptor

    def _read_outbound_image(self, image_url: str):
        return self._read_outbound_file(image_url, None, {"image"})

    def _read_outbound_file(
        self,
        file_path: str,
        file_name: str | None,
        allowed_categories: set[str],
    ):
        path, size, content_type, filename = self._inspect_outbound_file(
            file_path,
            file_name,
            allowed_categories,
        )
        if size > MAX_ATTACHMENT_BYTES:
            raise ValueError("outbound attachment exceeds 10 MiB")
        return self._read_small_outbound_file(path, size), content_type, filename

    def _inspect_outbound_file(
        self,
        file_path: str,
        file_name: str | None,
        allowed_categories: set[str],
    ) -> tuple[Path, int, str, str]:
        parsed = urlsplit(str(file_path or ""))
        if parsed.scheme not in {"", "file"}:
            raise ValueError("outbound attachment must be a local file")
        path = Path(
            unquote(parsed.path) if parsed.scheme == "file" else str(file_path)
        ).expanduser().resolve()
        if not path.is_file():
            raise ValueError("outbound attachment is not a readable file")
        size = path.stat().st_size
        maximum_bytes = _agent_attachment_max_bytes()
        if size < 1 or size > maximum_bytes:
            raise ValueError(
                f"outbound attachment exceeds the Agent limit of {maximum_bytes} bytes"
            )
        filename = Path(str(file_name or path.name)).name or path.name
        guessed_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        content_type, category = _resolve_file_type(filename, guessed_type)
        if category not in allowed_categories:
            raise ValueError(f"attachment category {category} is not supported by this send method")
        return path, size, content_type, filename

    @staticmethod
    def _read_small_outbound_file(path: Path, size: int) -> bytes:
        with path.open("rb") as source:
            data = source.read(MAX_ATTACHMENT_BYTES + 1)
        if len(data) != size or len(data) > MAX_ATTACHMENT_BYTES:
            raise ValueError("outbound attachment changed or exceeded 10 MiB while reading")
        return data

    def _cleanup_media_cache(self) -> None:
        cutoff = time.time() - 24 * 60 * 60
        for path in self._media_directory.iterdir():
            try:
                if path.is_file() and path.stat().st_mtime < cutoff:
                    path.unlink()
            except OSError:
                logger.debug("Cloudflare Chat cache cleanup failed for %s", path)

    def _load_last_sequence(self) -> int:
        try:
            state = json.loads(self._state_path.read_text(encoding="utf-8"))
            if state.get("spaceId") != self.space_id:
                return 0
            sequence = int(state.get("lastSequence") or 0)
            return sequence if sequence >= 0 else 0
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return 0

    def _save_last_sequence(self) -> None:
        self._state_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = self._state_path.with_suffix(f".{os.getpid()}.tmp")
        payload = json.dumps(
            {"spaceId": self.space_id, "lastSequence": self._last_sequence},
            separators=(",", ":"),
        )
        temporary.write_text(payload, encoding="utf-8")
        temporary.chmod(0o600)
        os.replace(temporary, self._state_path)

    def _acquire_lock(self) -> bool:
        try:
            from gateway.status import acquire_scoped_lock
            digest = hashlib.sha256(
                f"{self.relay_url}|{self.agent_id}|{self.space_id}".encode("utf-8")
            ).hexdigest()
            if not acquire_scoped_lock("cloudflare_chat", digest):
                return False
            self._lock_key = digest
        except ImportError:
            self._lock_key = None
        return True

    def _release_lock(self) -> None:
        if not self._lock_key:
            return
        try:
            from gateway.status import release_scoped_lock
            release_scoped_lock("cloudflare_chat", self._lock_key)
        except Exception:
            logger.debug("Cloudflare Chat scoped lock release failed", exc_info=True)
        self._lock_key = None


async def _standalone_send(
    pconfig,
    chat_id: str,
    message: str,
    *,
    thread_id=None,
    media_files=None,
    force_document: bool = False,
) -> dict[str, Any]:
    """Deliver cron output without opening a second long-lived agent socket."""
    del thread_id, force_document
    adapter: CloudflareChatAdapter | None = None
    attachments: list[dict[str, Any]] = []
    try:
        adapter = CloudflareChatAdapter(pconfig)
        if not _valid_configuration(
            adapter.relay_url,
            adapter.agent_secret,
            adapter.agent_id,
            adapter.space_id,
        ):
            return {"error": "Cloudflare Chat standalone send is not configured"}

        target_space = str(chat_id or adapter.space_id).strip().lower()
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", target_space):
            return {"error": "Cloudflare Chat standalone send has an invalid chat id"}
        if target_space != adapter.space_id:
            return {
                "error": (
                    "Cloudflare Chat standalone send cannot cross profiles; "
                    f"target {target_space!r} does not match HERMES_CF_SPACE_ID"
                )
            }

        text = str(message or "")
        delivered_spans: list[tuple[int, int]] = []
        standalone_media = list(media_files or [])
        if len(standalone_media) > MAX_MESSAGE_ATTACHMENTS:
            return {"error": "Cloudflare Chat supports at most 8 attachments per message"}
        safe_media_paths: list[str] = []
        for media_file in standalone_media:
            media_path = _standalone_media_path(media_file)
            safe_path = adapter.validate_media_delivery_path(media_path)
            if not safe_path:
                return {"error": "Cloudflare Chat standalone media path is unsafe or unreadable"}
            safe_media_paths.append(safe_path)
        inline_capacity = MAX_MESSAGE_ATTACHMENTS - len(standalone_media)
        for start, end, source in _inline_image_candidates(text):
            if len(attachments) >= inline_capacity:
                break
            try:
                attachments.append(await adapter._encrypt_and_upload_image(source))
                delivered_spans.append((start, end))
            except Exception as error:
                logger.warning(
                    "Cloudflare Chat standalone inline image upload failed: %s",
                    error,
                )

        for safe_path in safe_media_paths:
            attachments.append(await adapter._encrypt_and_upload_local_file(
                safe_path,
                file_name=None,
                allowed_categories=set(_supported_categories()),
            ))

        envelope = adapter._cipher.encrypt_message(
            sender="agent",
            text=_remove_delivered_spans(text, delivered_spans),
            attachments=attachments,
        )
        ack = await asyncio.to_thread(adapter._publish_message, envelope)
        return {"success": True, "message_id": str(ack["seq"])}
    except asyncio.CancelledError:
        raise
    except Exception as error:
        logger.debug("Cloudflare Chat standalone send failed", exc_info=True)
        return {"error": f"Cloudflare Chat standalone send failed: {error}"}


def _interaction_option(
    option_id: str,
    label: str,
    *,
    style: str = "default",
    selected: bool = False,
    disabled: bool = False,
    wide: bool = False,
) -> dict[str, Any]:
    safe_label = str(label or "").strip() or "选项"
    if len(safe_label) > 120:
        safe_label = safe_label[:117] + "..."
    result: dict[str, Any] = {
        "id": str(option_id),
        "label": safe_label,
        "style": style,
    }
    if selected:
        result["selected"] = True
    if disabled:
        result["disabled"] = True
    if wide:
        result["wide"] = True
    return result


def _interaction_payload(
    prompt_id: str,
    kind: str,
    state: str,
    expires_at: int,
    options: list[dict[str, Any]],
    *,
    stage: str = "",
    status: str = "",
    page_info: str = "",
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": prompt_id,
        "kind": kind,
        "state": state,
        "expiresAt": expires_at,
        "options": options,
    }
    if stage:
        payload["stage"] = stage
    if status:
        payload["status"] = str(status)[:500]
    if page_info:
        payload["pageInfo"] = str(page_info)[:100]
    return payload


def _paginate(values: list, page: int, per_page: int) -> tuple[list, int, int, int]:
    total_pages = max(1, (len(values) + per_page - 1) // per_page)
    safe_page = max(0, min(int(page), total_pages - 1))
    start = safe_page * per_page
    return values[start:start + per_page], safe_page, total_pages, start


def _append_page_actions(
    options: list[dict[str, Any]],
    values: dict[str, Any],
    page: int,
    total_pages: int,
    action_type: str,
) -> None:
    if page > 0:
        options.append(_interaction_option("prev", "上一页"))
        values["prev"] = {"type": action_type, "page": page - 1}
    if page < total_pages - 1:
        options.append(_interaction_option("next", "下一页"))
        values["next"] = {"type": action_type, "page": page + 1}


async def _await_callback(callback, *args):
    if callback is None:
        raise RuntimeError("Hermes interaction callback expired")
    result = callback(*args)
    if inspect.isawaitable(result):
        return await result
    return result


def _standalone_media_path(value: Any) -> str:
    if isinstance(value, (tuple, list)):
        value = value[0] if value else ""
    return str(value or "")


def _supported_categories() -> frozenset[str]:
    return frozenset(category for _, category in _SUPPORTED_FILE_TYPES.values())


def _resolve_file_type(filename: str, content_type: str) -> tuple[str, str]:
    extension = Path(str(filename or "")).suffix.lower()
    by_extension = _SUPPORTED_FILE_TYPES.get(extension)
    if by_extension is not None:
        return by_extension

    normalized_type = str(content_type or "application/octet-stream")
    normalized_type = normalized_type.split(";", 1)[0].strip().lower()
    normalized_type = _CONTENT_TYPE_ALIASES.get(normalized_type, normalized_type)
    if normalized_type != "application/octet-stream":
        for canonical_type, category in _SUPPORTED_FILE_TYPES.values():
            if normalized_type == canonical_type:
                return canonical_type, category
    raise ValueError("unsupported attachment format")


def _message_type_for_categories(categories: list[str]):
    if not categories:
        return MessageType.TEXT
    if all(category == "image" for category in categories):
        return MessageType.PHOTO
    if all(category == "audio" for category in categories):
        return MessageType.VOICE
    if all(category == "video" for category in categories):
        return MessageType.VIDEO
    return MessageType.DOCUMENT


def _inline_image_candidates(text: str) -> list[tuple[int, int, str]]:
    candidates: list[tuple[int, int, str]] = []
    for match in _MARKDOWN_IMAGE_RE.finditer(text):
        candidates.append((match.start(), match.end(), match.group("source")))
    for match in _MEDIA_IMAGE_RE.finditer(text):
        source = match.group("source").strip()
        if len(source) >= 2 and source[0] == source[-1] and source[0] in "`\"'":
            source = source[1:-1].strip()
        parsed = urlsplit(source)
        local_path = unquote(parsed.path) if parsed.scheme == "file" else source
        if parsed.scheme not in {"", "file"} or not Path(local_path).is_absolute():
            continue
        if Path(local_path).suffix.lower() not in _IMAGE_EXTENSIONS:
            continue
        candidates.append((match.start(), match.end(), source))

    accepted: list[tuple[int, int, str]] = []
    previous_end = -1
    for candidate in sorted(candidates, key=lambda item: (item[0], item[1])):
        if candidate[0] < previous_end:
            continue
        accepted.append(candidate)
        previous_end = candidate[1]
    return accepted


def _remove_delivered_spans(text: str, spans: list[tuple[int, int]]) -> str:
    cleaned = text
    for start, end in sorted(spans, reverse=True):
        cleaned = cleaned[:start] + cleaned[end:]
    return re.sub(r"\n{3,}", "\n\n", cleaned).strip()


def _attachment_http_error(action: str, error: HTTPError) -> ConnectionError:
    return _relay_http_error(f"attachment {action}", error)


def _relay_http_error(action: str, error: HTTPError) -> ConnectionError:
    try:
        detail = error.read(1024).decode("utf-8", errors="replace")
    except Exception:
        detail = ""
    detail = re.sub(r"\s+", " ", detail).strip()[:300]
    headers = getattr(error, "headers", None)
    ray_id = headers.get("CF-Ray", "") if headers is not None else ""
    message = f"{action} returned HTTP {error.code}"
    if detail:
        message += f": {detail}"
    if ray_id:
        message += f" (CF-Ray {ray_id})"
    return ConnectionError(message)


def _valid_configuration(relay_url: str, secret: str, agent_id: str, space_id: str) -> bool:
    parsed = urlsplit(relay_url)
    return (
        parsed.scheme == "wss"
        and bool(parsed.netloc)
        and parsed.path == "/api/hermes-chat/ws"
        and len(secret) >= 32
        and bool(agent_id)
        and bool(space_id)
    )


def check_requirements() -> bool:
    try:
        import cryptography  # noqa: F401
        import websockets  # noqa: F401
        from .crypto_codec import decode_chat_key as available_decode_chat_key
    except ImportError:
        return False
    try:
        available_decode_chat_key(_get_secret("HERMES_CF_CHAT_KEY"))
    except Exception:
        return False
    return _valid_configuration(
        os.getenv("HERMES_CF_RELAY_URL", ""),
        _get_secret("HERMES_CF_AGENT_SECRET"),
        os.getenv("HERMES_CF_AGENT_ID", "nas-hermes"),
        os.getenv("HERMES_CF_SPACE_ID", ""),
    )


def validate_config(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    relay_url = os.getenv("HERMES_CF_RELAY_URL") or extra.get("relay_url", "")
    agent_id = os.getenv("HERMES_CF_AGENT_ID") or extra.get("agent_id", "nas-hermes")
    space_id = os.getenv("HERMES_CF_SPACE_ID") or extra.get("space_id", "")
    try:
        if decode_chat_key is None:
            return False
        decode_chat_key(_get_secret("HERMES_CF_CHAT_KEY"))
    except Exception:
        return False
    return _valid_configuration(
        relay_url,
        _get_secret("HERMES_CF_AGENT_SECRET") or extra.get("agent_secret", ""),
        agent_id,
        space_id,
    )


def _env_enablement() -> dict[str, Any] | None:
    if not check_requirements():
        return None
    space_id = os.getenv("HERMES_CF_SPACE_ID", "").strip()
    return {
        "relay_url": os.getenv("HERMES_CF_RELAY_URL", "").strip(),
        "agent_id": os.getenv("HERMES_CF_AGENT_ID", "nas-hermes").strip() or "nas-hermes",
        "space_id": space_id,
        "home_channel": {"chat_id": space_id, "name": "Android Notes"},
    }


def register(ctx) -> None:
    ctx.register_platform(
        name="cloudflare_chat",
        label="Cloudflare Chat",
        adapter_factory=lambda config: CloudflareChatAdapter(config),
        check_fn=check_requirements,
        validate_config=validate_config,
        required_env=[
            "HERMES_CF_RELAY_URL",
            "HERMES_CF_AGENT_SECRET",
            "HERMES_CF_CHAT_KEY",
            "HERMES_CF_SPACE_ID",
        ],
        install_hint="Install requirements.txt into the same Python environment as Hermes",
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="HERMES_CF_SPACE_ID",
        standalone_sender_fn=_standalone_send,
        allowed_users_env="HERMES_CF_ALLOWED_USERS",
        allow_all_env="HERMES_CF_ALLOW_ALL_USERS",
        max_message_length=50_000,
        emoji="☁️",
        pii_safe=False,
        allow_update_command=True,
        platform_hint=(
            "You are chatting with the owner through private Android and macOS notes apps. "
            "Telegram-style Markdown, fenced code blocks, images, audio, video, documents, "
            "Office files, archives, and EPUB files are supported. User uploads remain "
            "limited to 10 MiB; generated Agent output can use private R2 direct upload "
            "up to the configured 512 MiB default. "
            "Use the platform document, voice, or video delivery methods for generated files "
            "and only provide safe local absolute paths. After image_generate succeeds, "
            "always include a standalone MEDIA:<absolute-path> line in the final response, "
            "using the first available local path from agent_visible_image, host_image, or "
            "image in the tool result. Keep the MEDIA line even when the tool already reports "
            "success; never deliver credentials, configuration, or other sensitive files."
        ),
    )
