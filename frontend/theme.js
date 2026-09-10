(function () {
  'use strict';

  const key = 'gallery-theme';
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let savedTheme = null;
  let userSelected = false;

  try {
    const value = window.localStorage.getItem(key);
    if (value === 'light' || value === 'dark') {
      savedTheme = value;
      userSelected = true;
    }
  } catch (_) {
    // Storage may be unavailable in private or restricted browser contexts.
  }

  function applyTheme(theme) {
    const isDark = theme === 'dark';
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    const button = document.getElementById('theme-toggle');
    if (button) {
      button.setAttribute('aria-pressed', String(isDark));
      button.textContent = isDark ? '切换到浅色模式' : '切换到暗色模式';
    }
  }

  applyTheme(savedTheme || (media.matches ? 'dark' : 'light'));

  function installToggle() {
    const button = document.getElementById('theme-toggle');
    if (!button) return;
    applyTheme(document.documentElement.getAttribute('data-theme'));
    button.addEventListener('click', function () {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      userSelected = true;
      applyTheme(next);
      try { window.localStorage.setItem(key, next); } catch (_) {}
    });
  }

  function followSystem(event) {
    if (!userSelected) applyTheme(event.matches ? 'dark' : 'light');
  }

  if (typeof media.addEventListener === 'function') media.addEventListener('change', followSystem);
  else if (typeof media.addListener === 'function') media.addListener(followSystem);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installToggle, { once: true });
  else installToggle();
}());
