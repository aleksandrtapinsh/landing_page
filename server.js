const http = require('http');
const fs = require('fs');
const path = require('path');

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

const DENIED = ['node_modules', 'scripts', '.git', '.env', 'package.json', 'package-lock.json'];

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

function sendJson(res, body) {
  const data = JSON.stringify(body);
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  if (urlPath === '/api/live/status') {
    sendJson(res, { ...liveState(), playlist: '/hls/index.m3u8' });
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
      // but each one is deleted from disk after ~18s and never requested again.
      // A long lifetime would just pile gigabytes of dead video into the
      // viewer's browser cache; a minute is plenty to cover a rebuffer.
      headers['Cache-Control'] = 'public, max-age=60';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
