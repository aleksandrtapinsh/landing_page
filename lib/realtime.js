// WebSocket chat.
//
// Anyone may read the chat; only signed-in users may post. Messages are stored
// as plain text and rendered with textContent on the client, so there is no
// markup to escape and nothing to inject.

const { WebSocketServer } = require('ws');
const { ObjectId } = require('mongodb');
const db = require('./db.js');
const auth = require('./auth.js');

const PATH = '/ws/chat';
const HISTORY = 50;
const MAX_LENGTH = 500;

// A small burst is fine, sustained spam is not.
const RATE_BURST = 5;
const RATE_REFILL_MS = 2000;

const clients = new Set();

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

async function recentMessages() {
  const docs = await db.messages()
    .find({}, { sort: { createdAt: -1 }, limit: HISTORY })
    .toArray();
  return docs.reverse().map((d) => ({
    id: d._id.toString(),
    username: d.username,
    color: d.color ?? null,
    text: d.text,
    at: d.createdAt.toISOString(),
  }));
}

async function handleMessage(ws, raw) {
  // Auth resolves in parallel with the connection; a message can beat it.
  if (ws.user === undefined) ws.user = await ws.userPromise;
  if (!ws.user) {
    send(ws, { type: 'error', message: 'Sign in to chat.' });
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (parsed?.type !== 'message') return;

  const text = String(parsed.text ?? '').trim();
  if (!text) return;
  if (text.length > MAX_LENGTH) {
    send(ws, { type: 'error', message: `Messages are limited to ${MAX_LENGTH} characters.` });
    return;
  }

  // Bans and timeouts are checked against the database on every message, so
  // they take effect immediately even on sockets opened before the action.
  const restriction = await db.users().findOne(
    { _id: new ObjectId(ws.user.id) },
    { projection: { bannedAt: 1, mutedUntil: 1 } },
  );
  if (restriction?.bannedAt) {
    send(ws, { type: 'error', message: 'You are banned from chat.' });
    return;
  }
  if (restriction?.mutedUntil && restriction.mutedUntil > new Date()) {
    const left = Math.ceil((restriction.mutedUntil - Date.now()) / 60000);
    send(ws, { type: 'error', message: `You are timed out for another ${left} minute${left === 1 ? '' : 's'}.` });
    return;
  }

  // Token bucket: refill one slot per interval, never above the burst size.
  const now = Date.now();
  const refilled = Math.floor((now - ws.rate.at) / RATE_REFILL_MS);
  ws.rate.tokens = Math.min(RATE_BURST, ws.rate.tokens + refilled);
  if (refilled > 0) ws.rate.at = now;
  if (ws.rate.tokens <= 0) {
    send(ws, { type: 'error', message: 'Slow down a moment.' });
    return;
  }
  ws.rate.tokens -= 1;

  const doc = {
    userId: ws.user.id,
    username: ws.user.username,
    // Denormalised like username: a message keeps the color it was posted
    // with, and the socket re-authenticates when the user changes it.
    color: ws.user.nameColor ?? null,
    text,
    createdAt: new Date(),
  };
  const { insertedId } = await db.messages().insertOne(doc);

  broadcast({
    type: 'message',
    id: insertedId.toString(),
    username: doc.username,
    color: doc.color,
    text: doc.text,
    at: doc.createdAt.toISOString(),
  });
}

/** Who is connected to chat right now: signed-in users (unique) + anon count. */
function listChatters() {
  const online = new Map();
  let anonymous = 0;
  for (const ws of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (ws.user) online.set(ws.user.id, ws.user);
    else anonymous += 1;
  }
  return { online: [...online.values()], anonymous };
}

/** Push a payload to every socket a user has open (e.g. "you were banned"). */
function notifyUser(userId, payload) {
  for (const ws of clients) {
    if (ws.user?.id === userId) send(ws, payload);
  }
}

function attach(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    clients.add(ws);
    ws.rate = { tokens: RATE_BURST, at: Date.now() };

    // Listeners must be attached synchronously: a frame that arrives while
    // this handler is awaiting something is otherwise silently dropped.
    ws.on('message', (raw) => {
      handleMessage(ws, raw).catch((err) => console.error(`[chat] ${err.message}`));
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));

    ws.userPromise = auth.currentUser(req).catch(() => null);
    ws.userPromise.then(async (user) => {
      ws.user = user;
      send(ws, { type: 'welcome', user });
      try {
        send(ws, { type: 'history', messages: await recentMessages() });
      } catch (err) {
        console.error(`[chat] history failed: ${err.message}`);
      }
    });
  });

  return wss;
}

module.exports = { attach, listChatters, notifyUser, PATH };
