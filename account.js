// Account bar: shows who you are, or offers sign in / create account.
// Other scripts listen for the `account:change` event to react to sign in/out.

(function () {
  const bar = document.getElementById('account');
  if (!bar) return;

  const dialog = document.getElementById('account-dialog');
  const form = document.getElementById('account-form');
  const title = document.getElementById('account-title');
  const error = document.getElementById('account-error');
  const emailRow = document.getElementById('account-email-row');
  const submit = document.getElementById('account-submit');
  const toggle = document.getElementById('account-toggle');

  let mode = 'login';
  let user = null;

  function announce(next) {
    user = next;
    document.dispatchEvent(new CustomEvent('account:change', { detail: user }));
    render();
  }

  // The dropdown that's currently open, if any. Only ever one.
  let menu = null;

  function closeMenu() {
    if (!menu) return;
    menu.hidden = true;
    menu.previousElementSibling.setAttribute('aria-expanded', 'false');
    menu = null;
  }

  function menuItem(label, action) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'account-menu-item';
    item.textContent = label;
    item.addEventListener('click', () => {
      closeMenu();
      action();
    });
    return item;
  }

  function render() {
    // Whatever was open belongs to the markup about to be thrown away.
    closeMenu();
    bar.textContent = '';
    if (user) {
      const wrap = document.createElement('div');
      wrap.className = 'account-menu-wrap';

      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'account-name';
      name.title = 'Account options';
      name.setAttribute('aria-haspopup', 'true');
      name.setAttribute('aria-expanded', 'false');
      name.textContent = user.username;
      if (user.nameColor) name.style.color = user.nameColor;

      const list = document.createElement('div');
      list.className = 'account-menu';
      list.hidden = true;
      list.append(
        menuItem('Change color', openColorPicker),
        menuItem('Sign out', signOut),
      );

      name.addEventListener('click', () => {
        const wasOpen = menu === list;
        closeMenu();
        // A second click on the name closes the menu it just opened.
        if (wasOpen) return;
        list.hidden = false;
        name.setAttribute('aria-expanded', 'true');
        menu = list;
      });

      wrap.append(name, list);
      bar.append(wrap);
      return;
    }
    for (const next of ['login', 'register']) {
      const btn = document.createElement('button');
      btn.className = 'account-btn';
      btn.textContent = next === 'login' ? 'Sign in' : 'Create account';
      btn.addEventListener('click', () => open(next));
      bar.append(btn);
    }
  }

  // Dismissal, registered once rather than per render: anything outside the
  // name and its dropdown closes it, as does Escape.
  document.addEventListener('click', (event) => {
    if (menu && !menu.parentElement.contains(event.target)) closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });

  function setMode(next) {
    mode = next;
    title.textContent = mode === 'login' ? 'Sign in' : 'Create account';
    submit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
    toggle.textContent = mode === 'login' ? 'Need an account?' : 'Already have an account?';
    emailRow.hidden = mode === 'login';
    // A hidden required field would block submission with no visible cause.
    form.email.required = mode === 'register';
    form.identifier.placeholder = mode === 'login' ? 'Username or email' : 'Username';
    error.textContent = '';
  }

  function open(next) {
    setMode(next);
    form.reset();
    dialog.showModal();
    form.identifier.focus();
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  async function signOut() {
    try {
      await api('/api/auth/logout', {});
    } catch { /* signing out locally is what matters */ }
    announce(null);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    try {
      const identifier = form.identifier.value;
      const password = form.password.value;
      const data = mode === 'login'
        ? await api('/api/auth/login', { identifier, password })
        : await api('/api/auth/register', {
          email: form.email.value, username: identifier, password,
        });
      announce(data.user);
      dialog.close();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });

  toggle.addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));

  // --- name color picker ---

  const colorDialog = document.getElementById('color-dialog');
  const colorForm = document.getElementById('color-form');
  const colorWheel = document.getElementById('color-wheel');
  const colorRecent = document.getElementById('color-recent');
  const colorSwatches = document.getElementById('color-swatches');
  const colorHex = document.getElementById('color-hex');
  const colorPreview = document.getElementById('color-preview');
  const colorError = document.getElementById('color-error');

  const DEFAULT_COLOR = '#2570c7';
  // Two rows of the swatch grid.
  const RECENT_KEY = 'nameColorRecent';
  const RECENT_MAX = 12;

  function normalizeHex(value) {
    const hex = String(value ?? '').trim().replace(/^([0-9a-fA-F]{6})$/, '#$1');
    return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : null;
  }

  // Anything could be in storage — another tab, an older build, a user poking
  // at it — so the list is re-validated on the way out, not just on the way in.
  function readRecent() {
    try {
      const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      if (!Array.isArray(list)) return [];
      return list.map(normalizeHex).filter(Boolean).slice(0, RECENT_MAX);
    } catch {
      return [];
    }
  }

  function rememberColor(color) {
    const list = [color, ...readRecent().filter((c) => c !== color)].slice(0, RECENT_MAX);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch { /* private mode: the picker still works, it just won't remember */ }
  }

  function renderRecent() {
    const list = readRecent();
    colorSwatches.textContent = '';
    colorRecent.hidden = list.length === 0;
    for (const color of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-swatch';
      btn.dataset.color = color;
      btn.style.background = color;
      btn.title = color;
      btn.addEventListener('click', () => paintPicker(color));
      colorSwatches.append(btn);
    }
  }

  function paintPicker(color) {
    colorHex.value = color;
    // Assigning the same value the wheel already holds fires nothing, so this
    // can't loop back through the wheel's own input handler.
    colorWheel.value = color;
    colorPreview.textContent = user ? user.username : '';
    colorPreview.style.color = color;
    for (const btn of colorSwatches.children) {
      btn.classList.toggle('color-swatch--active', btn.dataset.color === color);
    }
  }

  function openColorPicker() {
    if (!user || !colorDialog) return;
    colorError.textContent = '';
    renderRecent();
    paintPicker(user.nameColor || DEFAULT_COLOR);
    colorDialog.showModal();
  }

  if (colorDialog) {
    // `input` rather than `change`: the preview tracks the wheel as it's dragged.
    colorWheel.addEventListener('input', () => paintPicker(colorWheel.value));

    colorHex.addEventListener('input', () => {
      const hex = normalizeHex(colorHex.value);
      if (hex) paintPicker(hex);
    });

    colorForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const hex = normalizeHex(colorHex.value);
      if (!hex) {
        colorError.textContent = 'Colors are hex codes like #2570c7.';
        return;
      }
      try {
        const data = await api('/api/user/color', { color: hex });
        rememberColor(hex);
        renderRecent();
        announce(data.user);
        colorDialog.close();
      } catch (err) {
        colorError.textContent = err.message;
      }
    });

    // Lets chat.js open the picker when someone clicks their own name.
    document.addEventListener('namecolor:open', openColorPicker);
  }

  setMode('login');
  render();

  fetch('/api/auth/me')
    .then((res) => res.json())
    .then((data) => announce(data.user))
    .catch(() => { /* stay signed out */ });
})();
