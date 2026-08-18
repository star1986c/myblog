import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const resource = (path) => new URL(
  `../android/MyNotes/app/src/main/res/${path}`,
  import.meta.url,
);

test("Android launcher uses stable adaptive color and monochrome layers", async () => {
  const [launcher, round, background, foreground, monochrome] = await Promise.all([
    readFile(resource("mipmap-anydpi-v33/ic_launcher.xml"), "utf8"),
    readFile(resource("mipmap-anydpi-v33/ic_launcher_round.xml"), "utf8"),
    readFile(resource("drawable/ic_launcher_background.xml"), "utf8"),
    readFile(resource("drawable/ic_note_foreground.xml"), "utf8"),
    readFile(resource("drawable/ic_note_monochrome.xml"), "utf8"),
  ]);

  for (const adaptiveIcon of [launcher, round]) {
    assert.match(adaptiveIcon, /@drawable\/ic_launcher_background/);
    assert.match(adaptiveIcon, /@drawable\/ic_note_foreground/);
    assert.match(adaptiveIcon, /@drawable\/ic_note_monochrome/);
    assert.doesNotMatch(adaptiveIcon, /@color\/brand_primary/);
  }

  assert.match(background, /<gradient/);
  assert.match(background, /#FF045B73/);
  assert.match(background, /#FF22C9B7/);
  assert.match(foreground, /#FFFFFAEA/);
  assert.match(foreground, /#FF32D6B4/);
  assert.doesNotMatch(foreground, /M32,22h35/);
  assert.match(monochrome, /android:fillType="evenOdd"/);
});
