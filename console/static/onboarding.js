(function () {
  const $ = (sel) => document.querySelector(sel);

  const state = {
    step: 1,
    total: 6,
    setup: null,
    nextHandler: null,
  };

  function toast(message, isError) {
    const box = $('#toast');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' error' : '');
    el.textContent = message;
    box.appendChild(el);
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

  function esc(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
  }

  function amaneUrl() {
    const top = $('#link-amane-top');
    return top && top.href ? top.href : `${location.protocol}//${location.hostname}:8000`;
  }

  function checkRow(ok, label, hint) {
    return `<li class="wizard-check ${ok ? 'ok' : 'warn'}">
      <span class="mark">${ok ? '✓' : '!'}</span>
      <span class="check-text"><strong>${esc(label)}</strong>${
        hint ? `<em>${esc(hint)}</em>` : ''
      }</span>
    </li>`;
  }

  /* ---------------- 各步骤渲染 ---------------- */

  function renderWelcome() {
    const source = state.setup ? state.setup.auth_source : 'none';
    const notice = source === 'none'
      ? '当前是首次免密模式：向导完成前，请不要把配置页暴露到公网。'
      : '已检测到现有登录保护，向导只做初始化检查与引导。';
    return `
      <h3>欢迎使用 Mica Amane</h3>
      <p class="wizard-text">这是首次启动向导，会依次完成环境自检、订阅导入、amane 出网代理和登录账号设置。</p>
      <div class="wizard-note">${esc(notice)}</div>
      <p class="hint">随时可以关闭，之后从顶栏「设置向导」重新打开。</p>`;
  }

  async function renderChecks() {
    const [status, setup] = await Promise.all([
      api('/api/status').catch(() => ({ services: {} })),
      api('/api/setup/state').catch(() => state.setup),
    ]);
    state.setup = setup || state.setup;
    const services = status.services || {};
    const mihomo = services.mihomo || { online: false };
    const amane = services.amane || { online: false };
    const source = (state.setup && state.setup.auth_source) || 'none';
    const secretDefault = Boolean(state.setup && state.setup.clash_secret_default);

    const authOk = source !== 'none';
    const authHint = source === 'file'
      ? '已使用向导设置的账号'
      : source === 'env'
        ? '使用环境变量中的密码'
        : '尚未设置，将在最后一步完成';

    return `
      <h3>环境自检</h3>
      <p class="wizard-text">以下项目有问题不影响继续，但建议先处理。</p>
      <ul class="wizard-checks">
        ${checkRow(!secretDefault, 'CLASH_SECRET', secretDefault ? '仍是示例默认值，请去 .env 修改后重启' : '已自定义')}
        ${checkRow(authOk, '登录保护', authHint)}
        ${checkRow(mihomo.online, 'mihomo 内核', mihomo.online ? '在线' : '未就绪，订阅导入可能失败')}
        ${checkRow(amane.online, 'amane 服务', amane.online ? '在线' : '未就绪，代理开关可能失败')}
      </ul>`;
  }

  function renderSubscribe() {
    return `
      <h3>导入订阅</h3>
      <p class="wizard-text">粘贴机场订阅地址，导入后会立即热加载。</p>
      <div class="wizard-form">
        <input id="wizard-sub-url" type="url" placeholder="https://example.com/sub?token=..." spellcheck="false">
        <button id="wizard-sub-import" class="btn primary" type="button">导入</button>
      </div>
      <p id="wizard-sub-status" class="hint">不导入也可以先跳过，稍后在首页导入。</p>`;
  }

  function bindSubscribe() {
    const btn = $('#wizard-sub-import');
    const input = $('#wizard-sub-url');
    const status = $('#wizard-sub-status');
    if (!btn || !input) return;

    btn.addEventListener('click', async () => {
      const url = input.value.trim();
      if (!url) {
        toast('请填写订阅地址', true);
        return;
      }
      btn.disabled = true;
      status.textContent = '下载中，可能较慢…';
      try {
        await api('/api/mihomo/subscription', {
          method: 'POST',
          body: JSON.stringify({ url }),
        });
        const proxies = await api('/api/mihomo/proxies').catch(() => ({ proxies: {} }));
        const groups = Object.values(proxies.proxies || {})
          .filter((p) => p && Array.isArray(p.all) && p.all.length).length;
        status.textContent = `导入成功，已加载 ${groups} 个代理组。`;
        toast('订阅已导入并热加载');
      } catch (err) {
        status.textContent = `导入失败：${err.message}`;
        toast('导入失败：' + err.message, true);
      } finally {
        btn.disabled = false;
      }
    });
  }

  async function renderProxy() {
    const cfg = await api('/api/amane/config').catch(() => ({ available: false, proxy: null }));
    const on = Boolean(cfg.proxy);
    const value = cfg.available === false
      ? '未知（amane 配置不可读）'
      : (cfg.proxy || '未设置');
    return `
      <h3>amane 出网代理</h3>
      <p class="wizard-text">开启后 amane 经容器内 mihomo 出网（http://127.0.0.1:7890）。</p>
      <div class="wizard-toggle">
        <button id="wizard-proxy-switch" class="switch" role="switch"
                aria-checked="${on ? 'true' : 'false'}" aria-label="amane 出网代理"><span></span></button>
        <span id="wizard-proxy-value" class="svc-value">${esc(value)}</span>
      </div>
      <p class="hint">可以跳过，之后在首页随时开关。</p>`;
  }

  function bindProxy() {
    const sw = $('#wizard-proxy-switch');
    if (!sw) return;
    sw.addEventListener('click', async () => {
      const next = sw.getAttribute('aria-checked') !== 'true';
      sw.disabled = true;
      try {
        const data = await api('/api/amane/proxy', {
          method: 'POST',
          body: JSON.stringify({ enabled: next }),
        });
        sw.setAttribute('aria-checked', next ? 'true' : 'false');
        const value = $('#wizard-proxy-value');
        if (value) value.textContent = data.proxy || '未设置';
        toast(next ? '已开启 amane 出网代理' : '已关闭 amane 出网代理');
      } catch (err) {
        toast('设置失败：' + err.message, true);
      } finally {
        sw.disabled = false;
      }
    });
  }

  async function renderToken() {
    let token = '';
    try {
      const data = await api('/api/amane/token');
      token = data.token || '';
    } catch (err) {
      token = '';
    }
    return `
      <h3>Token 与入口</h3>
      <p class="wizard-text">amane 的 API Token，登入 amane 或接第三方工具时需要。</p>
      <div class="wizard-token">
        <code id="wizard-token-value">${esc(token || '（未生成）')}</code>
        <button id="wizard-token-copy" class="btn small" type="button">复制</button>
      </div>
      <p class="hint">
        <a href="${esc(amaneUrl())}" target="_blank" rel="noopener">打开 amane 页面</a>
      </p>`;
  }

  function bindToken() {
    const btn = $('#wizard-token-copy');
    const code = $('#wizard-token-value');
    if (!btn || !code) return;
    btn.addEventListener('click', async () => {
      const text = code.textContent.trim();
      if (!text || text === '（未生成）') return;
      try {
        await navigator.clipboard.writeText(text);
        toast('Token 已复制');
      } catch {
        toast('复制失败，请手动选中复制', true);
      }
    });
  }

  function renderAccount() {
    const setup = state.setup || {};
    const source = setup.auth_source || 'none';
    const username = setup.username || 'admin';
    const sourceHint = source === 'file'
      ? '已使用向导账号保护，留空密码表示不改密码。'
      : source === 'env'
        ? '当前使用环境变量中的密码，留空密码表示沿用。'
        : '当前为免密状态，必须设置账号密码后才能完成。';

    return `
      <h3>设置管理员账号</h3>
      <p class="wizard-text">${esc(sourceHint)}</p>
      <div class="wizard-form wizard-form-col">
        <label>用户名
          <input id="wizard-user" type="text" value="${esc(username)}" autocomplete="username">
        </label>
        <label>密码
          <input id="wizard-pass" type="password" placeholder="${source === 'none' ? '至少 8 位' : '留空表示不变'}"
                 autocomplete="new-password">
        </label>
        <label>确认密码
          <input id="wizard-pass2" type="password" placeholder="再次输入" autocomplete="new-password">
        </label>
      </div>
      <p class="hint" id="wizard-account-hint">
        ${source === 'none'
          ? '设置后立即启用登录保护，浏览器会要求重新输入账号密码。'
          : '随时可以在顶栏重新打开向导修改。'}
      </p>`;
  }

  async function finishAccount() {
    const setup = state.setup || {};
    const source = setup.auth_source || 'none';
    const username = ($('#wizard-user')?.value || '').trim();
    const password = $('#wizard-pass')?.value || '';
    const confirm = $('#wizard-pass2')?.value || '';
    const btn = $('#wizard-next');

    if (source !== 'none' && !password) {
      // 沿用现有凭据，只标记向导完成
      btn.disabled = true;
      try {
        await api('/api/setup/complete', { method: 'POST', body: '{}' });
        toast('向导已完成');
        $('#wizard').hidden = true;
        setTimeout(() => location.reload(), 800);
      } catch (err) {
        toast('完成失败：' + err.message, true);
      } finally {
        btn.disabled = false;
      }
      return;
    }

    if (!username) {
      toast('请填写用户名', true);
      return;
    }
    if (password.length < 8) {
      toast('密码至少 8 位', true);
      return;
    }
    if (password !== confirm) {
      toast('两次输入的密码不一致', true);
      return;
    }

    btn.disabled = true;
    try {
      await api('/api/setup/credentials', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      toast('账号已设置，请用新账号重新登录');
      $('#wizard').hidden = true;
      setTimeout(() => location.reload(), 1200);
    } catch (err) {
      toast('设置失败：' + err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------------- 步骤控制 ---------------- */

  function updateChrome() {
    const stepEl = $('#wizard-step');
    if (stepEl) stepEl.textContent = `${state.step} / ${state.total}`;
    const prev = $('#wizard-prev');
    const next = $('#wizard-next');
    if (prev) prev.disabled = state.step === 1;
    if (next) next.textContent = state.step === state.total ? '完成' : '下一步';
  }

  async function go(step) {
    state.step = Math.min(Math.max(step, 1), state.total);
    updateChrome();
    const body = $('#wizard-body');
    if (!body) return;
    body.innerHTML = '<p class="hint">加载中…</p>';
    state.nextHandler = () => go(state.step + 1);

    try {
      if (state.step === 1) {
        body.innerHTML = renderWelcome();
      } else if (state.step === 2) {
        body.innerHTML = await renderChecks();
      } else if (state.step === 3) {
        body.innerHTML = renderSubscribe();
        bindSubscribe();
      } else if (state.step === 4) {
        body.innerHTML = await renderProxy();
        bindProxy();
      } else if (state.step === 5) {
        body.innerHTML = await renderToken();
        bindToken();
      } else if (state.step === 6) {
        body.innerHTML = renderAccount();
        state.nextHandler = finishAccount;
      }
    } catch (err) {
      body.innerHTML = `<p class="hint">加载失败：${esc(err.message)}</p>`;
    }
  }

  function openWizard() {
    const root = $('#wizard');
    if (!root) return;
    root.hidden = false;
    go(1);
  }

  function closeWizard() {
    const root = $('#wizard');
    if (root) root.hidden = true;
  }

  function bindChrome() {
    const prev = $('#wizard-prev');
    const next = $('#wizard-next');
    const close = $('#wizard-close');
    const open = $('#open-wizard');

    if (prev) prev.addEventListener('click', () => go(state.step - 1));
    if (next) {
      next.addEventListener('click', () => {
        const handler = state.nextHandler;
        if (handler) handler();
      });
    }
    if (close) close.addEventListener('click', closeWizard);
    if (open) {
      open.addEventListener('click', async () => {
        state.setup = await api('/api/setup/state').catch(() => state.setup);
        openWizard();
      });
    }
  }

  async function init() {
    if (!$('#wizard')) return;
    bindChrome();
    try {
      state.setup = await api('/api/setup/state');
    } catch {
      state.setup = { needs_onboarding: false, auth_source: 'env' };
    }
    if (state.setup && state.setup.needs_onboarding) openWizard();
  }

  init();
})();
