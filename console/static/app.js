const $ = (sel) => document.querySelector(sel);

const GROUP_TYPES = ['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay'];

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
  const dex = links.metacubexd || `${proto}//${host}:8080`;
  $('#link-amane-top').href = amane;
  $('#link-dex-top').href = dex;
  $('#link-dex').href = dex;
}

async function refreshStatus() {
  try {
    const data = await api('/api/status');
    const services = data.services || {};
    updateLinks(data.links || {});
    renderCards(services);
    renderMihomoSummary(services.mihomo || {});
    const allOnline = ['amane', 'metacubexd', 'mihomo']
      .every((key) => services[key] && services[key].online);
    const dot = $('#global-dot');
    dot.className = 'dot ' + (allOnline ? 'online' : 'offline');
  } catch (err) {
    toast('状态获取失败：' + err.message, true);
    $('#global-dot').className = 'dot offline';
  }
}

function renderCards(services) {
  const items = [
    {
      key: 'amane',
      title: 'amane',
      detail: (s) => (s.online ? '影库服务在线' : '离线'),
    },
    {
      key: 'metacubexd',
      title: 'metacubexd',
      detail: (s) => (s.online ? '面板与 agent 在线' : '离线'),
    },
    {
      key: 'mihomo',
      title: 'mihomo',
      detail: (s) => {
        if (!s.online) return '离线';
        const ver = s.version && (s.version.version || s.version.message);
        return [ver, s.mode].filter(Boolean).join(' · ') || '内核在线';
      },
    },
  ];

  const cards = $('#cards');
  cards.innerHTML = items.map((item) => {
    const s = services[item.key] || { online: false };
    return `
      <div class="card">
        <div class="card-top">
          <h3>${item.title}</h3>
          <span class="dot ${s.online ? 'online' : 'offline'}"></span>
        </div>
        <div class="value">${escapeHtml(item.detail(s))}</div>
      </div>`;
  }).join('');
}

function renderMihomoSummary(mihomo) {
  const kv = $('#mihomo-summary');
  const rows = [
    ['状态', mihomo.online ? '在线' : '离线'],
    ['版本', mihomo.version ? (mihomo.version.version || JSON.stringify(mihomo.version)) : '-'],
    ['模式', mihomo.mode || '-'],
    ['mixed-port', mihomo.mixed_port ?? '-'],
    ['allow-lan', mihomo.allow_lan === undefined ? '-' : String(mihomo.allow_lan)],
  ];
  kv.innerHTML = rows.map(([k, v]) =>
    `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
}

async function loadToken() {
  try {
    const data = await api('/api/amane/token');
    $('#amane-token').textContent = data.token || '未获取到（amane 可能尚未启动）';
  } catch (err) {
    $('#amane-token').textContent = '读取失败：' + err.message;
  }
}

async function copyToken() {
  const text = $('#amane-token').textContent.trim();
  if (!text || text.startsWith('读取失败')) {
    toast('没有可复制的 Token', true);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Token 已复制');
  } catch {
    toast('浏览器拒绝访问剪贴板，请手动选择复制', true);
  }
}

async function setAmaneProxy() {
  const btn = $('#set-proxy');
  btn.disabled = true;
  try {
    const data = await api('/api/amane/proxy', { method: 'POST', body: '{}' });
    toast('已设置 amane 代理：' + data.proxy);
  } catch (err) {
    toast('设置失败：' + err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function loadYaml() {
  try {
    const data = await api('/api/mihomo/yaml');
    $('#yaml-editor').value = data.content;
    $('#yaml-path').textContent = data.path;
  } catch (err) {
    toast('读取配置失败：' + err.message, true);
  }
}

async function saveYaml() {
  const btn = $('#save-yaml');
  btn.disabled = true;
  try {
    const content = $('#yaml-editor').value;
    await api('/api/mihomo/yaml', {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
    toast('配置已保存并热加载');
    await loadProxies();
  } catch (err) {
    toast('保存失败：' + err.message, true);
  } finally {
    btn.disabled = false;
  }
}

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
    await loadYaml();
    await loadProxies();
  } catch (err) {
    toast('导入失败：' + err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function loadProxies() {
  const wrap = $('#proxy-groups');
  wrap.innerHTML = '<p class="muted">加载中…</p>';
  let data;
  try {
    data = await api('/api/mihomo/proxies');
  } catch (err) {
    wrap.innerHTML = `<p class="muted">读取代理组失败：${escapeHtml(err.message)}</p>`;
    return;
  }

  const proxies = data.proxies || {};
  const groups = Object.entries(proxies).filter(([, p]) =>
    p && Array.isArray(p.all) && p.all.length && GROUP_TYPES.includes(p.type));

  if (!groups.length) {
    wrap.innerHTML = '<p class="muted">暂无可切换的代理组（可能还没有导入订阅）。</p>';
    return;
  }

  wrap.innerHTML = '';
  for (const [name, group] of groups) {
    const box = document.createElement('div');
    box.className = 'group';
    box.innerHTML = `
      <div class="group-head">
        <div><strong>${escapeHtml(name)}</strong>
          <span class="muted"> · ${escapeHtml(group.type)}</span></div>
        <div class="now">当前：${escapeHtml(group.now || '-')}</div>
        <button class="btn small test-btn">测速</button>
      </div>
      <div class="chips"></div>`;

    const chips = box.querySelector('.chips');
    const msMap = new Map();

    group.all.forEach((node) => {
      const chip = document.createElement('button');
      chip.className = 'chip' + (node === group.now ? ' active' : '');
      chip.innerHTML = `<span>${escapeHtml(node)}</span><span class="ms"></span>`;
      chip.addEventListener('click', async () => {
        try {
          await api('/api/mihomo/select', {
            method: 'POST',
            body: JSON.stringify({ group: name, name: node }),
          });
          toast(`已切换到 ${node}`);
          await loadProxies();
        } catch (err) {
          toast('切换失败：' + err.message, true);
        }
      });
      msMap.set(node, chip.querySelector('.ms'));
      chips.appendChild(chip);
    });

    box.querySelector('.test-btn').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      const nodes = group.all.slice(0, 30);
      await Promise.all(nodes.map(async (node) => {
        const span = msMap.get(node);
        if (span) span.textContent = '…';
        try {
          const r = await api('/api/mihomo/delay', {
            method: 'POST',
            body: JSON.stringify({ name: node }),
          });
          if (span) span.textContent = r.delay != null ? `${r.delay}ms` : '超时';
        } catch {
          if (span) span.textContent = '失败';
        }
      }));
      btn.disabled = false;
    });

    wrap.appendChild(box);
  }
}

function setupTabs() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $('#tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'mihomo') {
        loadYaml();
        loadProxies();
      }
    });
  });
}

setupTabs();
$('#refresh').addEventListener('click', () => {
  refreshStatus();
  loadToken();
});
$('#copy-token').addEventListener('click', copyToken);
$('#set-proxy').addEventListener('click', setAmaneProxy);
$('#load-yaml').addEventListener('click', loadYaml);
$('#save-yaml').addEventListener('click', saveYaml);
$('#load-proxies').addEventListener('click', loadProxies);
$('#sub-form').addEventListener('submit', importSubscription);

refreshStatus();
loadToken();
setInterval(refreshStatus, 10000);
