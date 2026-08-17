"""Hermes platform adapter for the private Cloudflare chat relay."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import mimetypes
import os
import re
import time
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
    from .crypto_codec import ChatCipher, MAX_ATTACHMENT_BYTES, decode_chat_key
except ImportError:
    websocket_connect = None
    ChatCipher = None
    MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
    decode_chat_key = None


logger = logging.getLogger(__name__)
MAX_FRAME_BYTES = 64 * 1024
MAX_MESSAGE_ATTACHMENTS = 8
HTTP_USER_AGENT = "Hermes-Cloudflare-Chat/0.1.3"
_IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"})
_MARKDOWN_IMAGE_RE = re.compile(
    r"!\[[^\]\r\n]*\]\(\s*(?P<source>(?:https?://|file://|/)[^\s)]+)\s*\)",
    re.IGNORECASE,
)
_MEDIA_IMAGE_RE = re.compile(
    r"^[ \t]*MEDIA:[ \t]*(?P<source>[^\r\n]+?)[ \t]*$",
    re.IGNORECASE | re.MULTILINE,
)


def _get_secret(name: str, default: str = "") -> str:
    try:
        value = _scoped_get_secret(name, default)
    except _UnscopedSecretError:
        value = os.getenv(name, default)
    return str(value or default)


class CloudflareChatAdapter(BasePlatformAdapter):
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
        self._socket = None
        for future in self._pending_acks.values():
            if not future.done():
                future.set_exception(ConnectionError("Cloudflare Chat disconnected"))
        self._pending_acks.clear()
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
            await self._handle_inbound_message(frame.get("message") or {})
            self._last_sequence = sequence
            await asyncio.to_thread(self._save_last_sequence)
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

    async def _handle_inbound_message(self, envelope: dict[str, Any]) -> None:
        payload = self._cipher.decrypt_message(envelope, expected_sender="client")
        media_urls: list[str] = []
        media_types: list[str] = []
        for descriptor in payload["attachments"]:
            path, content_type = await self._download_and_decrypt_attachment(descriptor)
            media_urls.append(str(path))
            media_types.append(content_type)

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
            message_type=MessageType.PHOTO if media_urls else MessageType.TEXT,
            user_id="android-owner",
            user_name="Android Owner",
            source=source,
            message_id=str(envelope.get("id") or ""),
            media_urls=media_urls,
            media_types=media_types,
            raw_message=envelope,
        )
        await self.handle_message(event)

    async def _send_payload(self, text: str, attachments: list[dict[str, Any]]):
        envelope = self._cipher.encrypt_message(
            sender="agent",
            text=text,
            attachments=attachments,
        )
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._pending_acks[envelope["id"]] = future
        try:
            await self._send_frame(envelope)
            ack = await asyncio.wait_for(future, timeout=15.0)
            return SendResult(success=True, message_id=str(ack.get("seq") or envelope["id"]))
        except Exception as error:
            return SendResult(success=False, error=str(error), retryable=True)
        finally:
            self._pending_acks.pop(envelope["id"], None)

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
        ciphertext = await asyncio.to_thread(self._download_attachment, attachment_id)
        plaintext = self._cipher.decrypt_attachment(ciphertext, descriptor)
        self._media_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._cleanup_media_cache()
        filename = Path(str(descriptor.get("name") or "attachment.bin")).name
        target = self._media_directory / f"{attachment_id}-{filename}"
        target.write_bytes(plaintext)
        target.chmod(0o600)
        return target, str(descriptor.get("contentType") or "application/octet-stream")

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

    def _attachment_url(self, attachment_id: str) -> str:
        parsed = urlsplit(self.relay_url)
        scheme = "https" if parsed.scheme == "wss" else "http"
        return urlunsplit((scheme, parsed.netloc, f"/api/hermes-chat/attachments/{attachment_id}", "", ""))

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
        data, content_type, filename = await asyncio.to_thread(
            self._read_outbound_image,
            source,
        )
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
        parsed = urlsplit(str(image_url or ""))
        if parsed.scheme not in {"", "file"}:
            raise ValueError("outbound image must be cached to a local file first")
        path = Path(parsed.path if parsed.scheme == "file" else str(image_url)).expanduser().resolve()
        if not path.is_file():
            raise ValueError("outbound image is not a readable file")
        data = path.read_bytes()
        filename = path.name
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        if not content_type.startswith("image/"):
            raise ValueError("send_image accepts image content only")
        if not data or len(data) > MAX_ATTACHMENT_BYTES:
            raise ValueError("outbound image exceeds 10 MiB")
        return data, content_type, filename

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
    try:
        detail = error.read(1024).decode("utf-8", errors="replace")
    except Exception:
        detail = ""
    detail = re.sub(r"\s+", " ", detail).strip()[:300]
    headers = getattr(error, "headers", None)
    ray_id = headers.get("CF-Ray", "") if headers is not None else ""
    message = f"attachment {action} returned HTTP {error.code}"
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
        allowed_users_env="HERMES_CF_ALLOWED_USERS",
        allow_all_env="HERMES_CF_ALLOW_ALL_USERS",
        max_message_length=50_000,
        emoji="☁️",
        pii_safe=False,
        allow_update_command=True,
        platform_hint=(
            "You are chatting with the owner through a private Android notes app. "
            "Markdown and image attachments are supported. After image_generate succeeds, "
            "always include a standalone MEDIA:<absolute-path> line in the final response, "
            "using the first available local path from agent_visible_image, host_image, or "
            "image in the tool result. Keep the MEDIA line even when the tool already reports "
            "success; never use it for credentials, configuration, or other sensitive files."
        ),
    )
