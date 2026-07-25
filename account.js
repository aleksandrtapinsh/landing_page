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

  function render() {
    bar.textContent = '';
    if (user) {
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'account-name';
      name.title = 'Change your name color';
      name.textContent = user.username;
      if (user.nameColor) name.style.color = user.nameColor;
      name.addEventListener('click', openColorPicker);
      const out = document.createElement('button');
      out.className = 'account-btn';
      out.textContent = 'Sign out';
      out.addEventListener('click', signOut);
      bar.append(name, out);
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
  const colorSwatches = document.getElementById('color-swatches');
  const colorHex = document.getElementById('color-hex');
  const colorPreview = document.getElementById('color-preview');
  const colorError = document.getElementById('color-error');

  // Readable on the near-black chat background; the hex field takes anything.
  const PALETTE = [
    '#e8e8e8', '#f28b82', '#ffa94d', '#fdd663', '#a3e635', '#81c995',
    '#5eead4', '#78d9ec', '#8ab4f8', '#c58af9', '#ff8bcb', '#f9a8d4',
  ];
  const DEFAULT_COLOR = '#8ab4f8';

  function normalizeHex(value) {
    const hex = String(value ?? '').trim().replace(/^([0-9a-fA-F]{6})$/, '#$1');
    return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : null;
  }

  function paintPicker(color) {
    colorHex.value = color;
    colorPreview.textContent = user ? user.username : '';
    colorPreview.style.color = color;
    for (const btn of colorSwatches.children) {
      btn.classList.toggle('color-swatch--active', btn.dataset.color === color);
    }
  }

  function openColorPicker() {
    if (!user || !colorDialog) return;
    colorError.textContent = '';
    paintPicker(user.nameColor || DEFAULT_COLOR);
    colorDialog.showModal();
  }

  if (colorDialog) {
    for (const color of PALETTE) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-swatch';
      btn.dataset.color = color;
      btn.style.background = color;
      btn.title = color;
      btn.addEventListener('click', () => paintPicker(color));
      colorSwatches.append(btn);
    }

    colorHex.addEventListener('input', () => {
      const hex = normalizeHex(colorHex.value);
      if (hex) paintPicker(hex);
    });

    colorForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const hex = normalizeHex(colorHex.value);
      if (!hex) {
        colorError.textContent = 'Colors are hex codes like #8ab4f8.';
        return;
      }
      try {
        const data = await api('/api/user/color', { color: hex });
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
