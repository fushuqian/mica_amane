/* 顶栏账号菜单：头像、主题二级菜单、设置与退出 */
(function () {
  var btn = document.getElementById('account-btn');
  var menu = document.getElementById('account-menu');
  if (!btn || !menu) return;

  var sub = document.getElementById('account-sub');
  var themeItem = document.getElementById('account-theme');
  var nowLabel = document.getElementById('account-theme-now');
  var THEME_NAMES = { light: '迷雾', dark: '深沉' };
  var base = location.protocol + '//' + location.host;

  function currentTheme() {
    return (window.MicaTheme && window.MicaTheme.get()) || 'light';
  }

  function syncTheme() {
    var theme = currentTheme();
    if (nowLabel) nowLabel.textContent = THEME_NAMES[theme] || '';
    document.querySelectorAll('[data-theme-choice]').forEach(function (el) {
      el.setAttribute('aria-checked', String(el.dataset.themeChoice === theme));
    });
  }

  function closeMenu() {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (sub) sub.hidden = true;
    if (themeItem) themeItem.setAttribute('aria-expanded', 'false');
  }

  function openMenu() {
    syncTheme();
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  }

  btn.addEventListener('click', function (event) {
    event.stopPropagation();
    if (menu.hidden) openMenu();
    else closeMenu();
  });

  document.addEventListener('click', function (event) {
    if (event.target.closest('.account')) return;
    closeMenu();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeMenu();
  });

  if (themeItem && sub) {
    themeItem.addEventListener('click', function (event) {
      event.stopPropagation();
      sub.hidden = !sub.hidden;
      themeItem.setAttribute('aria-expanded', String(!sub.hidden));
      syncTheme();
    });
  }

  document.querySelectorAll('[data-theme-choice]').forEach(function (el) {
    el.addEventListener('click', function (event) {
      event.stopPropagation();
      if (window.MicaTheme) window.MicaTheme.set(el.dataset.themeChoice);
      syncTheme();
      closeMenu();
    });
  });

  window.addEventListener('mh:theme', syncTheme);

  /* ---------------- 头像 ---------------- */

  var img = document.getElementById('account-avatar');
  var initial = document.getElementById('account-initial');

  function showAvatar(url) {
    if (!img) return;
    if (!url) {
      img.hidden = true;
      if (initial) initial.hidden = false;
      return;
    }
    img.src = url;
    img.hidden = false;
    if (initial) initial.hidden = true;
  }

  fetch(base + '/api/avatar', { cache: 'no-store' })
    .then(function (resp) {
      return resp.ok ? resp.blob() : null;
    })
    .then(function (blob) {
      if (blob) showAvatar(URL.createObjectURL(blob));
    })
    .catch(function () {});

  fetch(base + '/api/settings/account', { cache: 'no-store' })
    .then(function (resp) {
      return resp.ok ? resp.json() : null;
    })
    .then(function (data) {
      var name = (data && data.username) || '';
      if (name && initial) initial.textContent = name.charAt(0).toUpperCase();
    })
    .catch(function () {});

  syncTheme();
})();
