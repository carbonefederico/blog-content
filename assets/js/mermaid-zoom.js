(() => {
  const modalId = 'diagram-zoom-modal';

  function ensureModal() {
    let modal = document.getElementById(modalId);
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = modalId;
    modal.className = 'diagram-zoom-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Expanded diagram');
    modal.innerHTML = '<div class="diagram-zoom-panel"><button type="button" class="diagram-zoom-close">Close</button><div class="diagram-zoom-content"></div></div>';
    document.body.appendChild(modal);

    const close = () => {
      modal.classList.remove('is-open');
      modal.querySelector('.diagram-zoom-content').innerHTML = '';
    };

    modal.querySelector('.diagram-zoom-close').addEventListener('click', close);
    modal.addEventListener('click', (event) => {
      if (event.target === modal) close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && modal.classList.contains('is-open')) close();
    });

    return modal;
  }

  function addZoomButtons() {
    document.querySelectorAll('svg[id^="mermaid-"]').forEach((svg, index) => {
      const container = svg.closest('.mermaid') || svg.parentElement;
      if (!container || container.dataset.diagramZoomReady === 'true') return;

      container.dataset.diagramZoomReady = 'true';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'diagram-zoom-action';
      button.textContent = 'Expand diagram';
      button.setAttribute('aria-label', `Expand diagram ${index + 1}`);
      container.insertAdjacentElement('beforebegin', button);

      button.addEventListener('click', () => {
        const modal = ensureModal();
        const content = modal.querySelector('.diagram-zoom-content');
        const clone = svg.cloneNode(true);
        clone.removeAttribute('height');
        clone.setAttribute('width', '1400');
        content.innerHTML = '';
        content.appendChild(clone);
        modal.classList.add('is-open');
        modal.querySelector('.diagram-zoom-close').focus();
      });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    addZoomButtons();
    setTimeout(addZoomButtons, 500);
    setTimeout(addZoomButtons, 1500);
    setTimeout(addZoomButtons, 3000);

    const observer = new MutationObserver(addZoomButtons);
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
