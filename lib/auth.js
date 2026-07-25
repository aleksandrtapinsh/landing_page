// Accounts and sessions.
//
// Passwords are hashed with scrypt, which is built into Node — no native
// module to compile. Session tokens are random and only their hash is stored,
// so a dump of the sessions collection can't be replayed as a login.

const crypto = require('crypto');
const { promisify } = require('util');
const { ObjectId } = require('mongodb');
const db = require('./db.js');

const scrypt = promisify(crypto.scrypt);

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_DAYS = 30;
const COOKIE = 'sid';

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;

class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt.toString('base64')}:${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, salt, key] = String(stored).split(':');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(key, 'base64');
    const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function publicUser(user) {
  return user && {
    id: user._id.toString(),
    username: user.username,
    email: user.email,
    nameColor: user.nameColor ?? null,
  };
}

async function register({ email, username, password }) {
  email = String(email ?? '').trim().toLowerCase();
  username = String(username ?? '').trim();
  password = String(password ?? '');

  if (!EMAIL_RE.test(email) || email.length > 254) throw new AuthError('Enter a valid email address.');
  if (!USERNAME_RE.test(username)) {
    throw new AuthError('Username must be 3-20 characters, letters, numbers, _ or - only.');
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new AuthError(`Password must be at least ${PASSWORD_MIN} characters.`);
  }

  const doc = {
    email,
    username,
    usernameLower: username.toLowerCase(),
    passwordHash: await hashPassword(password),
    createdAt: new Date(),
  };

  try {
    const { insertedId } = await db.users().insertOne(doc);
    return publicUser({ ...doc, _id: insertedId });
  } catch (err) {
    // Let the unique indexes decide, so concurrent signups can't both win.
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern ?? {})[0];
      throw new AuthError(
        field === 'usernameLower' ? 'That username is taken.' : 'That email is already registered.',
        409,
      );
    }
    throw err;
  }
}

async function login({ identifier, password }) {
  identifier = String(identifier ?? '').trim();
  password = String(password ?? '');

  const query = identifier.includes('@')
    ? { email: identifier.toLowerCase() }
    : { usernameLower: identifier.toLowerCase() };
  const user = await db.users().findOne(query);

  // Hash even when the user doesn't exist, so response time doesn't reveal
  // which accounts are real.
  const stored = user?.passwordHash
    ?? 'scrypt:16384:8:1:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAAAAAAAA==';
  const ok = await verifyPassword(password, stored);

  if (!user || !ok) throw new AuthError('Incorrect username or password.', 401);
  return publicUser(user);
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.sessions().insertOne({
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    // Stored as an ObjectId so it matches users._id on lookup.
    userId: new ObjectId(userId),
    createdAt: new Date(),
    expiresAt,
  });
  return { token, expiresAt };
}

async function destroySession(token) {
  if (!token) return;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await db.sessions().deleteOne({ tokenHash });
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** Resolves the signed-in user for a request, or null. */
async function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const session = await db.sessions().findOne({ tokenHash });
  // Mongo's TTL sweep is periodic, so check the expiry here too.
  if (!session || session.expiresAt <= new Date()) return null;

  return publicUser(await db.users().findOne({ _id: session.userId }));
}

function isSecure(req) {
  return req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);
}

function sessionCookie(req, token, expiresAt) {
  const parts = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (isSecure(req)) parts.push('Secure');
  return parts.join('; ');
}

function clearCookie(req) {
  const parts = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecure(req)) parts.push('Secure');
  return parts.join('; ');
}

module.exports = {
  AuthError, register, login, createSession, destroySession,
  currentUser, parseCookies, sessionCookie, clearCookie, publicUser, COOKIE,
};
