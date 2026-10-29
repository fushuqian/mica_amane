const $ = (sel) => document.querySelector(sel);

// 地址栏里带账号密码时相对路径 fetch 会被浏览器拒绝，统一用不含凭据的绝对地址
const API_BASE = `${location.protocol}//${location.host}`;

const UPDATE_NAMES = { panel: '程序本体', amane: 'amane', mihomo: 'mihomo' };

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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function renderUpdates(payload) {
  const box = $('#update-list');
  const comps = (payload && payload.components) || {};
  const rows = Object.keys(UPDATE_NAMES)
    .filter((key) => comps[key])
    .map((key) => {
      const item = comps[key];
      const latest = item.latest || '—';
      const current = item.current || '—';
      let action;
      if (key === 'amane') {
        action = '<span class="mh-meta">随镜像更新</span>';
      } else if (item.has_update) {
        action = `<button class="mh-btn mh-btn--soft" type="button" data-target="${key}">更新</button>`;
      } else {
        action = '<span class="mh-meta">已是最新</span>';
      }
      return `<tr>
        <td>${UPDATE_NAMES[key]}</td>
        <td><code class="mh-code">${escapeHtml(current)}</code></td>
        <td><code class="mh-code">${escapeHtml(latest)}</code></td>
        <td>${action}</td>
      </tr>`;
    })
    .join('');
  const errors = (payload && payload.errors) || [];
  box.innerHTML = rows
    ? `<table class="mh-table">
        <thead><tr><th>组件</th><th>当前</th><th>最新</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : '<div class="mh-empty"><b>没有可展示的版本信息</b>点「检查更新」重试。</div>';
  if (errors.length) {
    const hint = document.createElement('p');
    hint.className = 'mh-meta';
    hint.textContent = '部分上游检查失败：' + errors.join('；');
    box.appendChild(hint);
  }
}

async function loadUpdates() {
  const box = $('#update-list');
  const btn = $('#updates-check');
  box.innerHTML = '<p class="mh-meta">检查中…</p>';
  if (btn) btn.disabled = true;
  try {
    renderUpdates(await api('/api/updates'));
  } catch (err) {
    box.innerHTML = `<p class="mh-meta">检查失败：${escapeHtml(err.message)}</p>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function waitForConsole() {
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const resp = await fetch(API_BASE + '/healthz', { cache: 'no-store' });
      if (resp.ok) return true;
    } catch {
      /* 重启中 */
    }
  }
  return false;
}

async function applyUpdate(target, btn) {
  const label = UPDATE_NAMES[target] || target;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '更新中…';
  try {
    const result = await api('/api/updates/apply', {
      method: 'POST',
      body: JSON.stringify({ target }),
    });
    if (target === 'panel') {
      toast('已更新，配置页正在重启…');
      if (await waitForConsole()) location.reload();
      else toast('配置页重启超时，请手动刷新', true);
      return;
    }
    toast(`${label} 已更新到 ${result.version || '最新版本'}`);
    await loadUpdates();
  } catch (err) {
    toast(`${label} 更新失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

$('#updates-check').addEventListener('click', loadUpdates);
$('#update-list').addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-target]');
  if (btn && !btn.disabled) applyUpdate(btn.dataset.target, btn);
});

loadUpdates();
