import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const base = "../android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/";
const source = (name) => readFile(new URL(`${base}${name}`, import.meta.url), "utf8");

test("Android authentication requests do not reuse a stale HTTP connection", async () => {
  const api = await source("NotesApiClient.java");
  const request = api.slice(
    api.indexOf("private JSONObject request("),
    api.indexOf("private JSONObject readJsonResponse("),
  );

  assert.match(request, /HttpURLConnection connection = open\(method, path\);/);
  assert.match(request, /private static boolean isAuthenticationPath\(String path\)/);
  assert.match(
    request,
    /if \(isAuthenticationPath\(path\)\) \{\s*connection\.setRequestProperty\("Connection", "close"\);\s*\}/,
  );
});

test("Android login failures retain the form and explain transient network closes", async () => {
  const main = await source("MainActivity.java");
  const login = main.slice(
    main.indexOf("private void showLogin()"),
    main.indexOf("private void renderHome()"),
  );
  const failure = main.slice(
    main.indexOf("private void showLoginFailure("),
    main.indexOf("private void finishLocalLogout("),
  );

  assert.match(login, /loginButton\.setEnabled\(true\)[\s\S]*showLoginFailure\(error\)/);
  assert.doesNotMatch(login, /showError\(error\)/);
  assert.match(failure, /登录连接被网络中断，请检查网络后重试；账号和密码已保留。/);
  assert.doesNotMatch(failure, /showLogin\(\)/);
});

test("Android completes local logout even when the remote logout request closes", async () => {
  const main = await source("MainActivity.java");
  const logout = main.slice(
    main.indexOf("private void logout()"),
    main.indexOf("private void clearState()"),
  );
  const completion = main.slice(
    main.indexOf("private void finishLocalLogout("),
    main.indexOf("private void clearState()"),
  );

  assert.match(
    logout,
    /runAsync\([\s\S]*ignored -> finishLocalLogout\(null\)[\s\S]*error -> finishLocalLogout\(error\)/,
  );
  assert.match(completion, /clearState\(\);\s*showLogin\(\);/);
  assert.match(completion, /已退出本机/);
});
