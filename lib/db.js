// MongoDB connection and collection handles.
//
// The database is created on first write; all this does is connect and make
// sure the indexes that enforce uniqueness and expiry exist.

const { MongoClient } = require('mongodb');

// Read lazily rather than at module load, so it doesn't matter whether the
// caller loaded its .env before or after requiring this file.
const uri = () => process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const dbName = () => process.env.MONGODB_DB || 'sasha_site';

let client = null;
let db = null;

async function connect() {
  if (db) return db;

  client = new MongoClient(uri(), { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  db = client.db(dbName());

  // Uniqueness is enforced here rather than by checking before insert, so two
  // simultaneous signups can't both pass the check and both succeed.
  await db.collection('users').createIndexes([
    { key: { email: 1 }, unique: true },
    { key: { usernameLower: 1 }, unique: true },
  ]);

  // Mongo drops session documents itself once expiresAt passes.
  await db.collection('sessions').createIndexes([
    { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ]);

  await db.collection('messages').createIndexes([
    { key: { createdAt: -1 } },
    // Backstop only: the chat log is normally wiped once the stream has been
    // offline for 12 hours (see sweepChat in server.js). This catches anything
    // posted during a long silence after that wipe already happened.
    { key: { createdAt: 1 }, expireAfterSeconds: 60 * 60 * 24 * 30 },
  ]);

  return db;
}

async function close() {
  await client?.close();
  client = null;
  db = null;
}

const users = () => db.collection('users');
const sessions = () => db.collection('sessions');
const messages = () => db.collection('messages');
// Small housekeeping documents that have to survive a restart, e.g. when the
// stream was last live so the chat-clearing clock isn't reset by a deploy.
const meta = () => db.collection('meta');

module.exports = { connect, close, users, sessions, messages, meta, uri, dbName };
