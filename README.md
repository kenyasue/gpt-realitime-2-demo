# Voice Playground · gpt-realtime-2 demo

A minimal demo for OpenAI's `gpt-realtime-2` (GA Realtime API) with two modes side-by-side:

- **Home tab** — browser ↔ OpenAI direct WebRTC. One click to talk.
- **Twilio tab** — same personas/voices over a real phone call via Twilio Media Streams + a small Node bridge. See [`doc/TWILIO_SETUP.md`](./doc/TWILIO_SETUP.md).

> **Status:** Home tab end-to-end verified against the live model. See [`doc/TESTING.md`](./doc/TESTING.md) for the proofs.

## Features

- **One-click voice conversation** — direct browser ↔ OpenAI WebRTC peer connection, no audio relay server.
- **Twilio phone-call mode** — outbound call to any E.164 number; Twilio Media Stream and OpenAI Realtime exchange G.711 μ-law at 8 kHz through a Fastify bridge. Live transcript streamed back to the browser via SSE.
- **5 personas + 10 voices** — Friendly Assistant · Language Tutor · Interview Coach · Storyteller · **Survey · Croatian (5 questions)** — the Survey persona has the AI greet first and walks the user through a 5-question onboarding flow **in Croatian** (`language: "hr"` passed to Whisper for input transcription), refusing to end until all 5 are answered.
- **Live two-column transcript** — streams as `response.output_audio_transcript.delta` events arrive.
- **Push-to-talk OR auto-VAD** — toggle on the fly via `session.update` (Home tab only).
- **Barge-in / interruption** — talk over the assistant; the truncated turn gets a red `interrupted` marker.
- **Persona / voice change restarts the session** — the GA Realtime API doesn't allow voice swaps mid-session, so any dropdown change tears down the current connection, clears the transcript, and starts a fresh handshake automatically. Mode toggle (Auto-VAD ↔ Push-to-talk) still uses live `session.update` and stays connected.
- **5-minute session cap** with timer + secret-free server-side token mint.

## Stack

- **Next.js 15.5** (App Router) — frontend + token-mint API route in one project
- **React 19** + **TypeScript 5.7**
- **Plain CSS Modules** — no Tailwind
- **Raw `RTCPeerConnection`** against OpenAI's GA `/v1/realtime/calls` SDP endpoint
- **Playwright** (devDependency only) — used by `scripts/e2e-voice-test.mjs` for headless E2E

## Setup

```bash
npm install
cp .env.example .env.local       # fill in OPENAI_API_KEY (or use the existing .env)
npm run dev                      # Home tab only
```

Open <http://localhost:3000>, click **Start Talking**, grant the mic permission.

For the **Twilio tab**, also fill in the Twilio block in `.env.local`, start an ngrok tunnel,
then run the bridge alongside Next.js:

```bash
npm run dev:all                  # Next.js (3000) + bridge (5050) concurrently
```

Full Twilio walk-through in [`doc/TWILIO_SETUP.md`](./doc/TWILIO_SETUP.md).

### Required env vars

| Var | Required | Default | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | ✅ | — | Server-only; used to mint ephemeral keys (Home tab) and to open the OpenAI WS (Twilio tab). |
| `OPENAI_REALTIME_MODEL` | ⬜ | `gpt-realtime-2` | Override to test a different Realtime model. |
| `TWILIO_ACCOUNT_SID` | Twilio tab | — | From console.twilio.com. |
| `TWILIO_AUTH_TOKEN` | Twilio tab | — | From console.twilio.com. |
| `TWILIO_FROM_NUMBER` | Twilio tab | — | A voice-capable Twilio number you own (E.164). |
| `PUBLIC_BRIDGE_URL` | Twilio tab | — | Publicly reachable HTTPS URL of the bridge (ngrok). |
| `BRIDGE_PORT` | ⬜ | `5050` | Bridge HTTP/WS port. |
| `BRIDGE_CORS_ORIGIN` | ⬜ | `http://localhost:3000` | Origin allowed to call the bridge from the browser. |

## Layout

```
app/
  layout.tsx                  # html shell
  page.tsx                    # tab switch (Home / Twilio)
  page.module.css
  globals.css                 # CSS variables, base resets
  api/session/route.ts        # POST → mints GA ephemeral key
  components/
    Header.{tsx,module.css}
    Tabs.{tsx,module.css}          # Home | Twilio tab strip
    WebTab.{tsx,module.css}        # Home tab — WebRTC lifecycle
    TwilioTab.{tsx,module.css}     # Twilio tab — dialer + SSE transcript
    Controls.{tsx,module.css}      # persona / voice / mode strip
    Stage.{tsx,module.css}         # mic orb, status pill, mic meter
    Transcript.{tsx,module.css}    # two-column conversation
bridge/
  server.ts                   # Fastify: TwiML, Media Stream WS, OpenAI WS bridge, SSE
  tsconfig.json
lib/
  personas.ts                 # 5 personas + 10 voices (shared by Next.js + bridge)
  realtime-events.ts          # typed Client/Server events + SessionConfig
  realtime-client.ts          # RTCPeerConnection + DataChannel wrapper
doc/
  PROPOSAL.md
  IMPLEMENTATION_PLAN.md
  TESTING.md                  # proofs + manual + automated test recipes
  TWILIO_SETUP.md             # Twilio + ngrok walk-through
  ui-mockup.html
scripts/
  e2e-voice-test.mjs          # headless Chromium E2E
  make-tts-wav.ps1            # generates fake mic audio for the E2E
```

## Scripts

| Command            | What it does                                |
|--------------------|---------------------------------------------|
| `npm run dev`      | Next.js dev server with HMR (Home tab only) |
| `npm run dev:bridge` | Twilio ↔ OpenAI bridge on port 5050        |
| `npm run dev:all`  | Both processes concurrently                 |
| `npm run build`    | Production build                            |
| `npm run start`    | Run the production build                    |
| `npm run type-check` | `tsc --noEmit`                             |
| `node scripts/e2e-voice-test.mjs` | Headless E2E against the live OpenAI API |

## Notes about the GA Realtime API

Two GA-vs-beta gotchas worth flagging in case you fork this:

1. **Token endpoint:** `POST /v1/realtime/client_secrets` (GA) — not `/v1/realtime/sessions` (beta).
   Request shape is nested: `{ session: { type: "realtime", model, instructions, audio: { output, input } } }`.
   Response shape: `{ value: "ek_…", expires_at, session: { model } }` — NOT `{ client_secret: { value } }`.
2. **SDP endpoint:** `POST /v1/realtime/calls?model=…` (GA) — not `/v1/realtime?model=…` (beta).
   Sending a GA ephemeral key to the beta endpoint returns *"API version mismatch."*.

Both are handled in `app/api/session/route.ts` and `lib/realtime-client.ts`.

## License

MIT
