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
  let playing = false;

  // Safari (and iOS) plays HLS natively; everywhere else needs hls.js.
  const nativeHls = video.canPlayType('application/vnd.apple.mpegurl') !== '';

  video.addEventListener('playing', () => { playing = true; });
  // Whenever the element says it has something to show, try to start. Chasing a
  // single "right" moment to call play() is fragile — the element's own state is
  // the only reliable signal.
  video.addEventListener('canplay', start);
  video.addEventListener('loadeddata', start);

  function attach() {
    if (attached) return;
    attached = true;

    if (nativeHls) {
      video.src = PLAYLIST;
    } else if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ lowLatencyMode: true, backBufferLength: 30 });
      hls.on(Hls.Events.ERROR, (_, data) => {
        // A fatal error usually means the publisher dropped; fall back to the
        // offline state and let polling bring us back.
        if (data.fatal) detach();
      });
      // Canonical hls.js order: attach the element first, load the playlist
      // once the MediaSource is actually in place. Loading first means
      // MANIFEST_PARSED can fire while the element still has no source.
      hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(PLAYLIST));
      hls.on(Hls.Events.MANIFEST_PARSED, start);
      hls.attachMedia(video);
    } else {
      attached = false;
      return;
    }

    offline.hidden = true;
    if (badge) badge.hidden = false;
  }

  // Safe to call as often as we like: it gives up if there is nothing to play
  // yet, and stops nagging once playback has actually begun so that a viewer
  // who deliberately pauses is left alone.
  function start() {
    if (!attached || playing || !video.paused) return;
    video.play().catch(() => { /* not ready yet, or autoplay blocked */ });
  }

  function detach() {
    if (!attached) return;
    attached = false;
    playing = false;

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
      // Backstop: if every event we hooked has come and gone without playback
      // actually beginning, keep nudging it rather than sitting on a blank
      // frame until someone reloads the page.
      start();
    } catch {
      detach();
    }
  }

  // Add ?debug to the URL to see the player's internal state on the page. The
  // useful case is a machine where playback misbehaves but the server is fine.
  if (/[?&]debug\b/.test(location.search)) {
    const panel = document.createElement('pre');
    panel.style.cssText = 'position:fixed;left:0;bottom:0;z-index:99;margin:0;'
      + 'padding:.5rem;background:#000;color:#0f0;font:12px/1.5 monospace;';
    document.body.appendChild(panel);
    const errors = [];
    window.addEventListener('error', (e) => errors.push(e.message), true);
    const render = () => {
      panel.textContent = [
        `attached=${attached} playing=${playing} session=${session}`,
        `paused=${video.paused} readyState=${video.readyState}`
        + ` videoWidth=${video.videoWidth} currentTime=${video.currentTime.toFixed(1)}`,
        `hlsjs=${typeof window.Hls} instance=${!!hls} nativeHls=${nativeHls}`,
        `errors=${errors.slice(-3).join(' | ') || 'none'}`,
      ].join('\n');
    };
    render();
    setInterval(render, 500);
  }

  poll();
  setInterval(poll, POLL_MS);
})();
