const http = require('http');
const fs = require('fs');
const path = require('path');

// Before the lib requires: they read configuration at module load.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // no .env file, fall back to the ambient environment
}

const { ObjectId } = require('mongodb');
const db = require('./lib/db.js');
const auth = require('./lib/auth.js');
const realtime = require('./lib/realtime.js');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const HLS_PLAYLIST = path.join(ROOT, 'hls', 'index.m3u8');
const HLS_SESSION = path.join(ROOT, 'hls', 'session');

// A stream is "live" if ffmpeg refreshed the playlist recently. Segments are
// 2s, so anything older than this means the publisher went away.
const LIVE_STALE_MS = 20000;

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
};

const DENIED = ['node_modules', 'scripts', 'lib', '.git', '.env', 'package.json', 'package-lock.json'];

// Viewers are counted by heartbeat: each open player sends an id with its
// status poll, and is forgotten if three polls go by without hearing from it.
// This counts open players, not people — two tabs are two viewers.
const VIEWER_TTL_MS = 15000;
const MAX_VIEWERS = 5000;

// clientId -> { identity, seen }. Keyed per open player so one tab closing
// doesn't drop a viewer who still has another open, but counted by identity so
// a signed-in user watching from three tabs is one viewer.
const viewers = new Map();

function countViewers(clientId, watching, user) {
  const now = Date.now();
  for (const [key, entry] of viewers) {
    if (now - entry.seen >= VIEWER_TTL_MS) viewers.delete(key);
  }

  if (clientId) {
    // Dropping the entry on `watching=false` means closing the player is
    // reflected immediately rather than after the timeout.
    if (watching && (viewers.has(clientId) || viewers.size < MAX_VIEWERS)) {
      viewers.set(clientId, { identity: user ? `u:${user.id}` : `a:${clientId}`, seen: now });
    } else if (!watching) {
      viewers.delete(clientId);
    }
  }

  const identities = new Set();
  for (const entry of viewers.values()) identities.add(entry.identity);
  return { viewers: identities.size, sessions: viewers.size };
}

// Enough headroom for normal use, low enough to make password guessing slow.
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 20;
const authAttempts = new Map();

