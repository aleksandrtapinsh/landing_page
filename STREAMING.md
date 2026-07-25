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

```sh
npm install
npm run stream:key    # writes STREAM_KEY to .env and prints the OBS settings
```

`.env` is gitignored. To rotate the key later: `npm run stream:key -- --force`.

## Running

Two processes:

```sh
npm start      # static site + HLS on :8080
npm run stream # RTMP ingest on :1935, HTTP-FLV on :8000
```

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

Two systemd units, if you want it running unattended:

```ini
# /etc/systemd/system/website.service
[Unit]
After=network.target

[Service]
WorkingDirectory=/home/diemoirai/Documents/website
ExecStart=/usr/bin/node server.js
Restart=always
User=diemoirai

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/website-stream.service
[Unit]
After=network.target

[Service]
WorkingDirectory=/home/diemoirai/Documents/website
ExecStart=/usr/bin/node stream-server.js
Restart=always
User=diemoirai

[Install]
WantedBy=multi-user.target
```

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
