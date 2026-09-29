/*
 * Collapse fenced code blocks on post pages behind a toggle.
 * Mermaid diagrams stay inline; inline `code` spans are not touched.
 * Loaded via metadata-hook.html on post layouts only.
 */
(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState !== 'loading') {
      fn();
    } else {
      document.addEventListener('DOMContentLoaded', fn);
    }
  }

  ready(function () {
    document.querySelectorAll('.content div.highlighter-rouge').forEach(function (block) {
      if (block.closest('details.code-snippet')) return; // already wrapped
      if (block.classList.contains('language-mermaid')) return; // keep diagrams inline
      if (block.classList.contains('no-collapse')) return; // payload examples stay inline

      var label = block.querySelector('.code-header [data-label-text]');
      var lang = label ? label.getAttribute('data-label-text') : '';

      var details = document.createElement('details');
      details.className = 'code-snippet';

      var summary = document.createElement('summary');
      summary.textContent = 'View snippet';
      if (lang) {
        summary.textContent += ' · ' + lang.toLowerCase();
      }

      details.appendChild(summary);
      block.parentNode.insertBefore(details, block);
      details.appendChild(block);
    });
  });
})();
