(function () {
  var KEY = 'mica.theme';
  var root = document.documentElement;

  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function storedTheme() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'dark' || v === 'light' ? v : null;
    } catch (e) { return null; }
  }
  function apply(theme) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
      var label = theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';
      btn.setAttribute('aria-pressed', String(theme === 'dark'));
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
    });
    window.dispatchEvent(new CustomEvent('mh:theme', { detail: { theme: theme } }));
  }
  function set(theme) {
    try { localStorage.setItem(KEY, theme); } catch (e) {}
    apply(theme);
  }
  window.MicaTheme = {
    get: function () { return root.dataset.theme || 'light'; },
    set: set,
    toggle: function () { set(window.MicaTheme.get() === 'dark' ? 'light' : 'dark'); }
  };
  apply(storedTheme() || systemTheme());
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function () { window.MicaTheme.toggle(); });
    });
    apply(window.MicaTheme.get());
  });
})();
