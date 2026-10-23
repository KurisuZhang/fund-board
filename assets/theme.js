/* 主题切换：深色（默认）/ 浅色，持久化到 localStorage，切换时广播 themechange */
(function () {
  'use strict';
  var KEY = 'sb_theme_v1';
  var ORDER = ['dark', 'light'];

  function stored() {
    try { return localStorage.getItem(KEY) || 'dark'; } catch (e) { return 'dark'; }
  }

  function label(t) {
    return t === 'light' ? '☀ 浅色' : '🌙 深色';
  }

  function paintButton() {
    var btn = document.getElementById('themeBtn');
    if (!btn) return;
    var t = document.documentElement.dataset.theme || 'dark';
    btn.textContent = label(t);
    btn.setAttribute('aria-label', '切换主题，当前' + (t === 'light' ? '浅色' : '深色'));
    btn.title = '切换深色 / 浅色主题';
  }

  function apply(theme, persist) {
    document.documentElement.dataset.theme = theme;
    if (persist) {
      try { localStorage.setItem(KEY, theme); } catch (e) { /* 隐私模式忽略 */ }
    }
    paintButton();
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: theme } }));
  }

  function toggle() {
    var cur = document.documentElement.dataset.theme || 'dark';
    apply(ORDER[(ORDER.indexOf(cur) + 1) % ORDER.length], true);
  }

  /* 首屏前先把 dataset 设好，避免白闪；支持 ?theme=light 临时预览（不写入 localStorage） */
  function fromQuery() {
    try {
      var t = new URLSearchParams(location.search).get('theme');
      return t === 'light' || t === 'dark' ? t : null;
    } catch (e) { return null; }
  }
  var preview = fromQuery();
  document.documentElement.dataset.theme = preview || stored();

  document.addEventListener('DOMContentLoaded', function () {
    paintButton();
    var btn = document.getElementById('themeBtn');
    if (btn) btn.addEventListener('click', function () {
      /* 用 URL 指定主题时，点击切换后回到持久化逻辑 */
      if (preview) {
        preview = null;
        apply(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light', true);
        return;
      }
      toggle();
    });
  });

  window.THEME = { apply: apply, toggle: toggle, current: function () {
    return document.documentElement.dataset.theme || 'dark';
  } };
})();
