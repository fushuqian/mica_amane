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
  token: '',
  tokenShown: false,
  tokenError: false,
};

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
  const port = String(links.amane_port || '8000');
  const isDefaultPort =
    (proto === 'https:' && port === '443') || (proto === 'http:' && port === '80');
  const amane =
    links.amane || (isDefaultPort ? `${proto}//${host}` : `${proto}//${host}:${port}`);
  $('#link-amane-top').href = amane;
  $('#link-amane').href = amane;
  const portLabel = $('#port-amane');
  if (portLabel) portLabel.textContent = port;
  const portInput = $('#amane-port-input');
  if (portInput && document.activeElement !== portInput) portInput.value = port;
}

async function saveAmanePort() {
  const input = $('#amane-port-input');
  if (!input) return;
  try {
    const data = await api('/api/settings/amane_port', {
      method: 'POST',
      body: JSON.stringify({ port: input.value.trim() }),
    });
    updateLinks(data.links || {});
    toast('端口已保存');
  } catch (err) {
    toast(`保存失败：${err.message}`, true);
  }
}

/* ---------------- 状态 ---------------- */

function setStatus(id, online) {
  const el = $(id);
  if (!el) return;
  el.textContent = online ? 'ONLINE' : 'OFFLINE';
  const box = el.closest('.mh-status');
  if (box) box.classList.toggle('is-offline', !online);
}

function setGlobalStatus(online) {
  const box = $('#global-status');
  if (!box) return;
  const label = box.querySelector('span');
  if (label) label.textContent = online ? 'ONLINE' : 'OFFLINE';
  box.classList.toggle('is-offline', !online);
}

