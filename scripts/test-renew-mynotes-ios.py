#!/usr/bin/env python3
"""Offline behavioral tests; never contact Apple or an iPhone."""
import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("renewal", Path(__file__).with_name("renew-mynotes-ios.py"))
renewal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renewal)
NOW = datetime(2026, 10, 28, 8, tzinfo=timezone.utc)
CONFIG = {"team": "TEAM", "bundle_id": "test.notes", "device": "PHONE", "renew_before_hours": 48,
          "version": "0.1.0", "build_number": "1"}


def profile(expiry):
    return {"UUID": "new-profile", "TeamIdentifier": ["TEAM"], "ProvisionedDevices": ["PHONE"],
            "Entitlements": {"application-identifier": "TEAM.test.notes"}, "ExpirationDate": expiry}


class FakeRunner:
    config = CONFIG
    def __init__(self, app, expiry=NOW + timedelta(days=7)):
        self.app, self.expiry = app, expiry
        self.calls, self.fail_install = [], False
    def device_command(self, *args):
        if args[1] == "installed-app":
            return {"apps": [{"bundleIdentifier": "test.notes", "version": "0.1.0", "bundleVersion": "1"}]}
        self.calls.append("device")
        return {"connectionProperties": {"pairingState": "paired", "transportType": "localNetwork"}}
    def check_source(self):
        self.calls.append("source")
    def build(self):
        self.calls.append("build")
    def profile(self, *args):
        return profile(self.expiry)
    def install(self):
        self.calls.append("install")
        if self.fail_install:
            raise RuntimeError("device locked")


class RenewalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = Path(self.temp.name) / "MyNotes.app"
        self.state = {"installed_expiration": (NOW + timedelta(hours=24)).isoformat()}

    def test_healthy_check_does_not_require_phone_or_rebuild(self):
        runner = FakeRunner(self.app)
        state = {"installed_expiration": (NOW + timedelta(days=6)).isoformat()}
        result = renewal.renew(runner, state, NOW)
        self.assertEqual(result["status"], "healthy")
        self.assertEqual(runner.calls, [])

    def test_renewal_only_records_expiry_after_wireless_install(self):
        runner = FakeRunner(self.app)
        result = renewal.renew(runner, self.state, NOW)
        self.assertEqual(result["status"], "renewed")
        self.assertEqual(result["transport"], "localNetwork")
        self.assertEqual(runner.calls, ["device", "source", "build", "install"])
        self.assertEqual(renewal.timestamp(self.state["installed_expiration"]), runner.expiry)

    def test_failed_install_keeps_original_on_device_expiry(self):
        runner = FakeRunner(self.app)
        runner.fail_install = True
        original = dict(self.state)
        with self.assertRaisesRegex(RuntimeError, "locked"):
            renewal.renew(runner, self.state, NOW)
        self.assertEqual(original, self.state)

    def test_pending_signed_app_retries_install_without_new_profile_request(self):
        self.app.mkdir()
        runner = FakeRunner(self.app)
        renewal.renew(runner, self.state, NOW)
        self.assertNotIn("build", runner.calls)
        self.assertIn("install", runner.calls)

    def test_reused_old_profile_cannot_claim_renewal(self):
        runner = FakeRunner(self.app, NOW + timedelta(days=6))
        state = {"installed_expiration": runner.expiry.isoformat()}
        with self.assertRaisesRegex(RuntimeError, "没有延长"):
            renewal.renew(runner, state, NOW, force=True)
        self.assertNotIn("install", runner.calls)

    def test_wrong_team_app_or_device_rejected(self):
        for field, value in [("TeamIdentifier", ["OTHER"]), ("ProvisionedDevices", ["OTHER"]),
                             ("Entitlements", {"application-identifier": "TEAM.other"})]:
            with self.subTest(field=field):
                p = profile(NOW + timedelta(days=7)); p[field] = value
                with self.assertRaises(RuntimeError):
                    renewal.validate_profile(p, CONFIG, NOW)

    def test_insufficient_profile_lifetime_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "剩余时间不足"):
            renewal.validate_profile(profile(NOW + timedelta(hours=12)), CONFIG, NOW)

    def test_manual_upgrade_cannot_be_overwritten_by_pinned_old_version(self):
        with self.assertRaisesRegex(RuntimeError, "版本已变化"):
            renewal.validate_installed_app([{"bundleIdentifier": "test.notes", "version": "0.2.0",
                                             "bundleVersion": "2"}], CONFIG)

    def test_uninstalled_app_will_not_be_reinstalled(self):
        with self.assertRaisesRegex(RuntimeError, "找不到"):
            renewal.validate_installed_app([], CONFIG)

    def test_alert_on_first_failure_then_at_most_daily_for_same_failure(self):
        failure = {"status": "failed", "reason": "offline"}
        self.assertTrue(renewal.notification_needed({}, failure, NOW))
        state = {"last_alert_at": NOW.isoformat(), "last_alert_reason": "offline"}
        self.assertFalse(renewal.notification_needed(state, failure, NOW + timedelta(hours=6)))
        self.assertTrue(renewal.notification_needed(state, failure, NOW + timedelta(days=1)))
        self.assertTrue(renewal.notification_needed(state, {**failure, "reason": "login"}, NOW))
        self.assertFalse(renewal.notification_needed(state, {"status": "renewed"}, NOW))

    def test_cache_backup_restored_on_build_failure_and_other_apps_untouched(self):
        root = Path(self.temp.name)
        cache = root / "profiles"; cache.mkdir()
        mine = cache / "mine.mobileprovision"; mine.write_bytes(b"my profile")
        other = cache / "other.mobileprovision"; other.write_bytes(b"other profile")
        runner = renewal.Runner(root, {**CONFIG, "profile_directories": [str(cache)]})
        runner.profile = lambda path: profile(NOW) if path.name == mine.name else {"TeamIdentifier": ["OTHER"]}
        with self.assertRaisesRegex(RuntimeError, "build failed"):
            with runner.refreshed_profile_cache():
                self.assertFalse(mine.exists())
                self.assertTrue(other.exists())
                raise RuntimeError("build failed")
        self.assertEqual(mine.read_bytes(), b"my profile")
        self.assertEqual(other.read_bytes(), b"other profile")


if __name__ == "__main__":
    unittest.main()
