const $ = (sel) => document.querySelector(sel);

const GROUP_TYPES = ['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay'];
const PROXY_URL = 'http://127.0.0.1:7890';

const state = {
  mode: 'rule',
  proxy: null,
  proxyKnown: false,
  groups: [],
  groupName: null,
  blocked: new Set(),
  delays: new Map(),
};

function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = message;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

async function api(path, options = {}) {
  const resp = await fetch(path, {
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

function updateLinks(links = {}) {
  const host = location.hostname;
  const proto = location.protocol;
  const amane = links.amane || `${proto}//${host}:8000`;
  $('#link-amane-top').href = amane;
  $('#link-amane').href = amane;
}

/* ---------------- 状态 ---------------- */

function setDot(id, online) {
  const dot = $(id);
  if (dot) dot.className = 'dot ' + (online ? 'online' : 'offline');
}

function markMode(mode) {
  state.mode = (mode || 'rule').toLowerCase();
  document.querySelectorAll('#mode-switch button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === state.mode);
  });
}

function renderProxyState(proxy, known = true) {
  state.proxy = proxy;
  state.proxyKnown = known;
  const value = $('#proxy-value');
  const sw = $('#proxy-switch');
  if (!known) {
    value.textContent = '未知（amane 配置不可读）';
    sw.setAttribute('aria-checked', 'false');
    return;
  }
  const on = Boolean(proxy);
  value.textContent = on ? proxy : '未设置';
  sw.setAttribute('aria-checked', on ? 'true' : 'false');
}

async function refreshStatus() {
  try {
    const data = await api('/api/status');
    const services = data.services || {};
    updateLinks(data.links || {});

    const amane = services.amane || { online: false };
    const mihomo = services.mihomo || { online: false };

    setDot('#dot-amane', amane.online);
    setDot('#dot-mihomo', mihomo.online);
    $('#state-amane').textContent = amane.online ? '在线' : '离线';

    if (mihomo.online) {
      const ver = mihomo.version && (mihomo.version.version || mihomo.version.message);
      const parts = [ver, mihomo.mode ? `mode ${mihomo.mode}` : ''];
      if (mihomo.mixed_port != null) parts.push(`mixed-port ${mihomo.mixed_port}`);
      $('#state-mihomo').textContent = parts.filter(Boolean).join(' · ') || '内核在线';
      markMode(mihomo.mode || state.mode);
    } else {
      $('#state-mihomo').textContent = '离线';
    }

    const allOnline = ['amane', 'mihomo']
      .every((key) => services[key] && services[key].online);
    const globalDot = $('#global-dot');
    globalDot.className = 'dot ' + (allOnline ? 'online' : 'offline');

    if (amane.online) await refreshAmaneProxy();
    else renderProxyState(null, false);
  } catch (err) {
    toast('状态获取失败：' + err.message, true);
    $('#global-dot').className = 'dot offline';
  }
}

async function refreshAmaneProxy() {
  try {
    const data = await api('/api/amane/config');
    renderProxyState(data.proxy ?? null, data.available !== false);
  } catch {
    renderProxyState(null, false);
  }
}

/* ---------------- amane 代理 ---------------- */

async function toggleAmaneProxy() {
  const sw = $('#proxy-switch');
  const next = sw.getAttribute('aria-checked') !== 'true';
  sw.disabled = true;
  try {
    const data = await api('/api/amane/proxy', {
      method: 'POST',
      body: JSON.stringify({ enabled: next }),
    });
    renderProxyState(data.proxy ?? null, true);
    toast(next ? '已开启 amane 出网代理' : '已关闭 amane 出网代理');
    await refreshStatus();
  } catch (err) {
    toast('设置失败：' + err.message, true);
  } finally {
    sw.disabled = false;
  }
}

/* ---------------- mihomo 模式 ---------------- */

async function setMode(mode) {
  if (mode === state.mode) return;
  const buttons = document.querySelectorAll('#mode-switch button');
  buttons.forEach((btn) => { btn.disabled = true; });
  try {
    await api('/api/mihomo/mode', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    });
    markMode(mode);
    toast('已切换到 ' + mode + ' 模式');
  } catch (err) {
    toast('切换模式失败：' + err.message, true);
  } finally {
    buttons.forEach((btn) => { btn.disabled = false; });
  }
}

/* ---------------- 节点 ---------------- */

async function loadBlocked() {
  try {
    const data = await api('/api/mihomo/blocked');
    state.blocked = new Set(data.blocked || []);
  } catch {
    state.blocked = new Set();
  }
}

async function loadGroups() {
  const data = await api('/api/mihomo/proxies');
  const proxies = data.proxies || {};
  state.groups = Object.entries(proxies).filter(([, p]) =>
    p && Array.isArray(p.all) && p.all.length && GROUP_TYPES.includes(p.type));

  if (!state.groups.some(([name]) => name === state.groupName)) {
    const preferred = state.groups.find(([, p]) => p.type === 'Selector') || state.groups[0];
    state.groupName = preferred ? preferred[0] : null;
  }

  const select = $('#node-group');
  select.innerHTML = state.groups.map(([name, p]) =>
    `<option value="${escapeHtml(name)}"${name === state.groupName ? ' selected' : ''}>` +
    `${escapeHtml(name)} · ${escapeHtml(p.type)}</option>`).join('');
  if (!state.groups.length) {
    select.innerHTML = '<option value="">暂无代理组</option>';
  }
  renderNodes();
}

function currentNode() {
  const group = state.groups.find(([name]) => name === state.groupName);
  return group ? group[1] : null;
}

function renderNodes() {
  const group = currentNode();
  const nowEl = $('#node-now');
  const list = $('#node-list');

  if (!group) {
    nowEl.textContent = '-';
    list.innerHTML = '<p class="hint">暂无可切换的代理组（可能还没有导入订阅）。</p>';
    renderBlocked();
    return;
  }

  const now = group.now || '';
  const blockedNow = now && state.blocked.has(now);
  nowEl.textContent = blockedNow ? `${now}（已屏蔽）` : (now || '-');

  const visible = group.all.filter((name) => !state.blocked.has(name));
  if (!visible.length) {
    list.innerHTML = '<p class="hint">该组节点已全部屏蔽。</p>';
    renderBlocked();
    return;
  }

  list.innerHTML = '';
  visible.forEach((name) => {
    const item = document.createElement('div');
    item.className = 'node-item';

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'node-chip' + (name === now ? ' active' : '');
    chip.innerHTML = `<span>${escapeHtml(name)}</span><span class="ms"></span>`;
    chip.addEventListener('click', () => selectNode(name));
    const ms = chip.querySelector('.ms');
    if (state.delays.has(name)) ms.textContent = state.delays.get(name);

    const block = document.createElement('button');
    block.type = 'button';
    block.className = 'node-block';
    block.title = '屏蔽该节点';
    block.textContent = '⊘';
    block.addEventListener('click', () => toggleBlocked(name, true));

    item.append(chip, block);
    list.appendChild(item);
  });

  renderBlocked();
}

function renderBlocked() {
  const toggle = $('#blocked-toggle');
  const list = $('#blocked-list');
  const names = [...state.blocked];

  if (!names.length) {
    toggle.hidden = true;
    list.hidden = true;
    list.innerHTML = '';
    return;
  }

  toggle.hidden = false;
  toggle.textContent = `已屏蔽 ${names.length}`;
  list.innerHTML = '';
  names.forEach((name) => {
    const item = document.createElement('div');
    item.className = 'node-item';

    const chip = document.createElement('span');
    chip.className = 'node-chip blocked';
    chip.textContent = name;

    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'node-block';
    restore.title = '取消屏蔽';
    restore.textContent = '↺';
    restore.addEventListener('click', () => toggleBlocked(name, false));

    item.append(chip, restore);
    list.appendChild(item);
  });
}

async function selectNode(name) {
  if (!state.groupName) return;
  try {
    await api('/api/mihomo/select', {
      method: 'POST',
      body: JSON.stringify({ group: state.groupName, name }),
    });
    toast(`已切换到 ${name}`);
    await loadGroups();
  } catch (err) {
    toast('切换失败：' + err.message, true);
  }
}

async function toggleBlocked(name, blocked) {
  try {
    const data = await api('/api/mihomo/blocked', {
      method: 'POST',
      body: JSON.stringify({ name, blocked }),
    });
    state.blocked = new Set(data.blocked || []);
    renderNodes();
    toast(blocked ? `已屏蔽 ${name}` : `已恢复 ${name}`);
  } catch (err) {
    toast((blocked ? '屏蔽' : '恢复') + '失败：' + err.message, true);
  }
}

async function testNodes() {
  const group = currentNode();
  if (!group) return;
  const btn = $('#node-test');
  btn.disabled = true;
  const visible = group.all.filter((name) => !state.blocked.has(name)).slice(0, 30);
  await Promise.all(visible.map(async (name) => {
    state.delays.set(name, '…');
    const chip = [...document.querySelectorAll('#node-list .node-chip')]
      .find((el) => el.firstElementChild.textContent === name);
    const ms = chip && chip.querySelector('.ms');
    if (ms) ms.textContent = '…';
    try {
      const r = await api('/api/mihomo/delay', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      const label = r.delay != null ? `${r.delay}ms` : '超时';
      state.delays.set(name, label);
      if (ms) ms.textContent = label;
    } catch {
      state.delays.set(name, '失败');
      if (ms) ms.textContent = '失败';
    }
  }));
  btn.disabled = false;
}

/* ---------------- 订阅 ---------------- */

async function importSubscription(event) {
  event.preventDefault();
  const url = $('#sub-url').value.trim();
  if (!url) return;
  const btn = event.target.querySelector('button');
  btn.disabled = true;
  try {
    await api('/api/mihomo/subscription', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
    toast('订阅已导入并热加载');
    $('#node-list').hidden = false;
    await loadGroups();
    await refreshStatus();
  } catch (err) {
    toast('导入失败：' + err.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 事件绑定 ---------------- */

$('#refresh').addEventListener('click', () => {
  refreshStatus();
});
$('#proxy-switch').addEventListener('click', toggleAmaneProxy);
$('#mode-switch').addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-mode]');
  if (btn) setMode(btn.dataset.mode);
});
$('#node-group').addEventListener('change', (event) => {
  state.groupName = event.target.value || null;
  renderNodes();
});
$('#node-toggle').addEventListener('click', async () => {
  const list = $('#node-list');
  if (!list.hidden) {
    list.hidden = true;
    return;
  }
  list.hidden = false;
  list.innerHTML = '<p class="hint">加载中…</p>';
  try {
    await loadGroups();
  } catch (err) {
    list.innerHTML = `<p class="hint">读取代理组失败：${escapeHtml(err.message)}</p>`;
  }
});
$('#node-test').addEventListener('click', testNodes);
$('#blocked-toggle').addEventListener('click', () => {
  const list = $('#blocked-list');
  list.hidden = !list.hidden;
});
$('#sub-form').addEventListener('submit', importSubscription);

async function init() {
  await loadBlocked();
  await refreshStatus();
  try {
    await loadGroups();
  } catch {
    /* mihomo 未就绪时忽略，展开节点时再重试 */
  }
  setInterval(refreshStatus, 10000);
}

init();
