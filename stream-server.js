// Live streaming ingest.
//
// OBS pushes RTMP to rtmp://<host>:1935/live/<STREAM_KEY>.
// We accept it, verify the key, and run ffmpeg to repackage it into HLS
// segments under ./hls, which server.js serves as /hls/index.m3u8.
//
// The stream key never appears in a public URL: the RTMP path is secret,
// the HLS path is fixed.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const NodeMediaServer = require('node-media-server');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // no .env file, fall back to the ambient environment
}

const STREAM_KEY = process.env.STREAM_KEY;
const RTMP_PORT = Number(process.env.RTMP_PORT) || 1935;
const FLV_PORT = Number(process.env.FLV_PORT) || 8000;
const APP_NAME = 'live';
const HLS_DIR = path.join(__dirname, 'hls');
// Identifies the current broadcast so the player can tell a restart apart from
// an ongoing stream. Lives inside HLS_DIR so it is cleared along with it.
const SESSION_FILE = path.join(HLS_DIR, 'session');

if (!STREAM_KEY) {
  console.error('STREAM_KEY is not set. Run `npm run stream:key` to generate one.');
  process.exit(1);
}

// Without ffmpeg the RTMP handshake still succeeds, so OBS reports no error and
// the site just sits on "Offline" forever. Fail here instead, where it's visible.
if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error) {
  console.error('ffmpeg was not found on PATH, but it is required to package the stream.');
  console.error('Install it, e.g.  sudo apt install ffmpeg');
  process.exit(1);
}

/** Constant-time compare so the key can't be guessed a character at a time. */
function keyMatches(candidate) {
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(STREAM_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function purgeHlsDir() {
  fs.rmSync(HLS_DIR, { recursive: true, force: true });
}

let ffmpeg = null;

// Publish/unpublish can arrive faster than ffmpeg takes to die, so every
// transition is queued behind the previous one. `generation` lets a queued
// action notice it has been superseded — otherwise a reconnect races the old
// stream's cleanup and gets its output directory deleted underneath it.
let generation = 0;
let queue = Promise.resolve();

function transition(action) {
  const gen = ++generation;
  queue = queue
    .then(killPackaging)
    .then(() => {
      if (gen === generation) action();
    })
    .catch((err) => console.error(`[hls] transition failed: ${err.message}`));
  return queue;
}

function killPackaging() {
  const child = ffmpeg;
  ffmpeg = null;
  if (!child) return Promise.resolve();

  return new Promise((resolve) => {
    // ffmpeg blocks reading the RTMP socket, so SIGTERM alone can hang.
    const force = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function startPackaging(streamPath) {
  purgeHlsDir();
  fs.mkdirSync(HLS_DIR, { recursive: true });

  // Segment numbering restarts at zero on every publish, so a fixed name like
  // seg_00000.ts refers to different video each time you go live. Segments are
  // served with a long immutable cache, so browsers would replay the *previous*
  // stream out of cache before cutting to the new one. Tagging each session
  // makes every segment URL unique and the caching correct.
  const session = crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(SESSION_FILE, session);

  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'warning',
    '-fflags', '+genpts',
    // Bail out if the ingest goes silent, so a half-open socket can't leave an
    // orphaned ffmpeg holding the output directory.
    '-rw_timeout', '5000000',
    '-i', `rtmp://127.0.0.1:${RTMP_PORT}${streamPath}`,
    // OBS already sends H.264; copying it keeps CPU near zero. Audio is
    // re-encoded because it costs almost nothing and normalises whatever
    // sample rate / layout OBS was configured with.
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
    '-hls_delete_threshold', '3',
    '-hls_flags', 'delete_segments+independent_segments+temp_file',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(HLS_DIR, `${session}_%05d.ts`),
    path.join(HLS_DIR, 'index.m3u8'),
  ];

  ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const child = ffmpeg;

  child.stderr.on('data', (chunk) => process.stderr.write(`[ffmpeg] ${chunk}`));
  child.on('error', (err) => {
    console.error(`[ffmpeg] FAILED TO START: ${err.message}`);
    console.error('[ffmpeg] the stream is being received but cannot be packaged for playback.');
  });
  child.on('exit', (code, signal) => {
    if (ffmpeg === child) ffmpeg = null;
    if (code) {
      // A non-zero exit while publishing means playback is broken; the usual
      // cause is OBS encoding something other than H.264, which can't be copied.
      console.error(`[ffmpeg] EXITED WITH ERROR (code=${code}) — check the output above.`);
    } else {
      console.log(`[ffmpeg] exited (code=${code} signal=${signal})`);
    }
  });

  console.log(`[hls] packaging ${streamPath} -> ${path.join(HLS_DIR, 'index.m3u8')}`);
}

const nms = new NodeMediaServer({
  bind: '0.0.0.0',
  rtmp: { port: RTMP_PORT },
  http: { port: FLV_PORT },
  // Publishing is gated on the stream key below; playback is public by design.
  auth: { play: false, publish: false, secret: '' },
});

// Whoever is currently on air. Tracked here because this handler runs before
// node-media-server's own duplicate check, so without it a second connection
// would tear down the live stream's ffmpeg.
let publisherId = null;

nms.on('postPublish', (session) => {
  if (session.streamApp !== APP_NAME || !keyMatches(session.streamName)) {
    console.warn(`[rtmp] rejected publish from ${session.ip} to ${session.streamPath}`);
    session.close();
    return;
  }
  if (publisherId !== null) {
    console.warn(`[rtmp] rejected publish from ${session.ip}: already streaming`);
    session.close();
    return;
  }
  publisherId = session.id;
  console.log(`[rtmp] publisher connected from ${session.ip}`);
  const { streamPath } = session;
  transition(() => startPackaging(streamPath));
});

nms.on('donePublish', (session) => {
  if (session.id !== publisherId) return;
  publisherId = null;
  console.log(`[rtmp] publisher disconnected from ${session.ip}`);
  // Drop the playlist once ffmpeg is gone, so the site reports it offline.
  transition(purgeHlsDir);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    transition(purgeHlsDir).finally(() => process.exit(0));
  });
}

purgeHlsDir();
nms.run();
console.log(`[rtmp] ingest ready: rtmp://<host>:${RTMP_PORT}/${APP_NAME} (stream key required)`);
