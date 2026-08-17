import base64
import unittest

from cloudflare_chat.crypto_codec import ChatCipher, decode_chat_key


class ChatCipherTests(unittest.TestCase):
    def setUp(self):
        self.key = bytes(range(32))
        self.cipher = ChatCipher(self.key)

    def test_message_round_trip(self):
        envelope = self.cipher.encrypt_message(
            sender="client",
            text="你好，Hermes",
            message_id="550e8400-e29b-41d4-a716-446655440000",
            sent_at=1_800_000_000_000,
        )

        self.assertEqual(
            self.cipher.decrypt_message(envelope, expected_sender="client"),
            {"text": "你好，Hermes", "attachments": []},
        )
        with self.assertRaises(ValueError):
            self.cipher.decrypt_message(envelope, expected_sender="agent")

    def test_stream_edit_metadata_is_encrypted_and_round_trips(self):
        envelope = self.cipher.encrypt_message(
            sender="agent",
            text="正在流式输出",
            replace_seq=42,
            final=True,
            message_id="550e8400-e29b-41d4-a716-446655440010",
            sent_at=1_800_000_000_100,
        )

        self.assertNotIn("replaceSeq", envelope)
        self.assertNotIn("正在流式输出", str(envelope))
        self.assertEqual(
            self.cipher.decrypt_message(envelope, expected_sender="agent"),
            {
                "text": "正在流式输出",
                "attachments": [],
                "replaceSeq": 42,
                "final": True,
            },
        )

    def test_android_wire_fixture(self):
        envelope = {
            "v": 1,
            "type": "message",
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "sender": "agent",
            "sentAt": 1_800_000_000_000,
            "encrypted": {
                "alg": "A256GCM",
                "nonce": "AAECAwQFBgcICQoL",
                "ciphertext": (
                    "PCCifr2R4CGvqSAjVkLXTeuz61ifWXNeWROR5H4BbddvZN3elZpP5W00"
                    "JWv4qPMrDG21sPX9lI0"
                ),
            },
        }
        self.assertEqual(
            self.cipher.decrypt_message(envelope, expected_sender="agent"),
            {"text": "跨端 hello", "attachments": []},
        )

    def test_attachment_round_trip_authenticates_metadata(self):
        encrypted = self.cipher.encrypt_attachment(
            b"fake-image-data",
            content_type="image/jpeg",
            filename="camera.jpg",
            attachment_id="550e8400-e29b-41d4-a716-446655440001",
        )

        self.assertEqual(
            self.cipher.decrypt_attachment(encrypted.ciphertext, encrypted.descriptor),
            b"fake-image-data",
        )
        tampered = dict(encrypted.descriptor, contentType="image/png")
        with self.assertRaises(Exception):
            self.cipher.decrypt_attachment(encrypted.ciphertext, tampered)

    def test_chat_key_requires_exactly_32_bytes(self):
        encoded = base64.urlsafe_b64encode(self.key).decode("ascii").rstrip("=")
        self.assertEqual(decode_chat_key(encoded), self.key)
        with self.assertRaises(ValueError):
            decode_chat_key("c2hvcnQ")


if __name__ == "__main__":
    unittest.main()
