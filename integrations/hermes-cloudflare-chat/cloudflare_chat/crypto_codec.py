"""Wire-compatible AES-GCM codec shared conceptually with the Android client."""

from __future__ import annotations

import base64
import json
import os
import re
import time
import uuid
from dataclasses import dataclass
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


PROTOCOL_VERSION = 1
MAX_TEXT_CHARS = 50_000
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
MAX_AGENT_ATTACHMENT_BYTES = 512 * 1024 * 1024
PRIVATE_ATTACHMENT_STORAGE = "r2-private-v1"
MAX_INTERACTION_OPTIONS = 24
INTERACTION_KINDS = frozenset({
    "approval",
    "slash_confirm",
    "clarify",
    "model",
    "choice",
})
INTERACTION_STATES = frozenset({"pending", "resolved", "expired", "error"})
INTERACTION_STYLES = frozenset({"default", "primary", "danger", "warning"})


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
        interaction: dict[str, Any] | None = None,
        interaction_response: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if sender not in {"client", "agent"}:
            raise ValueError("invalid sender")
        if not isinstance(text, str) or len(text) > MAX_TEXT_CHARS:
            raise ValueError("message text is invalid or too large")
        message_id = message_id or str(uuid.uuid4())
        sent_at = int(sent_at if sent_at is not None else time.time() * 1000)
        payload: dict[str, Any] = {
            "text": text,
            "attachments": _normalize_attachments(attachments or [], sender=sender),
        }
        if interaction is not None and interaction_response is not None:
            raise ValueError("message cannot contain both an interaction and a response")
        if interaction is not None:
            if sender != "agent":
                raise ValueError("only the agent may send interactions")
            payload["interaction"] = _normalize_interaction(interaction)
        if interaction_response is not None:
            if sender != "client":
                raise ValueError("only the client may send interaction responses")
            payload["interactionResponse"] = _normalize_interaction_response(
                interaction_response
            )
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
        attachments = _normalize_attachments(attachments, sender=expected_sender)
        result = {"text": text, "attachments": attachments}
        if "interaction" in payload:
            if expected_sender != "agent":
                raise ValueError("unexpected interaction sender")
            result["interaction"] = _normalize_interaction(payload["interaction"])
        if "interactionResponse" in payload:
            if expected_sender != "client":
                raise ValueError("unexpected interaction response sender")
            result["interactionResponse"] = _normalize_interaction_response(
                payload["interactionResponse"]
            )
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
        if descriptor.get("storage") == PRIVATE_ATTACHMENT_STORAGE:
            raise ValueError("private R2 attachments are not encrypted chat attachments")
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


