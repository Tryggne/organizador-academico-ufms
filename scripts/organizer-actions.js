'use strict';

(() => {
  const setStatus = message => {
    const element = document.getElementById('refreshStatus');
    if (element) element.textContent = message;
  };

  function addFolderButtons() {
    const courseLink = document.querySelector('.course-head .course-actions a[href*="/course/view.php?id="]');
    if (!courseLink) return;

    let courseId;
    try {
      courseId = new URL(courseLink.href).searchParams.get('id');
    } catch {
      return;
    }
    if (!courseId) return;

    document.querySelectorAll('details.module').forEach(card => {
      if (card.querySelector('.folder-path, [data-add-module-folder]')) return;
      const heading = card.querySelector('summary .module-title strong');
      const actions = card.querySelector('.module-body .course-actions');
      const match = heading?.textContent.match(/M[oó]dulo\s+(\d+)/i);
      if (!actions || !match) return;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button-link';
      button.dataset.addModuleFolder = 'true';
      button.dataset.courseId = courseId;
      button.dataset.moduleNumber = match[1];
      button.textContent = 'Criar pasta';
      button.title = 'Criar e vincular automaticamente a pasta deste módulo';
      actions.append(button);
    });
  }

  async function createModuleFolder(button) {
    button.disabled = true;
    button.textContent = 'Criando pasta...';
    try {
      const response = await fetch('/api/activity-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courseId: button.dataset.courseId,
          moduleNumber: Number(button.dataset.moduleNumber),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Não consegui criar a pasta do módulo.');

      const openResponse = await fetch('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: result.folder }),
      });
      const openResult = await openResponse.json().catch(() => ({}));
      setStatus(openResponse.ok
        ? `Pasta pronta e vinculada: ${result.folder}`
        : `Pasta pronta e vinculada: ${result.folder}. ${openResult.error || 'Abra pelo botão da pasta.'}`);
      window.setTimeout(() => window.location.reload(), 800);
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Tentar novamente';
      setStatus(error.message || 'Não consegui adicionar a pasta.');
    }
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-add-module-folder]');
    if (button) createModuleFolder(button);
  });

  const app = document.getElementById('app');
  if (app) {
    new MutationObserver(addFolderButtons).observe(app, { childList: true, subtree: true });
  }
  addFolderButtons();
})();
