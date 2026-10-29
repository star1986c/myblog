#!/usr/bin/env python3
"""Build a reproducible, metadata-free ZIP for the NAS Cloudflare Chat plugin."""

import hashlib
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "integrations/hermes-cloudflare-chat/cloudflare_chat"
OUTPUT = ROOT / "output"
FILES = ("README.md", "__init__.py", "adapter.py", "crypto_codec.py", "plugin.yaml", "requirements.txt")
PREFIX = "cloudflare_chat/"


def main():
    # Read only release files, never filesystem metadata, caches or credentials.
    payloads = {}
    for name in FILES:
        path = SOURCE / name
        if not path.is_file() or path.is_symlink():
            raise ValueError(f"Missing or symbolic-link release file: {name}")
        payloads[PREFIX + name] = path.read_bytes()
    version = re.search(r"^version: ([0-9]+\.[0-9]+\.[0-9]+)\s*$",
                        payloads[PREFIX + "plugin.yaml"].decode(), re.MULTILINE)
    if not version:
        raise ValueError("Expected a numeric plugin.yaml version")
    OUTPUT.mkdir(exist_ok=True)
    archive_path = OUTPUT / f"cloudflare_chat-{version[1]}.zip"
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, content in [(PREFIX, b""), *sorted(payloads.items())]:
            # Do not use ZipFile.write: fixed timestamps/permissions and empty
            # extra fields exclude host paths, xattrs, resource forks and UID/GID.
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3  # Portable Unix permissions, not macOS attributes.
            entry.external_attr = ((0o40755 << 16) | 0x10) if name == PREFIX else (0o100644 << 16)
            archive.writestr(entry, content, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    with zipfile.ZipFile(archive_path) as archive:
        assert archive.testzip() is None
        assert archive.namelist() == [PREFIX, *sorted(payloads)]
        assert not archive.comment
        for entry in archive.infolist():
            assert not entry.extra and not entry.comment, entry.filename
            assert not any(part in ("__MACOSX", ".DS_Store", "__pycache__") or part.startswith("._")
                           for part in Path(entry.filename).parts), entry.filename
        for name, content in payloads.items():
            assert archive.read(name) == content, name
    digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    checksum_path = OUTPUT / f"cloudflare_chat-{version[1]}-SHA256SUMS.txt"
    checksum_path.write_text(f"{digest}  {archive_path.name}\n")
    print(f"{archive_path}\nSHA-256: {digest}\nVerified {len(payloads)} release files; no macOS metadata.")


if __name__ == "__main__":
    main()
