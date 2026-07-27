// Shared live player. Polls /api/live/status and attaches the HLS stream when
// something is publishing, otherwise shows the offline placeholder. Used by the
// homepage and the standalone /live.html page.

(function () {
  const PLAYLIST = '/hls/index.m3u8';
  const POLL_MS = 5000;

  const video = document.getElementById('player');
  const offline = document.getElementById('offline');
  const badge = document.getElementById('badge');
  const viewerCount = document.getElementById('viewers');
  if (!video || !offline) return;

  // Identifies this player to the server's heartbeat. Per page load, so two
  // tabs count as two viewers, and nothing is persisted about anyone.
  const viewerId = (crypto.randomUUID && crypto.randomUUID())
    || Math.random().toString(36).slice(2) + Date.now().toString(36);

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
      hls = new Hls({
        lowLatencyMode: true,
        backBufferLength: 30,
        // Sit 3 seconds behind the newest segment. The default is three
        // segment-durations (6s with 2s segments) and is most of the
        // glass-to-glass delay; 3s is still enough to ride out one slow fetch.
        liveSyncDuration: 3,
        // Stalls push the play position further behind. Small drift is walked
        // back by playing 5% fast — inaudible — and anything worse than 10s
        // is fixed with one visible jump instead.
        maxLiveSyncPlaybackRate: 1.05,
        liveMaxLatencyDuration: 10,
      });
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

  function showViewers(n) {
    if (!viewerCount) return;
    viewerCount.textContent = n > 0 ? `${n} watching` : '';
  }

  async function poll() {
    try {
      const query = `?id=${encodeURIComponent(viewerId)}&viewing=${attached ? 1 : 0}`;
      const res = await fetch('/api/live/status' + query, { cache: 'no-store' });
      const status = await res.json();
      showViewers(status.viewers);
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
      const wasAttached = attached;
      attach();
      // Backstop: if every event we hooked has come and gone without playback
      // actually beginning, keep nudging it rather than sitting on a blank
      // frame until someone reloads the page.
      start();
      // This poll reported us as not yet watching. Re-run once on the
      // transition so a new viewer sees themselves in the count right away
      // instead of a poll interval later. Cannot recurse: wasAttached is true
      // the second time through.
      if (attached && !wasAttached) poll();
    } catch {
      detach();
    }
  }

  // --- theater mode ---
  // Expands player + chat to fill the viewport; the rest of the page is pushed
  // below the fold, not hidden. Remembered per browser.
  const theaterBtn = document.getElementById('theater');
  if (theaterBtn) {
    const applyTheater = (on) => {
      document.body.classList.toggle('theater', on);
      theaterBtn.setAttribute('aria-pressed', String(on));
      try {
        localStorage.setItem('theater', on ? '1' : '0');
      } catch { /* private browsing */ }
    };
    const toggleTheater = () => applyTheater(!document.body.classList.contains('theater'));

    theaterBtn.addEventListener('click', toggleTheater);
    document.addEventListener('keydown', (event) => {
      if (event.key !== 't' || event.ctrlKey || event.metaKey || event.altKey) return;
      // Never steal the key from someone typing in chat or a form.
      if (/^(input|textarea|select)$/i.test(event.target.tagName)) return;
      toggleTheater();
    });

    // Theater is the viewer's choice, not the stream's: it stays on when a
    // broadcast ends and comes back on the next visit.
    try {
      if (localStorage.getItem('theater') === '1') applyTheater(true);
    } catch { /* private browsing */ }
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
