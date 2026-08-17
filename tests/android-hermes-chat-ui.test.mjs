import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const activityPath = new URL(
  "../android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/HermesChatActivity.java",
  import.meta.url,
);
const manifestPath = new URL(
  "../android/MyNotes/app/src/main/AndroidManifest.xml",
  import.meta.url,
);

test("Hermes chat exposes only the first configured profile in Android", async () => {
  const source = await readFile(activityPath, "utf8");

  assert.match(source, /selectProfile\(profiles\.get\(0\)\)/);
  assert.doesNotMatch(source, /renderProfiles|profileRail|updateProfileChipStyles/);
});

test("selected chat images wait for an explicit send and keep the caption", async () => {
  const source = await readFile(activityPath, "utf8");

  assert.match(source, /onActivityResult[\s\S]*stageImage\(uri\)/);
  assert.match(source, /sendCurrentMessage[\s\S]*pendingImageUri != null[\s\S]*sendImage/);
  assert.match(source, /String caption = composer\.getText\(\)\.toString\(\)\.trim\(\)/);
  assert.match(source, /点击发送后才会上传/);
});

test("Hermes chat composer accounts for the on-screen keyboard", async () => {
  const [source, manifest] = await Promise.all([
    readFile(activityPath, "utf8"),
    readFile(manifestPath, "utf8"),
  ]);

  assert.match(source, /WindowInsets\.Type\.ime\(\)/);
  assert.match(source, /Math\.max\(bars\.bottom, ime\.bottom\)/);
  assert.match(manifest, /HermesChatActivity[\s\S]*windowSoftInputMode="adjustResize"/);
});