function markMode(mode) {
  state.mode = (mode || 'rule').toLowerCase();
  document.querySelectorAll('#mode-switch .mh-chip').forEach((btn) => {
    btn.setAttribute('aria-pressed', btn.dataset.mode === state.mode ? 'true' : 'false');
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
    // null 表示配置页拿不到 supervisor 控制通道
    const running = typeof mihomo.running === 'boolean' ? mihomo.running : null;

    setStatus('#state-amane', amane.online);
    setStatus('#state-mihomo-badge', mihomo.online);

    const serviceSwitch = $('#mihomo-switch');
    serviceSwitch.setAttribute('aria-checked', running ? 'true' : 'false');
    serviceSwitch.disabled = running === null;
    $('#proxy-switch').disabled = running === false;

    if (running === false) {
      $('#state-mihomo').textContent = '已停止';
    } else if (mihomo.online) {
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
    setGlobalStatus(allOnline);

    if (amane.online) await refreshAmaneProxy();
    else renderProxyState(null, false);
  } catch (err) {
    toast('状态获取失败：' + err.message, true);
    setGlobalStatus(false);
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

/* ---------------- mihomo 服务开关 ---------------- */

async function toggleMihomoService() {
  const sw = $('#mihomo-switch');
  const next = sw.getAttribute('aria-checked') !== 'true';
  sw.disabled = true;
  try {
    const data = await api('/api/mihomo/service', {
      method: 'POST',
      body: JSON.stringify({ enabled: next }),
    });
    if (next) {
      toast('mihomo 已启动');
    } else if (data.proxy_cleared === false) {
      toast('mihomo 已停止；amane 出网代理未关闭（amane 不可达）', true);
    } else {
      toast('mihomo 已停止，amane 出网代理已关闭');
    }
  } catch (err) {
    toast((next ? '启动' : '停止') + '失败：' + err.message, true);
  } finally {
    await refreshStatus();
  }
}

/* ---------------- amane Token ---------------- */

async function loadToken() {
  try {
    const data = await api('/api/amane/token');
    state.token = (data && data.token) || '';
    state.tokenError = false;
  } catch {
    state.token = '';
    state.tokenError = true;
  }
  renderToken();
}

function renderToken() {
  const code = $('#token-value');
  const reveal = $('#token-reveal');
  if (!state.token) {
    code.textContent = state.tokenError ? '读取失败' : '未生成';
  } else if (state.tokenShown) {
    code.textContent = state.token;
  } else {
    code.textContent = '•'.repeat(16);
  }
  reveal.hidden = !state.token;
  reveal.textContent = state.tokenShown ? '隐藏' : '显示';
}

function toggleToken() {
  state.tokenShown = !state.tokenShown;
  renderToken();
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* 落到下面的兜底方案 */
    }
  }
  return fallbackCopy(text);
}

async function copyToken() {
  if (!state.token) {
    toast('没有可复制的 Token', true);
    return;
  }
  if (await copyText(state.token)) toast('Token 已复制');
  else toast('复制失败，请手动选中复制', true);
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
    list.innerHTML = '<div class="mh-empty"><b>暂无代理组</b>可能还没有导入订阅。</div>';
    renderBlocked();
    return;
  }

  const now = group.now || '';
  const blockedNow = now && state.blocked.has(now);
  nowEl.textContent = blockedNow ? `${now}（已屏蔽）` : (now || '-');

  const visible = group.all.filter((name) => !state.blocked.has(name));
  if (!visible.length) {
    list.innerHTML = '<p class="mh-meta">该组节点已全部屏蔽。</p>';
    renderBlocked();
    return;
  }

  list.innerHTML = '';
  visible.forEach((name) => {
    const item = document.createElement('div');
    item.className = 'node-item';

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'mh-chip node-chip';
    chip.setAttribute('aria-pressed', name === now ? 'true' : 'false');
    chip.innerHTML = `<span>${escapeHtml(name)}</span><span class="ms"></span>`;
    chip.addEventListener('click', () => selectNode(name));
    const ms = chip.querySelector('.ms');
    if (state.delays.has(name)) ms.textContent = state.delays.get(name);

    const block = document.createElement('button');
    block.type = 'button';
    block.className = 'mh-icon-btn node-block';
    block.title = '屏蔽该节点';
    block.setAttribute('aria-label', `屏蔽 ${name}`);
    block.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M6 18 18 6"/></svg>';
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
    chip.className = 'mh-chip node-chip is-blocked';
    chip.textContent = name;

    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'mh-icon-btn node-block';
    restore.title = '取消屏蔽';
    restore.setAttribute('aria-label', `恢复 ${name}`);
    restore.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 4v4h4"/></svg>';
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

/* ---------------- 卡片折叠 ---------------- */

const FOLD_KEY = 'mica-amane:folds';

function loadFolds() {
  try {
    return JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function applyCollapsed(card, collapsed) {
  card.classList.toggle('is-collapsed', collapsed);
  const btn = card.querySelector('.svc-toggle');
  if (btn) btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

function setupCardCollapse() {
  const folds = loadFolds();
  document.querySelectorAll('.service-card[data-key]').forEach((card) => {
    const key = card.dataset.key;
    applyCollapsed(card, Boolean(folds[key]));
    const head = card.querySelector('.svc-head');
    if (!head) return;
    head.addEventListener('click', (event) => {
      if (event.target.closest('.mh-switch')) return;
      const next = !card.classList.contains('is-collapsed');
      applyCollapsed(card, next);
      const saved = loadFolds();
      saved[key] = next;
      try {
        localStorage.setItem(FOLD_KEY, JSON.stringify(saved));
      } catch {
        /* 隐私模式下忽略 */
      }
    });
  });
}

/* ---------------- 事件绑定 ---------------- */

$('#refresh').addEventListener('click', () => {
  refreshStatus();
});
$('#proxy-switch').addEventListener('click', toggleAmaneProxy);
$('#mihomo-switch').addEventListener('click', toggleMihomoService);
$('#token-reveal').addEventListener('click', toggleToken);
$('#token-copy').addEventListener('click', copyToken);
$('#amane-port-save').addEventListener('click', saveAmanePort);
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
  list.innerHTML = '<p class="mh-meta">加载中…</p>';
  try {
    await loadGroups();
  } catch (err) {
    list.innerHTML = `<p class="mh-meta">读取代理组失败：${escapeHtml(err.message)}</p>`;
  }
});
$('#node-test').addEventListener('click', testNodes);
$('#blocked-toggle').addEventListener('click', () => {
  const list = $('#blocked-list');
  list.hidden = !list.hidden;
});
$('#sub-form').addEventListener('submit', importSubscription);
$('#updates-check').addEventListener('click', loadUpdates);
$('#update-list').addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-target]');
  if (btn && !btn.disabled) applyUpdate(btn.dataset.target, btn);
});

/* ---------------- 更新 ---------------- */

const UPDATE_NAMES = { panel: '程序本体', amane: 'amane', mihomo: 'mihomo' };

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
  box.innerHTML = '<p class="mh-meta">检查中…</p>';
  try {
    renderUpdates(await api('/api/updates'));
  } catch (err) {
    box.innerHTML = `<p class="mh-meta">检查失败：${escapeHtml(err.message)}</p>`;
  }
}

async function waitForConsole() {
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const resp = await fetch('/healthz', { cache: 'no-store' });
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
    await refreshStatus();
    await loadUpdates();
  } catch (err) {
    toast(`${label} 更新失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function init() {
  setupCardCollapse();
  await loadBlocked();
  await loadToken();
  await refreshStatus();
  try {
    await loadGroups();
  } catch {
    /* mihomo 未就绪时忽略，展开节点时再重试 */
  }
  setInterval(refreshStatus, 10000);
}

init();

/* 卡片指针光晕（Mica UI §4.3） */
document.addEventListener('pointermove', (event) => {
  const card = event.target.closest('.mh-card');
  if (!card) return;
  const rect = card.getBoundingClientRect();
  card.style.setProperty('--mx', `${((event.clientX - rect.left) / rect.width) * 100}%`);
  card.style.setProperty('--my', `${((event.clientY - rect.top) / rect.height) * 100}%`);
});
