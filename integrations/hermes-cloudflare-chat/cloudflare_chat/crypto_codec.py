"""Wire-compatible AES-GCM codec shared conceptually with the Android client."""

from __future__ import annotations

import base64
import json
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


PROTOCOL_VERSION = 1
MAX_TEXT_CHARS = 50_000
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64url_decode(value: str) -> bytes:
    if not isinstance(value, str) or not value:
        raise ValueError("base64url value is required")
    padded = value + "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def decode_chat_key(value: str) -> bytes:
    key = _b64url_decode((value or "").strip())
    if len(key) != 32:
        raise ValueError("HERMES_CF_CHAT_KEY must encode exactly 32 bytes")
    return key


def message_aad(message_id: str, sender: str, sent_at: int) -> bytes:
    return f"hermes-chat-message-v1|{message_id}|{sender}|{sent_at}".encode("utf-8")


def attachment_aad(
    attachment_id: str,
    content_type: str,
    plaintext_bytes: int,
) -> bytes:
    return (
        f"hermes-chat-attachment-v1|{attachment_id}|{content_type}|{plaintext_bytes}"
    ).encode("utf-8")


@dataclass(frozen=True)
class EncryptedAttachment:
    descriptor: dict[str, Any]
    ciphertext: bytes


class ChatCipher:
    def __init__(self, key: bytes):
        if len(key) != 32:
            raise ValueError("chat key must be 32 bytes")
        self._aes = AESGCM(key)

    def encrypt_message(
        self,
        *,
        sender: str,
        text: str,
        attachments: list[dict[str, Any]] | None = None,
        message_id: str | None = None,
        sent_at: int | None = None,
        replace_seq: int | None = None,
        final: bool = False,
    ) -> dict[str, Any]:
        if sender not in {"client", "agent"}:
            raise ValueError("invalid sender")
        if not isinstance(text, str) or len(text) > MAX_TEXT_CHARS:
            raise ValueError("message text is invalid or too large")
        message_id = message_id or str(uuid.uuid4())
        sent_at = int(sent_at if sent_at is not None else time.time() * 1000)
        payload: dict[str, Any] = {"text": text, "attachments": attachments or []}
        if replace_seq is not None:
            if not isinstance(replace_seq, int) or isinstance(replace_seq, bool) or replace_seq < 1:
                raise ValueError("replacement sequence must be a positive integer")
            if not isinstance(final, bool):
                raise ValueError("replacement final flag must be boolean")
            payload.update({"replaceSeq": replace_seq, "final": final})
        plaintext = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        nonce = os.urandom(12)
        ciphertext = self._aes.encrypt(
            nonce,
            plaintext,
            message_aad(message_id, sender, sent_at),
        )
        return {
            "v": PROTOCOL_VERSION,
            "type": "message",
            "id": message_id,
            "sender": sender,
            "sentAt": sent_at,
            "encrypted": {
                "alg": "A256GCM",
                "nonce": _b64url_encode(nonce),
                "ciphertext": _b64url_encode(ciphertext),
            },
        }

    def decrypt_message(
        self,
        envelope: dict[str, Any],
        *,
        expected_sender: str,
    ) -> dict[str, Any]:
        if envelope.get("v") != PROTOCOL_VERSION or envelope.get("type") != "message":
            raise ValueError("unsupported chat message")
        if envelope.get("sender") != expected_sender:
            raise ValueError("unexpected chat message sender")
        message_id = str(envelope.get("id") or "")
        sent_at = int(envelope.get("sentAt"))
        encrypted = envelope.get("encrypted") or {}
        if encrypted.get("alg") != "A256GCM":
            raise ValueError("unsupported chat encryption")
        plaintext = self._aes.decrypt(
            _b64url_decode(encrypted.get("nonce", "")),
            _b64url_decode(encrypted.get("ciphertext", "")),
            message_aad(message_id, expected_sender, sent_at),
        )
        payload = json.loads(plaintext.decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("invalid decrypted chat payload")
        text = payload.get("text", "")
        attachments = payload.get("attachments", [])
        if not isinstance(text, str) or len(text) > MAX_TEXT_CHARS:
            raise ValueError("decrypted message text is invalid")
        if not isinstance(attachments, list) or len(attachments) > 8:
            raise ValueError("decrypted attachment list is invalid")
        result = {"text": text, "attachments": attachments}
        if "replaceSeq" in payload or "final" in payload:
            replace_seq = payload.get("replaceSeq")
            final = payload.get("final")
            if (
                not isinstance(replace_seq, int)
                or isinstance(replace_seq, bool)
                or replace_seq < 1
                or not isinstance(final, bool)
            ):
                raise ValueError("decrypted replacement metadata is invalid")
            result.update({"replaceSeq": replace_seq, "final": final})
        return result

    def encrypt_attachment(
        self,
        data: bytes,
        *,
        content_type: str,
        filename: str,
        attachment_id: str | None = None,
    ) -> EncryptedAttachment:
        if not data or len(data) > MAX_ATTACHMENT_BYTES:
            raise ValueError("attachment must contain at most 10 MiB")
        attachment_id = attachment_id or str(uuid.uuid4())
        safe_content_type = _safe_content_type(content_type)
        nonce = os.urandom(12)
        ciphertext = self._aes.encrypt(
            nonce,
            data,
            attachment_aad(attachment_id, safe_content_type, len(data)),
        )
        return EncryptedAttachment(
            descriptor={
                "id": attachment_id,
                "name": _safe_filename(filename),
                "contentType": safe_content_type,
                "plaintextBytes": len(data),
                "nonce": _b64url_encode(nonce),
            },
            ciphertext=ciphertext,
        )

    def decrypt_attachment(self, ciphertext: bytes, descriptor: dict[str, Any]) -> bytes:
        attachment_id = str(descriptor.get("id") or "")
        content_type = _safe_content_type(str(descriptor.get("contentType") or ""))
        plaintext_bytes = int(descriptor.get("plaintextBytes"))
        if plaintext_bytes < 1 or plaintext_bytes > MAX_ATTACHMENT_BYTES:
            raise ValueError("invalid attachment size")
        plaintext = self._aes.decrypt(
            _b64url_decode(str(descriptor.get("nonce") or "")),
            ciphertext,
            attachment_aad(attachment_id, content_type, plaintext_bytes),
        )
        if len(plaintext) != plaintext_bytes:
            raise ValueError("attachment size does not match authenticated metadata")
        return plaintext


def _safe_filename(value: str) -> str:
    filename = "".join(
        character for character in str(value or "attachment.bin")
        if character.isalnum() or character in "._- "
    ).strip(" .")
    return (filename or "attachment.bin")[:120]


def _safe_content_type(value: str) -> str:
    content_type = str(value or "application/octet-stream").strip().lower()
    if len(content_type) > 100 or not all(
        character.isalnum() or character in "!#$&^_.+-/" for character in content_type
    ):
        raise ValueError("invalid attachment content type")
    return content_type
