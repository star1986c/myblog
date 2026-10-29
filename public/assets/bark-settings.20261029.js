const $ = id => document.getElementById(id);
let csrfToken = '', serverURL = '', profiles = [];
function status(text = '', error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store',
    headers: { Accept: 'application/json', ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (response.status === 401) { showLogin(); throw new Error('登录已过期，请重新登录。'); }
  if (!response.ok) throw new Error(data.error || data.message || '请求失败，请稍后重试。');
  return data;
}
function showLogin() {
  csrfToken = ''; serverURL = ''; $('server-url').value = ''; $('devices').replaceChildren();
  $('login-panel').hidden = false; $('settings-panel').hidden = true;
}
function element(tag, text, className) { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; }
async function busy(button, action) {
  button.disabled = true;
  try { await action(); } catch (error) { status(error.message || '操作失败。', true); }
  finally { button.disabled = false; }
}
function date(value) { return value ? new Date(value).toLocaleString() : '尚未发送'; }
async function loadSettings() {
  const data = await api('/api/admin/bark');
  serverURL = data.serverURL || ''; profiles = data.profiles;
  $('server-url').value = serverURL; $('copy-url').disabled = !serverURL;
  $('login-panel').hidden = true; $('settings-panel').hidden = false;
  $('devices').replaceChildren();
  if (!data.configured) status('Bark 服务尚未配置完成，请检查服务端配置。', true);
  if (!data.devices.length) $('devices').append(element('p', '尚无设备。在 Bark 添加服务器后，点击“刷新设备”。', 'empty'));
  for (const device of data.devices) renderDevice(device);
}
function renderDevice(device) {
  const card = element('div', '', 'device');
  const form = element('form');
  card.append(form);
  const title = element('h3', device.label); form.append(title);
  const label = element('label', '设备名称');
  const name = element('input'); name.value = device.label; name.required = true; name.maxLength = 60; label.append(name); form.append(label);
  const enabledLabel = element('label'); const enabled = element('input'); enabled.type = 'checkbox'; enabled.checked = device.enabled;
  enabledLabel.append(enabled, document.createTextNode('接收 Hermes 新回复提醒')); form.append(enabledLabel);
  const group = element('fieldset'); group.append(element('legend', '提醒哪些助手'));
  const choices = profiles.map(profile => {
    const row = element('label'), check = element('input'); check.type = 'checkbox'; check.checked = device.profileIds.includes(profile.id);
    row.append(check, document.createTextNode(profile.label)); group.append(row); return { check, id: profile.id };
  });
  form.append(group, element('p', `最近发送：${date(device.lastSentAt)}`, 'meta'));
  if (!device.validToken || device.lastError) form.append(element('p', device.lastError || '设备令牌失效，请在 Bark 中重新添加服务器。', 'meta'));
  const actions = element('div', '', 'actions'), save = element('button', '保存设置'), test = element('button', '发送测试通知', 'secondary'), remove = element('button', '移除设备', 'danger');
  save.type = 'submit'; test.type = remove.type = 'button'; test.disabled = !device.validToken;
  actions.append(save, test, remove); form.append(actions); $('devices').append(card);
  form.addEventListener('submit', event => { event.preventDefault(); busy(save, async () => {
    await api(`/api/admin/bark/devices/${device.key}`, 'PUT', { label: name.value, enabled: enabled.checked, profileIds: choices.filter(c => c.check.checked).map(c => c.id) });
    await loadSettings(); status('通知设置已保存。');
  }); });
  test.addEventListener('click', () => busy(test, async () => {
    await api(`/api/admin/bark/devices/${device.key}/test`, 'POST', {}); await loadSettings(); status('Apple 已接受测试通知，请在 iPhone 查看 Bark。');
  }));
  remove.addEventListener('click', () => {
    if (!confirm('移除此通知设备？你可以在 Bark 中重新添加服务器恢复接收。')) return;
    busy(remove, async () => { await api(`/api/admin/bark/devices/${device.key}`, 'DELETE'); await loadSettings(); status('设备已移除。'); });
  });
}
$('login-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button');
  busy(button, async () => {
    const fields = new FormData(form);
    let data;
    try { data = await api('/api/auth/login', 'POST', { username: fields.get('username'), password: fields.get('password') }); }
    finally { form.elements.password.value = ''; }
    csrfToken = data.csrfToken; await loadSettings(); status('已登录。');
  });
});
$('refresh').addEventListener('click', () => busy($('refresh'), async () => { await loadSettings(); status('设备列表已刷新。'); }));
$('copy-url').addEventListener('click', () => busy($('copy-url'), async () => { await navigator.clipboard.writeText(serverURL); status('服务器地址已复制，请在 Bark 中添加。'); }));
$('logout').addEventListener('click', () => busy($('logout'), async () => { await api('/api/auth/logout', 'POST', {}); showLogin(); status('已退出。'); }));
try {
  const session = await api('/api/auth/me');
  if (session.user && session.csrfToken) { csrfToken = session.csrfToken; await loadSettings(); }
  else showLogin();
} catch (error) { showLogin(); status(error.message, true); }
