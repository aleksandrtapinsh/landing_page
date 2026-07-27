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

**MongoDB is required** — accounts, chat history, and sessions live in it.
`server.js` refuses to start if it can't connect. It defaults to
`mongodb://127.0.0.1:27017` and creates its database (`sasha_site`) and indexes
on first run; nothing needs to be created by hand. To point elsewhere, set
`MONGODB_URI` (and optionally `MONGODB_DB`) in `.env`.

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
- **stream** — RTMP ingest on `:1935`

If either exits, the other is shut down too. To run them separately while
debugging, `npm run site` and `npm run stream`.

## OBS

Settings → Stream:

- **Service**: Custom...
- **Server**: `rtmp://sasha-tapinsh.online/live`
- **Stream Key**: the value printed by `npm run stream:key`

Settings → Output:

- **Encoder**: x264 or NVENC — the video must be **H.264**, which is what OBS
  sends by default. Both video and audio are passed through without re-encoding
  (audio must be AAC, the only codec OBS produces), so packaging costs almost no
  server CPU — but it also means AV1/HEVC will not package correctly.
- **Keyframe Interval**: `1` second. This one matters twice over — HLS can
  only cut a segment on a keyframe, so leaving it on `0` (auto) gives ragged
  segment lengths and jumpy playback, and the interval *is* the segment
  length, which is the main latency knob: 1s keyframes ≈ 3-4s behind live,
  2s keyframes ≈ 5-6s. The cost of 1s is slightly worse compression at the
  same bitrate; nudge the bitrate up a little if quality visibly drops.

Then open <https://sasha-tapinsh.online/live.html>. The page polls
`/api/live/status` every 5s and attaches the player when you go live, so you can
leave the tab open before starting the stream.

## Deployment notes

- **Port 1935 must be reachable directly.** It is raw TCP, not HTTP, so it
  cannot go through an HTTP reverse proxy or a Cloudflare-proxied (orange
  cloud) record. Point OBS at a DNS-only record or the server IP, and open 1935
  in the firewall.
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

## Accounts and chat

Viewers can create an account (email + username + password) from the chat
panel's header. Anyone can read chat; posting requires being signed in.

- Passwords are hashed with scrypt (per-user salt); plaintext is never stored.
- Sessions are 30-day HttpOnly cookies; only a hash of the token is stored, and
  MongoDB expires them automatically.
- Chat runs over a WebSocket at `/ws/chat`, keeps the last 50 messages as
  scrollback, and rate-limits posting (burst of 5, then one message per 2
  seconds). Message text is rendered with `textContent`, so HTML in messages is
  inert.
- **The log is wiped once the stream has been offline for 12 hours**, so a new
  broadcast starts on a clean slate. The clock only runs while nothing is
  streaming and restarts after each wipe — a long silence clears the chat every
  12 hours, and a chat during a broadcast is never cut out from under anyone.
  Open tabs are told to clear too, and see "Chat was cleared." The countdown
  lives in MongoDB (`meta`, `_id: "chat"`), so a restart or deploy doesn't hand
  the chat another 12 hours. A 30-day expiry on messages remains as a backstop.
- Usernames are unique case-insensitively; 3–20 chars, letters/numbers/`_`/`-`.
- Signed-in users can pick a name color (click your name in the chat header or
  on one of your own messages): a swatch palette plus a free hex field. The
  choice is stored on the account, so it follows the user across sessions and
  devices. The server validates the hex and rejects colors too light to read on
  the white background. Messages keep the color they were posted with.

## Moderation

Grant or revoke moderator on the server:

```sh
npm run mod -- <username>            # promote
npm run mod -- <username> --remove   # demote
```

Moderators get a **Mod** button in the chat header (and can click any name in
the chat log) opening the roster: everyone signed into chat right now, a count
of anonymous readers, plus any restricted users even if offline — so bans can
be lifted after someone leaves. Per user they can:

- **Timeout** — mute for 1 min to 24 h (API accepts up to a week).
- **Ban** / **Unban** — indefinite, until lifted.

Enforcement is checked against the database on every message, so it applies
immediately to already-open connections; the affected user also gets a notice
in their chat ("You have been timed out for 10 minutes."). Moderators cannot
ban or time out other moderators. Bans only silence chat — they don't block
watching the stream.

## Theater mode

The button in the player's top-right corner (or the `t` key) expands the
player and chat to fill the window; everything else moves below the fold. It
works whether or not anything is streaming — it sits above the offline
placeholder — and the choice is remembered per browser, so it survives a
broadcast ending and is still on at the next visit.

## Viewer count

The badge counts **unique viewers**: signed-in users count once no matter how
many tabs they have open (keyed by account), anonymous viewers count per open
player. Each player sends a heartbeat with its 5-second status poll and is
forgotten 15 seconds after it stops. The status endpoint reports both numbers
(`viewers` unique, `sessions` raw players); the badge shows `viewers`.

Anonymous ids are client-supplied, so the number is still inflatable by anyone
determined to; signing in is what makes a viewer count exactly once.

## Latency

Expect roughly 3–4 seconds glass-to-glass with a 1-second keyframe interval
in OBS, 5–6 with 2 seconds. The player deliberately sits 3s behind the newest
segment (`liveSyncDuration` in `live.js`) so one slow segment fetch doesn't
stall playback; when a stall does push it further behind, it plays 5% fast
until it has caught back up. Lowering `liveSyncDuration` trims latency
further at the cost of rebuffering on shaky connections.

That is the practical floor for plain HLS, the tradeoff for a format that
plays everywhere with no special client. If you ever want sub-second latency,
the ingest server could expose node-media-server's HTTP-FLV output, and
WebRTC would be the step up after that.

## Checking it without OBS

Publish a test pattern:

```sh
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine \
  -c:v libx264 -preset ultrafast -tune zerolatency -g 30 -pix_fmt yuv420p \
  -c:a aac -f flv "rtmp://127.0.0.1:1935/live/$(grep STREAM_KEY .env | cut -d= -f2)"
```

(`-g 30` is a keyframe every second at 30 fps, matching the OBS setting.)

Then `curl localhost:8080/api/live/status` should report `{"live":true,...}`.
