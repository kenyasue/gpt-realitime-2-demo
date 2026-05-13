# Twilio Tabs — Setup

The **Incoming Call** and **Outgoing Call** tabs demo the same `gpt-realtime-2`
model as the Home tab, but the audio path is a real phone call instead of
WebRTC in the browser.

- **Incoming Call** — the bridge places an outbound Twilio call to a number
  you enter. Your phone rings; you answer and talk.
- **Outgoing Call** — you tap *Prepare to receive*, then dial the bridge's
  Twilio number from your phone. The next inbound call is matched to the
  pending session (FIFO).

```
Incoming Call (server dials you):
┌──────────┐    POST /api/call    ┌─────────────┐   Twilio REST   ┌────────┐
│ Browser  │ ───────────────────► │   Bridge    │ ──────────────► │ Twilio │
│(Incoming)│ ◄─────── SSE ─────── │ (Fastify)   │ ◄── Media WS ── │  PSTN  │
└──────────┘   /events/<id>       │  port 5050  │                 └────────┘
                                  └──────┬──────┘
                                         │ OpenAI Realtime WS
                                         ▼
                                  ┌──────────────┐
                                  │ gpt-realtime │
                                  │      -2      │
                                  └──────────────┘

Outgoing Call (you dial Twilio):
┌──────────┐ POST /api/incoming/prepare ┌─────────────┐
│ Browser  │ ─────────────────────────► │   Bridge    │
│(Outgoing)│ ◄────────── SSE ────────── │             │
└──────────┘                            │             │
                                        │             │
┌────────┐  ── webhook /twiml-incoming ►│             │
│ Twilio │  ◄────── Media WS ───────────│             │
│ (your  │                              └─────────────┘
│ number)│ ◄──── PSTN ──── ☎ your phone
└────────┘
```

Twilio's Media Stream protocol and OpenAI's Realtime protocol are different
WebSocket shapes, so the bridge always sits in the middle and translates
between them. Both sides agree on **G.711 μ-law @ 8 kHz**, so no resampling
is needed — the bridge just forwards base64 payloads.

## Prerequisites

1. **Twilio account** with a voice-capable phone number. The free trial works
   for outbound calls to **verified** caller IDs only.
2. **ngrok** (or any HTTPS tunnel). Twilio needs a public URL to fetch TwiML
   from and to open the Media Stream WebSocket.

## One-time setup

### 1. Install dependencies

```powershell
npm install
```

### 2. Fill in `.env.local`

Copy `.env.example` to `.env.local` and add:

```dotenv
OPENAI_API_KEY=sk-...
OPENAI_REALTIME_MODEL=gpt-realtime-2

TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+1...        # a Twilio number you own (E.164)

BRIDGE_PORT=5050
PUBLIC_BRIDGE_URL=https://<your-tunnel>.ngrok-free.app
BRIDGE_CORS_ORIGIN=http://localhost:3000

# Tell the browser where to reach the bridge. Must match BRIDGE_PORT.
NEXT_PUBLIC_BRIDGE_URL=http://localhost:5050
```

> If you change `BRIDGE_PORT` (e.g. to 5051 because 5050 is busy), update
> **both** `PUBLIC_BRIDGE_URL` (the ngrok tunnel) **and** `NEXT_PUBLIC_BRIDGE_URL`
> (the browser-side URL), then restart `npm run dev` so Next.js re-inlines the
> new `NEXT_PUBLIC_*` value.

Account SID + Auth Token are on the Twilio Console dashboard.
`TWILIO_FROM_NUMBER` must be a number listed under Phone Numbers → Manage → Active Numbers.

### 3. Start the tunnel

```powershell
ngrok http 5050
```

Copy the `https://...ngrok-free.app` URL it prints and paste it into
`PUBLIC_BRIDGE_URL` in `.env.local`. **Restart the bridge** any time this URL
changes (ngrok free URLs change on every restart).

### 4. Configure your Twilio number for inbound calls (Outgoing Call tab only)

The **Incoming Call** tab works as soon as the bridge can reach Twilio's REST
API. The **Outgoing Call** tab additionally needs Twilio to know where to send
inbound calls.

In the Twilio Console:

1. **Phone Numbers → Manage → Active Numbers** → click your number.
2. Under **Voice Configuration → A call comes in**, set the webhook to:

   ```
   <PUBLIC_BRIDGE_URL>/twiml-incoming
   ```

   e.g. `https://abc123.ngrok-free.app/twiml-incoming`. HTTP method: `POST`.
