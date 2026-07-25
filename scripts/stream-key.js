// Generates the OBS stream key and stores it in .env.
// Existing keys are kept unless --force is passed.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');
const force = process.argv.includes('--force');

let env = '';
try {
  env = fs.readFileSync(ENV_PATH, 'utf8');
} catch {
  // no .env yet
}

const existing = env.match(/^STREAM_KEY=(.*)$/m);
if (existing && !force) {
  console.log(`Stream key already set in .env:\n\n  ${existing[1]}\n`);
  console.log('Re-run with --force to replace it.');
  process.exit(0);
}

const key = crypto.randomBytes(24).toString('base64url');
const line = `STREAM_KEY=${key}`;
const next = existing ? env.replace(/^STREAM_KEY=.*$/m, line) : `${env.trimEnd()}\n${line}\n`.trimStart();

fs.writeFileSync(ENV_PATH, next, { mode: 0o600 });

console.log('Wrote .env\n');
console.log('OBS -> Settings -> Stream -> Service: Custom...\n');
console.log(`  Server:     rtmp://sasha-tapinsh.online/live`);
console.log(`  Stream Key: ${key}\n`);