def _normalize_attachments(value: Any, *, sender: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > 8:
        raise ValueError("decrypted attachment list is invalid")
    result: list[dict[str, Any]] = []
    for raw in value:
        if not isinstance(raw, dict):
            raise ValueError("attachment descriptor must be an object")
        attachment_id = _safe_uuid(raw.get("id"), "attachment id")
        filename = _safe_filename(str(raw.get("name") or "attachment.bin"))
        content_type = _safe_content_type(str(raw.get("contentType") or ""))
        plaintext_bytes = raw.get("plaintextBytes")
        if (
            not isinstance(plaintext_bytes, int)
            or isinstance(plaintext_bytes, bool)
            or plaintext_bytes < 1
        ):
            raise ValueError("attachment size is invalid")
        storage = str(raw.get("storage") or "")
        if storage == PRIVATE_ATTACHMENT_STORAGE:
            sha256 = str(raw.get("sha256") or "").lower()
            if (
                sender != "agent"
                or plaintext_bytes <= MAX_ATTACHMENT_BYTES
                or plaintext_bytes > MAX_AGENT_ATTACHMENT_BYTES
                or not re.fullmatch(r"[0-9a-f]{64}", sha256)
            ):
                raise ValueError("private R2 attachment descriptor is invalid")
            result.append({
                "id": attachment_id,
                "name": filename,
                "contentType": content_type,
                "plaintextBytes": plaintext_bytes,
                "storage": PRIVATE_ATTACHMENT_STORAGE,
                "sha256": sha256,
            })
            continue
        if storage not in {"", "encrypted-v1"} or plaintext_bytes > MAX_ATTACHMENT_BYTES:
            raise ValueError("encrypted attachment descriptor is invalid")
        nonce = str(raw.get("nonce") or "")
        if len(_b64url_decode(nonce)) != 12:
            raise ValueError("encrypted attachment nonce is invalid")
        descriptor = {
            "id": attachment_id,
            "name": filename,
            "contentType": content_type,
            "plaintextBytes": plaintext_bytes,
            "nonce": nonce,
        }
        if storage:
            descriptor["storage"] = storage
        result.append(descriptor)
    return result


def _normalize_interaction(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("interaction must be an object")
    prompt_id = _safe_uuid(value.get("id"), "interaction id")
    kind = str(value.get("kind") or "")
    state = str(value.get("state") or "")
    if kind not in INTERACTION_KINDS or state not in INTERACTION_STATES:
        raise ValueError("interaction kind or state is invalid")
    expires_at = value.get("expiresAt")
    if (
        not isinstance(expires_at, int)
        or isinstance(expires_at, bool)
        or expires_at < 0
    ):
        raise ValueError("interaction expiry is invalid")
    raw_options = value.get("options", [])
    if not isinstance(raw_options, list) or len(raw_options) > MAX_INTERACTION_OPTIONS:
        raise ValueError("interaction options are invalid")
    options: list[dict[str, Any]] = []
    for raw in raw_options:
        if not isinstance(raw, dict):
            raise ValueError("interaction option must be an object")
        option_id = str(raw.get("id") or "")
        label = str(raw.get("label") or "")
        style = str(raw.get("style") or "default")
        if not re_fullmatch_token(option_id) or not 1 <= len(label) <= 120:
            raise ValueError("interaction option id or label is invalid")
        if style not in INTERACTION_STYLES:
            raise ValueError("interaction option style is invalid")
        option = {"id": option_id, "label": label, "style": style}
        for boolean_key in ("selected", "disabled", "wide"):
            if boolean_key in raw:
                if not isinstance(raw[boolean_key], bool):
                    raise ValueError("interaction option flag is invalid")
                option[boolean_key] = raw[boolean_key]
        options.append(option)
    if state == "pending" and not options:
        raise ValueError("pending interaction requires options")
    result: dict[str, Any] = {
        "id": prompt_id,
        "kind": kind,
        "state": state,
        "expiresAt": expires_at,
        "options": options,
    }
    stage = str(value.get("stage") or "")
    status = str(value.get("status") or "")
    page_info = str(value.get("pageInfo") or "")
    if stage:
        if not re_fullmatch_token(stage, maximum=32):
            raise ValueError("interaction stage is invalid")
        result["stage"] = stage
    if status:
        if len(status) > 500:
            raise ValueError("interaction status is too long")
        result["status"] = status
    if page_info:
        if len(page_info) > 100:
            raise ValueError("interaction page info is too long")
        result["pageInfo"] = page_info
    return result


def _normalize_interaction_response(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        raise ValueError("interaction response must be an object")
    prompt_id = _safe_uuid(value.get("promptId"), "interaction response id")
    option_id = str(value.get("optionId") or "")
    if not re_fullmatch_token(option_id):
        raise ValueError("interaction response option is invalid")
    return {"promptId": prompt_id, "optionId": option_id}


def _safe_uuid(value: Any, label: str) -> str:
    text = str(value or "")
    try:
        parsed = uuid.UUID(text)
    except (ValueError, AttributeError, TypeError) as error:
        raise ValueError(f"{label} is invalid") from error
    if str(parsed) != text.lower():
        raise ValueError(f"{label} is invalid")
    return text.lower()


def re_fullmatch_token(value: str, maximum: int = 64) -> bool:
    if not 1 <= len(value) <= maximum:
        return False
    return all(
        "a" <= character <= "z"
        or "A" <= character <= "Z"
        or "0" <= character <= "9"
        or character in "_-"
        for character in value
    )
