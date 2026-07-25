# Streaming

OBS pushes RTMP to `stream-server.js`, which verifies the stream key and runs
ffmpeg to repackage the feed into HLS under `hls/`. `server.js` serves those
segments, and `live.html` plays them.

```
OBS --RTMP:1935--> stream-server.js --> ffmpeg --> hls/*.ts + index.m3u8
                                                        |
                              browser <--HTTP:8080-- server.js (/live.html)
```

The stream key only ever appears in the RTMP URL. The public playback path is
always `/hls/index.m3u8`, so the key is never exposed to viewers.

## Setup

**ffmpeg is required** — it does the RTMP-to-HLS packaging. Without it the RTMP
handshake still succeeds, so OBS shows no error while the site sits on "Offline"
forever. `stream-server.js` refuses to start if it is missing.

```sh
sudo apt install ffmpeg   # Debian/Ubuntu
npm install
npm run stream:key        # writes STREAM_KEY to .env and prints the OBS settings
```

`node_modules/` and `.env` are both gitignored, so a fresh deploy needs
`npm install` and its own `npm run stream:key` — the key does not travel with
the repo. To rotate it later: `npm run stream:key -- --force`.

## Running

```sh
npm start
```

That runs both halves and prefixes their output:

- **site** — static site, HLS, and `/api/live/status` on `:8080`
- **stream** — RTMP ingest on `:1935`, HTTP-FLV on `:8000`

If either exits, the other is shut down too. To run them separately while
debugging, `npm run site` and `npm run stream`.

## OBS

Settings → Stream:

- **Service**: Custom...
- **Server**: `rtmp://sasha-tapinsh.online/live`
- **Stream Key**: the value printed by `npm run stream:key`

Settings → Output:

- **Encoder**: x264 or NVENC — the video must be **H.264**, which is what OBS
  sends by default. It is passed through without re-encoding, so anything else
  (AV1, HEVC) will not package correctly.
- **Keyframe Interval**: `2` seconds. This one matters — HLS can only cut a
  segment on a keyframe, so leaving it on `0` (auto) gives ragged segment
  lengths and jumpy playback.

Then open <https://sasha-tapinsh.online/live.html>. The page polls
`/api/live/status` every 5s and attaches the player when you go live, so you can
leave the tab open before starting the stream.

## Deployment notes

- **Port 1935 must be reachable directly.** It is raw TCP, not HTTP, so it
  cannot go through an HTTP reverse proxy or a Cloudflare-proxied (orange
  cloud) record. Point OBS at a DNS-only record or the server IP, and open 1935
  in the firewall.
- **Port 8000 does not need to be public.** node-media-server exposes HTTP-FLV
  there; playback works fine without it. Leaving it closed is the safe default.
- Only `:8080` needs to be behind the existing reverse proxy, exactly as it is
  today — HLS is plain static files on the same origin.

One systemd unit, if you want it running unattended (adjust the paths and user
to match the server):

```ini
# /etc/systemd/system/website.service
[Unit]
After=network.target

[Service]
WorkingDirectory=/srv/website
ExecStart=/usr/bin/node start.js
Restart=always
User=sasha

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now website
journalctl -u website -f    # both halves log here
```

## Viewer count

The badge shows how many players are currently watching. Each open player sends
a random per-page-load id with its 5-second status poll, and the server forgets
anyone it has not heard from for 15 seconds.

That means it counts **open players, not people**: two tabs are two viewers, and
a viewer who closes the tab disappears within about 15 seconds rather than
instantly. Nothing about anyone is stored or persisted — the ids live in memory
and are gone on restart. Someone with the page open while the stream is offline,
or who has the player paused, is not counted.

Since the ids are client-supplied, the number is trivially inflatable by anyone
who wants to; it is a display, not a metric to trust.

## Latency

Expect roughly 6–10 seconds glass-to-glass: HLS buffers a few 2-second
segments. That is the tradeoff for a format that plays everywhere with no
special client. Shorter `-hls_time` in `stream-server.js` trims it a little at
the cost of stability. If you ever want sub-second latency, the ingest server
already speaks HTTP-FLV on `:8000` and WebRTC would be the next step up.

## Checking it without OBS

Publish a test pattern:

```sh
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine \
  -c:v libx264 -preset ultrafast -tune zerolatency -g 60 -pix_fmt yuv420p \
  -c:a aac -f flv "rtmp://127.0.0.1:1935/live/$(grep STREAM_KEY .env | cut -d= -f2)"
```

Then `curl localhost:8080/api/live/status` should report `{"live":true,...}`.