3. Save.

If no session is waiting when an inbound call arrives, the bridge plays a
short voice message and hangs up — open the demo and tap **Prepare to receive**
first.

## Run

Two processes — Next.js (UI + WebRTC tab) and the bridge (Twilio tab).

```powershell
# In one terminal
npm run dev          # Next.js on http://localhost:3000

# In another terminal
npm run dev:bridge   # Bridge on http://localhost:5050
```

Or both at once:

```powershell
npm run dev:all
```

Open <http://localhost:3000>:

- **Incoming Call** tab — enter your phone in E.164 (e.g. `+385...`), pick a
  persona, and tap **Call**. Your phone will ring; answer it and talk.
- **Outgoing Call** tab — pick a persona, tap **Prepare to receive**, then
  call the displayed Twilio number from your phone within 5 minutes.

## Troubleshooting

- **"Cannot reach bridge"** — start `npm run dev:bridge`. Check it logs
  `[bridge] listening on http://localhost:5050`.
- **Call rings but immediately drops** — likely the TwiML URL isn't reachable.
  `curl $PUBLIC_BRIDGE_URL/` from outside your network. If it 404s, the
  tunnel is pointing at the wrong port or the bridge isn't running.
- **Call connects but only silence** — the Media Stream WebSocket didn't open.
  Look in the bridge logs for `media-stream opened for session <id>`. If
  missing, `PUBLIC_BRIDGE_URL` is probably `http://` instead of `https://`,
  or the tunnel doesn't support WebSocket upgrades.
- **`twilio_dial_failed: The number ... is unverified`** — Twilio trial
  accounts can only call verified numbers. Add the destination at
  Phone Numbers → Verified Caller IDs in the Twilio Console.
- **Croatian survey persona doesn't start speaking** — the bridge waits for
  Twilio's `start` event before sending `response.create`. If you hear silence
  for the first few seconds, that's the WebSocket handshake; it should kick in
  within ~1 second.

## Call recordings & history

Every call is recorded on the bridge as a single time-mixed audio file and
exposed in the **History** panel of the Incoming/Outgoing Call tabs. For each
session you get:

- `mixed.wav` — caller + assistant summed onto one timeline (PCM16 mono @ 8 kHz)
- `transcript.json` — the same turns you saw live in the transcript panel
- `meta.json` — start/end times, persona, voice, end reason, audio bytes

Files are written to `${RECORDINGS_DIR}/<sessionId>/…` when the call ends.
`RECORDINGS_DIR` defaults to `./recordings` (relative to the bridge process's
working directory) and can be overridden in `.env.local`.

Endpoints (served by the bridge on the same port as everything else):

| Method | Path                                          | Purpose                                            |
|--------|-----------------------------------------------|----------------------------------------------------|
| GET    | `/api/sessions`                               | List all recorded sessions                         |
| GET    | `/api/sessions/:id`                           | One session's transcript + meta                    |
| GET    | `/api/sessions/:id/audio`                     | Inline `audio/wav` (mixed)                         |
| GET    | `/api/sessions/:id/audio?download=1`          | Same but forces `Content-Disposition: attachment`  |
| DELETE | `/api/sessions/:id`                           | Remove a recording + transcript                    |

These endpoints have **no authentication** — they're open just like the SSE
and WebSocket endpoints. Don't expose the bridge to the public internet if the
recordings are sensitive.

## What gets sent where

| Event                                            | Direction          | Purpose                       |
|--------------------------------------------------|--------------------|-------------------------------|
| Twilio `media` (base64 μ-law)                    | Phone → Bridge     | Caller's voice                |
| OpenAI `input_audio_buffer.append`               | Bridge → OpenAI    | Same audio, forwarded         |
| OpenAI `response.audio.delta` (base64 μ-law)     | OpenAI → Bridge    | Assistant's voice             |
| Twilio `media` outbound                          | Bridge → Phone     | Same audio, forwarded         |
| OpenAI `conversation.item.input_audio_transcription.completed` | OpenAI → Bridge → Browser (SSE) | Caller transcript |
| OpenAI `response.audio_transcript.delta`         | OpenAI → Bridge → Browser (SSE) | Live assistant text   |
