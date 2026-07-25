// Runs the site and the RTMP ingest as one foreground process, so `npm start`
// brings up everything. Output from both is prefixed; if either one dies the
// other is shut down too, so systemd sees a single unit fail.

const { spawn } = require('child_process');

const SERVICES = [
  { name: 'site', script: 'server.js', color: '\x1b[36m' },
  { name: 'stream', script: 'stream-server.js', color: '\x1b[35m' },
];

const RESET = '\x1b[0m';
const width = Math.max(...SERVICES.map((s) => s.name.length));

let shuttingDown = false;
const children = [];

function pipeLines(service, stream, out) {
  let buffered = '';
  stream.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop();
    for (const line of lines) {
      out.write(`${service.color}${service.name.padEnd(width)}${RESET} | ${line}\n`);
    }
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  // Don't let a wedged child hold the whole thing open.
  setTimeout(() => process.exit(code), 5000).unref();
}

for (const service of SERVICES) {
  const child = spawn(process.execPath, [service.script], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);

  pipeLines(service, child.stdout, process.stdout);
  pipeLines(service, child.stderr, process.stderr);

  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(`\n${service.name} exited (code=${code} signal=${signal}) — stopping everything.`);
    }
    shutdown(code === 0 ? 0 : (code ?? 1));
  });

  child.on('error', (err) => {
    console.error(`${service.name} failed to start: ${err.message}`);
    shutdown(1);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}

process.on('exit', () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
