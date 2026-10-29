#!/usr/bin/env python3
"""Renew a pinned personal iPhone build; called by the local Codex heartbeat.

No passwords, private keys, device erase, app uninstall, or certificate revocation.
Only a confirmed install advances the recorded on-device expiration.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import signal
import subprocess
import sys
import tempfile

UTC = timezone.utc
DEFAULT_ROOT = Path.home() / "Library/Application Support/MyNotesRenewal"


def timestamp(value):
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as out:
        json.dump(value, out, indent=2, ensure_ascii=False)
        out.write("\n")
        temporary = out.name
    os.replace(temporary, path)


def renew_due(state, now, hours):
    return timestamp(state["installed_expiration"]) <= now + timedelta(hours=hours)


def matching_profile(profile, config):
    return (profile.get("TeamIdentifier") == [config["team"]]
            and profile.get("Entitlements", {}).get("application-identifier")
            == config["team"] + "." + config["bundle_id"])


def validate_installed_app(apps, config):
    app = next((app for app in apps if app.get("bundleIdentifier") == config["bundle_id"]), None)
    if app is None:
        raise RuntimeError("手机上已找不到 My Notes；停止续签，不自动重新安装被卸载的应用。")
    if (app.get("version"), app.get("bundleVersion")) != (config["version"], config["build_number"]):
        raise RuntimeError("手机上的 My Notes 版本已变化；请更新续签源码快照，避免覆盖回旧版。")


def validate_profile(profile, config, now, previous=None):
    if not matching_profile(profile, config):
        raise RuntimeError("签名团队或应用标识不匹配，未安装。")
    if config["device"] not in profile.get("ProvisionedDevices", []):
        raise RuntimeError("新描述文件未包含目标 iPhone，未安装。")
    expiration = timestamp(profile["ExpirationDate"])
    if expiration <= now + timedelta(hours=config["renew_before_hours"]):
        raise RuntimeError("新描述文件剩余时间不足，未安装；请检查 Xcode 个人账号。")
    if previous and expiration <= timestamp(previous):
        raise RuntimeError("构建成功但签名有效期没有延长，未把它计为续签成功。")
    return expiration


def notification_needed(previous, status, now):
    # Repeat an unchanged failure at most once daily; recovery is silent.
    if status["status"] != "failed":
        return False
    last = previous.get("last_alert_at")
    return (status["reason"] != previous.get("last_alert_reason") or not last
            or now - timestamp(last) >= timedelta(hours=24))


class Runner:
    def __init__(self, root, config, interactive=False):
        self.root, self.config = root, config
        self.interactive = interactive
        self.logs = root / "logs"
        self.logs.mkdir(exist_ok=True)

    def run(self, args, name, timeout=120):
        logfile = self.logs / (name + ".log")
        if self.interactive:
            labels = {"device": "检查 iPhone 连接", "installed-app": "核对手机上的应用版本",
                      "build": "申请新签名并构建（通常需要 1–3 分钟）",
                      "verify-signature": "验证安装包签名", "install": "覆盖安装到 iPhone，保留应用数据"}
            print("→ " + labels.get(name, name), flush=True)
        with logfile.open("wb") as out:
            # Keep the logged-in macOS security session so Xcode can read its
            # account credentials. A separate process group still permits
            # terminating the whole build on timeout, without setsid().
            process = subprocess.Popen(args, stdout=out, stderr=subprocess.STDOUT,
                                       process_group=0)
            try:
                code = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                raise RuntimeError(f"{name} 超时；日志：{logfile}")
        if code:
            diagnostic = logfile.read_text(errors="replace")
            if name == "build" and ("No Accounts" in diagnostic or "missing Xcode-Username" in diagnostic):
                raise RuntimeError("Xcode 命令行未能读取 Apple 账号（No Accounts）。请在 Xcode → Settings → "
                                   f"Apple Accounts 重新登录个人账号，然后重试。日志：{logfile}")
            raise RuntimeError(f"{name} 失败（退出码 {code}）；日志：{logfile}")

    def device_command(self, parts, name, timeout=60):
        output = self.logs / (name + ".json")
        output.unlink(missing_ok=True)
        self.run(["/usr/bin/xcrun", "devicectl", "device", *parts,
                  "--device", self.config["device"], "--timeout", str(timeout),
                  "--json-output", str(output)], name, timeout + 15)
        result = json.loads(output.read_text())
        if result.get("info", {}).get("outcome") != "success":
            raise RuntimeError(f"{name} 未确认成功；日志：{output}")
        return result["result"]

    def profile(self, path):
        result = subprocess.run(["/usr/bin/security", "cms", "-D", "-i", str(path)],
                                capture_output=True, timeout=20, check=True)
        return plistlib.loads(result.stdout)

    def check_source(self):
        source = self.root / "source" / self.config["revision"]
        manifest = json.loads((self.root / "source-manifest.json").read_text())
        if not manifest:
            raise RuntimeError("固定源码清单为空。")
        for name, digest in manifest.items():
            path = source / name
            if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                raise RuntimeError("固定源码校验失败；停止自动构建，请重新核准发布版本。")
        # Additional source/config files must not quietly enter a renewal build.
        known = set(manifest)
        extras = [p for p in source.rglob("*") if p.is_file()
                  and str(p.relative_to(source)) not in known
                  and not any(x in p.parts for x in (".swiftpm", "xcuserdata", ".build"))]
        if extras:
            raise RuntimeError("固定源码出现额外文件；停止自动构建。")
        return source

    @contextmanager
    def refreshed_profile_cache(self):
        # Removing this exact app's local cache makes Xcode request a fresh profile.
        # Keep a reversible backup; never touch other apps or revoke server assets.
        backups = self.root / "profile-backups"
        backups.mkdir(exist_ok=True)
        moved = []
        try:
            for directory in self.config["profile_directories"]:
                for path in Path(directory).glob("*.mobileprovision"):
                    try:
                        profile = self.profile(path)
                    except (subprocess.SubprocessError, ValueError):
                        continue  # Unreadable/unrelated profiles are left untouched.
                    if matching_profile(profile, self.config):
                        data = path.read_bytes()
                        backup = backups / (hashlib.sha256(data).hexdigest() + ".mobileprovision")
                        backup.write_bytes(data)
                        backup.chmod(0o600)
                        moved.append((path, backup))
                        path.unlink()
            yield
        finally:
            # Restore only if Xcode failed to leave a replacement for this app.
            fresh = False
            for directory in self.config["profile_directories"]:
                for path in Path(directory).glob("*.mobileprovision"):
                    try:
                        if matching_profile(self.profile(path), self.config):
                            fresh = True
                    except (subprocess.SubprocessError, ValueError):
                        pass
            if not fresh:
                for path, backup in moved:
                    if not path.exists():
                        path.write_bytes(backup.read_bytes())
                        path.chmod(0o600)

    @property
    def app(self):
        return self.root / "build/Build/Products/Release-iphoneos/MyNotes.app"

    def build(self):
        source = self.check_source()
        with self.refreshed_profile_cache():
            self.run(["/usr/bin/xcodebuild", "-project", str(source / "ios/MyNotes/MyNotes.xcodeproj"),
                      "-scheme", "MyNotes", "-configuration", "Release", "-destination",
                      "id=" + self.config["device"], "-destination-timeout", "30",
                      "-derivedDataPath", str(self.root / "build"),
                      "-allowProvisioningUpdates", "-allowProvisioningDeviceRegistration",
                      "DEVELOPMENT_TEAM=" + self.config["team"], "CODE_SIGN_STYLE=Automatic",
                      "build"], "build", 900)

    def install(self):
        self.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(self.app)],
                 "verify-signature", 30)
        installed = self.device_command(["install", "app", str(self.app)], "install", 180)
        if not any(app.get("bundleID") == self.config["bundle_id"]
                   for app in installed.get("installedApplications", [])):
            raise RuntimeError("安装结果未确认 My Notes，保留旧到期记录。")


def renew(runner, state, now, force=False, use_prebuilt=False):
    config = runner.config
    if not force and not renew_due(state, now, config["renew_before_hours"]):
        return {"status": "healthy", "reason": "not_due"}
    connection = runner.device_command(["info", "details"], "device").get("connectionProperties", {})
    if connection.get("pairingState") != "paired":
        raise RuntimeError("iPhone 未配对；请连接数据线并信任这台 Mac。")
    apps = runner.device_command(["info", "apps", "--search", config["bundle_id"]], "installed-app")
    validate_installed_app(apps.get("apps", []), config)
    if use_prebuilt:
        runner.check_source()
    else:
        # Retry an already signed but not installed app without requesting another
        # profile. The last confirmed installed expiry remains the source of truth.
        candidate = None
        if runner.app.exists():
            try:
                candidate = runner.profile(runner.app / "embedded.mobileprovision")
                validate_profile(candidate, config, now, state["installed_expiration"])
            except (RuntimeError, subprocess.SubprocessError, ValueError, KeyError):
                candidate = None
        runner.check_source()
        if candidate is None:
            runner.build()
    profile = runner.profile(runner.app / "embedded.mobileprovision")
    expiration = validate_profile(profile, config, now, state["installed_expiration"])
    runner.install()
    # Do not auto-launch: installation must not bring an app to the foreground.
    state.update(installed_expiration=expiration.isoformat(), installed_profile=profile["UUID"],
                 last_installed_at=now.isoformat(), transport=connection.get("transportType"))
    return {"status": "renewed", "reason": "installed", "transport": state["transport"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--force", action="store_true", help="Run the renewal path before it is due")
    parser.add_argument("--use-prebuilt", action="store_true", help="Validate/install a prepared build (initial verification)")
    parser.add_argument("--interactive", action="store_true", help="Show progress for a manually launched terminal session")
    args = parser.parse_args()
    os.umask(0o077)
    root = args.root.expanduser().resolve()
    # Kernel lock is released even after a crash; no stale PID-lock cleanup.
    with (root / "run.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({"status": "busy", "notify": False}))
            return 0
        now = datetime.now(UTC)
        state = {}
        try:
            config = json.loads((root / "config.json").read_text())
            state = json.loads((root / "state.json").read_text())
            result = renew(Runner(root, config, args.interactive), state, now, args.force, args.use_prebuilt)
        except Exception as error:
            result = {"status": "failed", "reason": str(error)}
        notify = notification_needed(state, result, now)
        if notify:
            state.update(last_alert_reason=result["reason"], last_alert_at=now.isoformat())
        elif result["status"] != "failed":
            state.pop("last_alert_reason", None)
            state.pop("last_alert_at", None)
        state.update(last_checked_at=now.isoformat(), last_status=result["status"])
        result.update(notify=notify, checked_at=now.isoformat(),
                      installed_expiration=state.get("installed_expiration"))
        atomic_json(root / "state.json", state)
        atomic_json(root / "status.json", result)
        if args.interactive:
            from zoneinfo import ZoneInfo
            if result["status"] == "renewed":
                print("\n续签并安装成功。")
            elif result["status"] == "healthy":
                print("\n当前签名仍有效，暂时无需续签。")
            else:
                print("\n续签失败：" + result["reason"])
                print("请保持 Mac 和 iPhone 解锁、同一 Wi-Fi（或插线），确认 Xcode → Settings → Apple Accounts 中账号可用。")
                print("如果日志显示 No Accounts，请在 Xcode 重新登录 Apple 账号，再双击脚本。")
                print("不会卸载手机上的应用；失败没有被计为续签成功。")
            if result["installed_expiration"]:
                expiry = timestamp(result["installed_expiration"]).astimezone(ZoneInfo("Asia/Taipei"))
                print("最近确认安装的签名到期时间：" + expiry.strftime("%Y-%m-%d %H:%M（台北）"))
            print("日志目录：" + str(root / "logs"))
        else:
            print(json.dumps(result, ensure_ascii=False))
        return 1 if result["status"] == "failed" else 0


if __name__ == "__main__":
    sys.exit(main())
