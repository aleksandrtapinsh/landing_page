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
      const name = document.createElement('span');
      name.className = 'account-name';
      name.textContent = user.username;
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

  setMode('login');
  render();

  fetch('/api/auth/me')
    .then((res) => res.json())
    .then((data) => announce(data.user))
    .catch(() => { /* stay signed out */ });
})();
