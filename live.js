// Shared live player. Polls /api/live/status and attaches the HLS stream when
// something is publishing, otherwise shows the offline placeholder. Used by the
// homepage and the standalone /live.html page.

(function () {
  const PLAYLIST = '/hls/index.m3u8';
  const POLL_MS = 5000;

  const video = document.getElementById('player');
  const offline = document.getElementById('offline');
  const badge = document.getElementById('badge');
  if (!video || !offline) return;

  let hls = null;
  let attached = false;
  let session = null;

  // Safari (and iOS) plays HLS natively; everywhere else needs hls.js.
  const nativeHls = video.canPlayType('application/vnd.apple.mpegurl') !== '';

  function attach() {
    if (attached) return;

    if (nativeHls) {
      video.src = PLAYLIST;
    } else if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ lowLatencyMode: true, backBufferLength: 30 });
      hls.loadSource(PLAYLIST);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_, data) => {
        // A fatal error usually means the publisher dropped; fall back to the
        // offline state and let polling bring us back.
        if (data.fatal) detach();
      });
    } else {
      return;
    }

    attached = true;
    offline.hidden = true;
    if (badge) badge.hidden = false;
    video.play().catch(() => { /* autoplay blocked; the controls are there */ });
  }

  function detach() {
    if (!attached) return;
    attached = false;

    if (hls) {
      hls.destroy();
      hls = null;
    }
    video.removeAttribute('src');
    video.load();
    offline.hidden = false;
    if (badge) badge.hidden = true;
  }

  async function poll() {
    try {
      const res = await fetch('/api/live/status', { cache: 'no-store' });
      const status = await res.json();
      if (!status.live) {
        session = null;
        detach();
        return;
      }
      // A restart between two polls looks like a live stream that never
      // stopped, but the playlist underneath has been replaced. Rebuild rather
      // than let hls.js try to follow a sequence that ran backwards.
      if (attached && status.session !== session) detach();
      session = status.session;
      attach();
    } catch {
      detach();
    }
  }

  poll();
  setInterval(poll, POLL_MS);
})();
