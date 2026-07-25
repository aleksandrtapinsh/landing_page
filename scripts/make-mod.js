// Grants or revokes chat moderator. Run on the server:
//
//   npm run mod -- <username>            make a moderator
//   npm run mod -- <username> --remove   demote back to a normal user

const path = require('path');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  // no .env file, fall back to the ambient environment
}

const db = require('../lib/db.js');

const username = (process.argv[2] ?? '').trim();
const remove = process.argv.includes('--remove');

if (!username || username.startsWith('--')) {
  console.error('Usage: npm run mod -- <username> [--remove]');
  process.exit(1);
}

(async () => {
  await db.connect();
  const update = remove ? { $unset: { role: '' } } : { $set: { role: 'moderator' } };
  const result = await db.users().findOneAndUpdate(
    { usernameLower: username.toLowerCase() },
    update,
    { returnDocument: 'after' },
  );
  if (!result) {
    console.error(`No user named "${username}".`);
    process.exit(1);
  }
  console.log(`${result.username} is ${result.role === 'moderator' ? 'now' : 'no longer'} a moderator.`);
  await db.close();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
