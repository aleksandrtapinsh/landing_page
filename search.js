(function () {
  const input = document.querySelector('.search-bar input[name="q"]');
  if (!input) return;

  document.addEventListener('keydown', (event) => {
    // Leave navigation keys, browser shortcuts, and composition to the browser.
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey
      || event.isComposing || event.key.length !== 1) return;

    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    if (active?.isContentEditable || document.querySelector('dialog[open]')) return;
    if (window.getSelection()?.isCollapsed === false) return;

    // Keep the opening character, and prevent other shortcuts using this key.
    event.preventDefault();
    input.focus();
    input.setRangeText(event.key, input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
})();