function authRateLimited(ip) {
  const now = Date.now();
  const hits = (authAttempts.get(ip) ?? []).filter((t) => now - t < AUTH_WINDOW_MS);
  hits.push(now);
  authAttempts.set(ip, hits);
  if (authAttempts.size > 10000) authAttempts.clear();
  return hits.length > AUTH_MAX_ATTEMPTS;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 16 * 1024) {
        reject(new auth.AuthError('Request too large.', 413));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new auth.AuthError('Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function liveState() {
  try {
    if (Date.now() - fs.statSync(HLS_PLAYLIST).mtimeMs >= LIVE_STALE_MS) {
      return { live: false, session: null };
    }
    // The session changes on every restart; the player watches it so it can
    // tear down and rebuild rather than trying to follow a playlist that just
    // jumped backwards.
    return { live: true, session: fs.readFileSync(HLS_SESSION, 'utf8').trim() };
  } catch {
    return { live: false, session: null };
  }
}

function sendJson(res, body, status = 200, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function handleAuth(req, res, urlPath) {
  if (urlPath === '/api/auth/me') {
    sendJson(res, { user: await auth.currentUser(req) });
    return true;
  }

  if (req.method !== 'POST') {
    sendJson(res, { error: 'Method not allowed.' }, 405);
    return true;
  }

  if (authRateLimited(req.socket.remoteAddress)) {
    sendJson(res, { error: 'Too many attempts. Try again later.' }, 429);
    return true;
  }

  if (urlPath === '/api/auth/logout') {
    await auth.destroySession(auth.parseCookies(req.headers.cookie)[auth.COOKIE]);
    sendJson(res, { user: null }, 200, { 'Set-Cookie': auth.clearCookie(req) });
    return true;
  }

  const body = await readJson(req);
  const user = urlPath === '/api/auth/register'
    ? await auth.register(body)
    : await auth.login(body);

  const { token, expiresAt } = await auth.createSession(user.id);
  sendJson(res, { user }, 200, { 'Set-Cookie': auth.sessionCookie(req, token, expiresAt) });
  return true;
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

async function handleNameColor(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, { error: 'Method not allowed.' }, 405);
    return;
  }
  const user = await auth.currentUser(req);
  if (!user) {
    sendJson(res, { error: 'Sign in first.' }, 401);
    return;
  }

  const color = String((await readJson(req)).color ?? '').trim().toLowerCase();
  if (!HEX_COLOR_RE.test(color)) {
    sendJson(res, { error: 'Colors are hex codes like #2570c7.' }, 400);
    return;
  }
  // The chat sits on a white background; a name lighter than this ceiling
  // would be unreadable, so refuse it rather than let someone vanish.
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  if ((0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.72) {
    sendJson(res, { error: 'That color is too light to read here — pick a darker one.' }, 400);
    return;
  }

  await db.users().updateOne({ _id: new ObjectId(user.id) }, { $set: { nameColor: color } });
  sendJson(res, { user: { ...user, nameColor: color } });
}

// One week is the longest timeout a moderator can hand out.
const TIMEOUT_MAX_MINUTES = 7 * 24 * 60;

async function handleMod(req, res, urlPath) {
  const me = await auth.currentUser(req);
  if (!me || me.role !== 'moderator') {
    sendJson(res, { error: 'Moderators only.' }, 403);
    return;
  }

  if (urlPath === '/api/mod/chatters') {
    const { online, anonymous } = realtime.listChatters();
    const onlineIds = new Set(online.map((u) => u.id));
    // Also list restricted users who are not connected right now, otherwise a
    // ban could never be lifted once the person left.
    const restricted = await db.users()
      .find(
        { $or: [{ bannedAt: { $ne: null } }, { mutedUntil: { $gt: new Date() } }] },
        { projection: { username: 1, nameColor: 1, role: 1, bannedAt: 1, mutedUntil: 1 } },
      )
      .toArray();

    const rows = new Map();
    for (const u of online) {
      rows.set(u.id, {
        username: u.username, color: u.nameColor, role: u.role, online: true,
        banned: false, mutedUntil: null,
      });
    }
    for (const u of restricted) {
      const id = u._id.toString();
      const row = rows.get(id) ?? {
        username: u.username, color: u.nameColor ?? null, role: u.role ?? null,
        online: onlineIds.has(id), banned: false, mutedUntil: null,
      };
      row.banned = Boolean(u.bannedAt);
      row.mutedUntil = u.mutedUntil && u.mutedUntil > new Date() ? u.mutedUntil.toISOString() : null;
      rows.set(id, row);
    }
    sendJson(res, { anonymous, users: [...rows.values()] });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, { error: 'Method not allowed.' }, 405);
    return;
  }

  const body = await readJson(req);
  const username = String(body.username ?? '').trim().toLowerCase();
  const target = await db.users().findOne({ usernameLower: username });
  if (!target) {
    sendJson(res, { error: 'No such user.' }, 404);
    return;
  }
  if (target.role === 'moderator') {
    sendJson(res, { error: "Moderators can't be moderated." }, 400);
    return;
  }
  const targetId = target._id.toString();

  if (urlPath === '/api/mod/ban') {
    await db.users().updateOne({ _id: target._id }, { $set: { bannedAt: new Date() } });
    realtime.notifyUser(targetId, { type: 'error', message: 'You have been banned from chat.' });
    console.log(`[mod] ${me.username} banned ${target.username}`);
  } else if (urlPath === '/api/mod/unban') {
    await db.users().updateOne({ _id: target._id }, { $unset: { bannedAt: '', mutedUntil: '' } });
    console.log(`[mod] ${me.username} unrestricted ${target.username}`);
  } else if (urlPath === '/api/mod/timeout') {
    const minutes = Math.floor(Number(body.minutes));
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > TIMEOUT_MAX_MINUTES) {
      sendJson(res, { error: `Timeout must be 1 to ${TIMEOUT_MAX_MINUTES} minutes.` }, 400);
      return;
    }
    const mutedUntil = new Date(Date.now() + minutes * 60000);
    await db.users().updateOne({ _id: target._id }, { $set: { mutedUntil } });
    realtime.notifyUser(targetId, {
      type: 'error',
      message: `You have been timed out for ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    });
    console.log(`[mod] ${me.username} timed out ${target.username} for ${minutes}m`);
  } else {
    sendJson(res, { error: 'Not found.' }, 404);
    return;
  }
  sendJson(res, { ok: true });
}

// Chat belongs to the broadcast: once nothing has been streaming for this
// long, the log is wiped so the next stream starts on a clean slate. The clock
// runs only while offline and restarts after each wipe, so a long silence
// clears the chat every 12 hours rather than just once.
const CHAT_CLEAR_AFTER_MS = 12 * 60 * 60 * 1000;
const CHAT_SWEEP_MS = 5 * 60 * 1000;

async function sweepChat() {
  const now = new Date();

  if (liveState().live) {
    await db.meta().updateOne({ _id: 'chat' }, { $set: { clockAt: now } }, { upsert: true });
    return;
  }

  const state = await db.meta().findOne({ _id: 'chat' });
  // Stored in Mongo rather than in memory so a restart or deploy doesn't hand
  // the chat another 12 hours. On a database that has never seen this, start
  // the clock instead of wiping history the server knows nothing about.
  if (!state?.clockAt) {
    await db.meta().updateOne({ _id: 'chat' }, { $set: { clockAt: now } }, { upsert: true });
    return;
  }
  if (now - state.clockAt < CHAT_CLEAR_AFTER_MS) return;

  const removed = await realtime.clearChat();
  await db.meta().updateOne({ _id: 'chat' }, { $set: { clockAt: now, clearedAt: now } });
  if (removed > 0) {
    console.log(`[chat] cleared ${removed} message${removed === 1 ? '' : 's'} after 12h offline`);
  }
}

async function handle(req, res) {
  let url;
  let urlPath;
  try {
    url = new URL(req.url, 'http://localhost');
    urlPath = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  if (urlPath === '/api/auth/register' || urlPath === '/api/auth/login'
    || urlPath === '/api/auth/logout' || urlPath === '/api/auth/me') {
    await handleAuth(req, res, urlPath);
    return;
  }

  if (urlPath === '/api/user/color') {
    await handleNameColor(req, res);
    return;
  }

  if (urlPath.startsWith('/api/mod/')) {
    await handleMod(req, res, urlPath);
    return;
  }

  if (urlPath === '/api/live/status') {
    const viewing = url.searchParams.get('viewing') === '1';
    const user = await auth.currentUser(req);
    const counts = countViewers(url.searchParams.get('id'), viewing, user);
    sendJson(res, { ...liveState(), ...counts, playlist: '/hls/index.m3u8' });
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.normalize(path.join(ROOT, urlPath));
  const first = path.relative(ROOT, filePath).split(path.sep)[0];
  if (!filePath.startsWith(ROOT + path.sep) || DENIED.includes(first)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not Found' : 'Internal Server Error');
      return;
    }
    const ext = path.extname(filePath);
    const headers = { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' };
    if (ext === '.m3u8') {
      // The playlist is rewritten every couple of seconds; never cache it.
      headers['Cache-Control'] = 'no-store';
    } else if (ext === '.html' || ext === '.js' || ext === '.css') {
      // Small enough that revalidating costs nothing, and it means a deploy
      // takes effect without anyone having to hard-refresh.
      headers['Cache-Control'] = 'no-cache';
    } else if (ext === '.ts' || ext === '.m4s') {
      // Segment names are unique per broadcast, so these are safe to cache —
      // but each one is deleted from disk within ~15-30s and never requested
      // again. A long lifetime would just pile gigabytes of dead video into
      // the viewer's browser cache; a minute is plenty to cover a rebuffer.
      headers['Cache-Control'] = 'public, max-age=60';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (res.headersSent) return;
    // AuthError carries a message meant for the person using the site;
    // anything else is a bug and shouldn't leak its details.
    const status = err.status ?? 500;
    if (status >= 500) console.error(`[http] ${req.method} ${req.url}: ${err.stack ?? err}`);
    sendJson(res, { error: status >= 500 ? 'Something went wrong.' : err.message }, status);
  });
});

realtime.attach(server);

db.connect()
  .then(() => {
    console.log(`Connected to MongoDB (${db.dbName()})`);
    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

    const sweep = () => sweepChat().catch((err) => console.error(`[chat] sweep failed: ${err.message}`));
    sweep();
    setInterval(sweep, CHAT_SWEEP_MS);
  })
  .catch((err) => {
    console.error(`Could not connect to MongoDB at ${db.uri()}: ${err.message}`);
    console.error('Accounts and chat need MongoDB. Is mongod running?');
    process.exit(1);
  });
