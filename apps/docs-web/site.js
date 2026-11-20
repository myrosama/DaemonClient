// The few things the docs pages do in the browser: the light/dark switch, the
// phone menu, link anchors on headings, and a contents box on long pages.
(function () {
  var root = document.documentElement;
  var KEY = 'dc-docs-theme';
  try {
    var saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
  } catch (e) { /* storage blocked: follow the system setting */ }

  function isDark() {
    var t = root.getAttribute('data-theme');
    if (t) return t === 'dark';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.querySelector('.theme-btn');
    if (btn) {
      var label = function () { btn.textContent = isDark() ? '☀' : '☾'; btn.setAttribute('aria-label', isDark() ? 'Light theme' : 'Dark theme'); };
      label();
      // Follow the system setting live while no choice is saved.
      if (window.matchMedia) {
        var mq = window.matchMedia('(prefers-color-scheme: dark)');
        if (mq.addEventListener) mq.addEventListener('change', label);
      }
      btn.addEventListener('click', function () {
        var next = isDark() ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        try { localStorage.setItem(KEY, next); } catch (e) { /* not remembered */ }
        label();
      });
    }

    var menu = document.querySelector('.menu-btn');
    var nav = document.querySelector('.nav');
    if (menu && nav) {
      menu.addEventListener('click', function () {
        var open = nav.classList.toggle('open');
        menu.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }

    var heads = document.querySelectorAll('main h2[id], main h3[id], main h4[id]');
    for (var i = 0; i < heads.length; i++) {
      var a = document.createElement('a');
      a.className = 'anchor';
      a.href = '#' + heads[i].id;
      a.textContent = '#';
      a.setAttribute('aria-label', 'Link to this section');
      heads[i].insertBefore(a, heads[i].firstChild);
    }

    var box = document.querySelector('.contents ol');
    if (box) {
      var h2s = document.querySelectorAll('main h2[id]');
      for (var j = 0; j < h2s.length; j++) {
        var li = document.createElement('li');
        var link = document.createElement('a');
        link.href = '#' + h2s[j].id;
        link.textContent = h2s[j].textContent.replace(/^#/, '');
        li.appendChild(link);
        box.appendChild(li);
      }
      if (!h2s.length) box.parentNode.hidden = true;
    }
  });
})();
