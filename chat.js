// Chat client. Reads over a WebSocket for everyone; posting needs an account.
// Message text is written with textContent, never innerHTML, so nothing a
// viewer types can become markup.

(function () {
  const log = document.getElementById('chat-log');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const notice = document.getElementById('chat-notice');
  const modOpen = document.getElementById('mod-open');
  const modDialog = document.getElementById('mod-dialog');
  const modList = document.getElementById('mod-list');
  const modAnon = document.getElementById('mod-anon');
  const modError = document.getElementById('mod-error');
  if (!log || !form) return;

  const RECONNECT_MIN_MS = 1000;
  const RECONNECT_MAX_MS = 15000;

  let socket = null;
  let user = null;
  let retryMs = RECONNECT_MIN_MS;
  let closing = false;

  function atBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  }

  function addMessage(msg) {
    // Only follow along if they haven't scrolled up to read something.
    const stick = atBottom();

    const line = document.createElement('div');
    line.className = 'chat-msg';

    const who = document.createElement('span');
    who.className = 'chat-who';
    who.textContent = msg.username;
    // Only a validated hex ever reaches the style, whatever the server sent.
    if (/^#[0-9a-f]{6}$/i.test(msg.color ?? '')) who.style.color = msg.color;
    if (user && msg.username === user.username) {
      who.classList.add('chat-who--me');
      who.title = 'Change your name color';
    }

    const text = document.createElement('span');
    text.className = 'chat-text';
    text.textContent = msg.text;

    line.append(who, text);
    if (msg.at) line.title = new Date(msg.at).toLocaleString();
    log.append(line);

    if (stick) log.scrollTop = log.scrollHeight;
  }

  function systemLine(text) {
    const line = document.createElement('div');
    line.className = 'chat-system';
    line.textContent = text;
    log.append(line);
    log.scrollTop = log.scrollHeight;
  }

  function isMod() {
    return user?.role === 'moderator';
  }

  function updateComposer() {
    const canPost = Boolean(user) && socket?.readyState === WebSocket.OPEN;
    input.disabled = !canPost;
    form.querySelector('button').disabled = !canPost;
    if (!user) notice.textContent = 'Sign in to chat.';
    else if (!canPost) notice.textContent = 'Reconnecting…';
    else notice.textContent = '';
    if (modOpen) modOpen.hidden = !isMod();
  }

  function connect() {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${scheme}//${location.host}/ws/chat`);
    socket = ws;

    ws.addEventListener('open', () => {
      retryMs = RECONNECT_MIN_MS;
      updateComposer();
    });

    ws.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (payload.type === 'welcome') {
        user = payload.user;
        updateComposer();
      } else if (payload.type === 'history') {
        log.textContent = '';
        payload.messages.forEach(addMessage);
        log.scrollTop = log.scrollHeight;
      } else if (payload.type === 'message') {
        addMessage(payload);
      } else if (payload.type === 'cleared') {
        log.textContent = '';
        systemLine('Chat was cleared.');
      } else if (payload.type === 'error') {
        systemLine(payload.message);
      }
    });

    ws.addEventListener('close', () => {
      updateComposer();
      // Reconnect only if this socket is still the current one — a close that
      // arrives after we've already been replaced (sign in/out swaps the
      // socket) must not spawn a duplicate connection.
      if (closing || ws !== socket) return;
      // Back off so a server restart doesn't get hammered by every open tab.
      setTimeout(() => { if (ws === socket) connect(); }, retryMs);
      retryMs = Math.min(RECONNECT_MAX_MS, retryMs * 2);
    });

    ws.addEventListener('error', () => ws.close());
  }

  // Clicking your own name opens the color picker; a moderator clicking
  // anyone else's name opens the moderation roster.
  log.addEventListener('click', (event) => {
    const who = event.target.closest('.chat-who');
    if (!who) return;
    if (who.classList.contains('chat-who--me')) {
      document.dispatchEvent(new CustomEvent('namecolor:open'));
    } else if (isMod()) {
      openModDialog();
    }
  });

  // --- moderation ---

  const TIMEOUT_CHOICES = [
    [1, '1 min'], [5, '5 min'], [10, '10 min'], [60, '1 hour'], [1440, '24 hours'],
  ];

  async function modAction(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  function modRow(u) {
    const row = document.createElement('div');
    row.className = 'mod-row';

    const name = document.createElement('span');
    name.className = 'mod-name';
    name.textContent = u.username;
    if (/^#[0-9a-f]{6}$/i.test(u.color ?? '')) name.style.color = u.color;

    const status = document.createElement('span');
    status.className = 'mod-status';
    if (u.role === 'moderator') status.textContent = 'mod';
    else if (u.banned) status.textContent = 'banned';
    else if (u.mutedUntil) {
      const left = Math.ceil((new Date(u.mutedUntil) - Date.now()) / 60000);
      status.textContent = `timed out ${left}m`;
    } else status.textContent = u.online ? 'online' : '';

    row.append(name, status);

    // No controls against fellow moderators; the server refuses anyway.
    if (u.role === 'moderator') return row;

    const controls = document.createElement('span');
    controls.className = 'mod-controls';

    if (u.banned || u.mutedUntil) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'account-btn';
      clear.textContent = u.banned ? 'Unban' : 'Clear';
      clear.addEventListener('click', () => runModAction('/api/mod/unban', { username: u.username }));
      controls.append(clear);
    }
    if (!u.banned) {
      const select = document.createElement('select');
      select.className = 'mod-select';
      for (const [minutes, label] of TIMEOUT_CHOICES) {
        const opt = document.createElement('option');
        opt.value = minutes;
        opt.textContent = label;
        select.append(opt);
      }
      const timeout = document.createElement('button');
      timeout.type = 'button';
      timeout.className = 'account-btn';
      timeout.textContent = 'Timeout';
      timeout.addEventListener('click', () => runModAction('/api/mod/timeout', {
        username: u.username, minutes: Number(select.value),
      }));

      const ban = document.createElement('button');
      ban.type = 'button';
      ban.className = 'account-btn mod-ban';
      ban.textContent = 'Ban';
      ban.addEventListener('click', () => runModAction('/api/mod/ban', { username: u.username }));

      controls.append(select, timeout, ban);
    }
    row.append(controls);
    return row;
  }

  async function loadChatters() {
    modError.textContent = '';
    try {
      const res = await fetch('/api/mod/chatters');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      modAnon.textContent = data.anonymous > 0
        ? `${data.anonymous} anonymous viewer${data.anonymous === 1 ? '' : 's'} reading`
        : '';
      modList.textContent = '';
      if (data.users.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'mod-empty';
        empty.textContent = 'No signed-in users in chat.';
        modList.append(empty);
      }
      for (const u of data.users) modList.append(modRow(u));
    } catch (err) {
      modError.textContent = err.message;
    }
  }

  async function runModAction(path, body) {
    modError.textContent = '';
    try {
      await modAction(path, body);
      await loadChatters();
    } catch (err) {
      modError.textContent = err.message;
    }
  }

  function openModDialog() {
    if (!modDialog || !isMod()) return;
    modDialog.showModal();
    loadChatters();
  }

  if (modOpen) modOpen.addEventListener('click', openModDialog);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'message', text }));
    input.value = '';
  });

  // Signing in or out changes what the server will accept from this socket, so
  // reconnect to re-authenticate rather than guessing locally. connect() makes
  // the new socket current first, so the old one's close event is ignored.
  document.addEventListener('account:change', () => {
    const old = socket;
    connect();
    old?.close();
  });

  window.addEventListener('beforeunload', () => {
    closing = true;
    socket?.close();
  });

  updateComposer();
  connect();
})();
