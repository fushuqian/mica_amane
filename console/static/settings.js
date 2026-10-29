const $ = (sel) => document.querySelector(sel);

const API_BASE = `${location.protocol}//${location.host}`;

let pendingAvatar = '';

function toast(message, isError = false) {
  const el = $('#mh-toast');
  if (!el) return;
  const icon = $('#mh-toast-icon');
  const text = $('#mh-toast-text');
  if (icon) icon.textContent = isError ? '!' : '✓';
  if (text) text.textContent = message;
  el.classList.toggle('is-error', isError);
  el.classList.add('is-visible');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove('is-visible'), 2600);
}

async function api(path, options = {}) {
  const resp = await fetch(API_BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!resp.ok) {
    const detail = data && data.detail ? data.detail : data;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return data;
}

function setInitial(name) {
  const el = $('#avatar-initial');
  if (el) el.textContent = (name || 'M').charAt(0).toUpperCase();
}

function showPreview(url) {
  const img = $('#avatar-img');
  const initial = $('#avatar-initial');
  if (!url) {
    img.hidden = true;
    if (initial) initial.hidden = false;
    return;
  }
  img.src = url;
  img.hidden = false;
  if (initial) initial.hidden = true;
}

async function loadAccount() {
  try {
    const data = await api('/api/settings/account');
    $('#acc-user').value = data.username || '';
    setInitial(data.username);
  } catch {
    /* 未登录时中间件已跳转，这里忽略 */
  }
}

async function loadAvatar() {
  try {
    const resp = await fetch(`${API_BASE}/api/avatar`, { cache: 'no-store' });
    if (!resp.ok) return;
    showPreview(URL.createObjectURL(await resp.blob()));
  } catch {
    /* 没有头像时保持首字母 */
  }
}

$('#avatar-file').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  if (file.size > 512 * 1024) {
    toast('图片不能超过 512KB', true);
    event.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingAvatar = String(reader.result || '');
    showPreview(pendingAvatar);
    $('#avatar-save').disabled = !pendingAvatar;
  };
  reader.readAsDataURL(file);
});

$('#avatar-save').addEventListener('click', async () => {
  if (!pendingAvatar) return;
  const btn = $('#avatar-save');
  btn.disabled = true;
  try {
    await api('/api/avatar', {
      method: 'POST',
      body: JSON.stringify({ data: pendingAvatar }),
    });
    toast('头像已更新');
    pendingAvatar = '';
  } catch (err) {
    toast(`保存失败：${err.message}`, true);
  } finally {
    btn.disabled = !pendingAvatar;
  }
});

$('#account-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = $('#acc-user').value.trim();
  const current = $('#acc-current').value;
  const password = $('#acc-pass').value;
  const confirm = $('#acc-pass2').value;
  if (password && password !== confirm) {
    toast('两次输入的新密码不一致', true);
    return;
  }

  const btn = $('#account-save');
  btn.disabled = true;
  try {
    const data = await api('/api/settings/account', {
      method: 'POST',
      body: JSON.stringify({ current_password: current, username, password }),
    });
    toast('账号已更新');
    $('#acc-current').value = '';
    $('#acc-pass').value = '';
    $('#acc-pass2').value = '';
    $('#acc-user').value = data.username || username;
    setInitial(data.username || username);
  } catch (err) {
    toast(`保存失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
});

loadAccount();
loadAvatar();
