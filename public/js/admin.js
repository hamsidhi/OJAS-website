(() => {
  document.querySelectorAll('[data-autosubmit]').forEach((el) => el.addEventListener('change', () => el.form.submit()));
  document.querySelectorAll('[data-confirm]').forEach((el) => el.addEventListener('click', (e) => { if (!confirm(el.dataset.confirm)) e.preventDefault(); }));
  document.querySelectorAll('form[data-confirm-form]').forEach((f) => f.addEventListener('submit', (e) => { if (!confirm(f.dataset.confirmForm)) e.preventDefault(); }));
  document.querySelectorAll('[data-print]').forEach((el) => el.addEventListener('click', () => window.print()));
})();
