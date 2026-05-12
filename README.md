# Voice Playground · gpt-realtime-2 demo

A minimal WebRTC demo for OpenAI's `gpt-realtime-2` (GA Realtime API). One click to talk, switch personas on the fly, live transcript both ways.

> **Status:** Implemented and end-to-end verified against the live model. See [`doc/TESTING.md`](./doc/TESTING.md) for the proofs.

## Features

- **One-click voice conversation** — direct browser ↔ OpenAI WebRTC peer connection, no audio relay server.
- **5 personas + 10 voices** — Friendly Assistant · Language Tutor · Interview Coach · Storyteller · **Survey · Croatian (5 questions)** — the Survey persona has the AI greet first and walks the user through a 5-question onboarding flow **in Croatian** (`language: "hr"` passed to Whisper for input transcription), refusing to end until all 5 are answered.
- **Live two-column transcript** — streams as `response.output_audio_transcript.delta` events arrive.
- **Push-to-talk OR auto-VAD** — toggle on the fly via `session.update`.
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
npm run dev
```

Open <http://localhost:3000>, click **Start Talking**, grant the mic permission.

### Required env vars

| Var | Required | Default | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | ✅ | — | Server-only; used to mint ephemeral keys. Never reaches the browser. |
| `OPENAI_REALTIME_MODEL` | ⬜ | `gpt-realtime-2` | Override to test a different Realtime model. |

## Layout

```
app/
  layout.tsx                  # html shell
  page.tsx                    # client component: all state + WebRTC lifecycle
  page.module.css
  globals.css                 # CSS variables, base resets
  api/session/route.ts        # POST → mints GA ephemeral key
  components/
    Header.{tsx,module.css}
    Controls.{tsx,module.css}      # persona / voice / mode strip
    Stage.{tsx,module.css}         # mic orb, status pill, mic meter
    Transcript.{tsx,module.css}    # two-column conversation
lib/
  personas.ts                 # 4 personas + 10 voices
  realtime-events.ts          # typed Client/Server events + SessionConfig
  realtime-client.ts          # RTCPeerConnection + DataChannel wrapper
doc/
  PROPOSAL.md
  IMPLEMENTATION_PLAN.md
  TESTING.md                  # proofs + manual + automated test recipes
  ui-mockup.html
scripts/
  e2e-voice-test.mjs          # headless Chromium E2E
  make-tts-wav.ps1            # generates fake mic audio for the E2E
```

## Scripts

| Command            | What it does                                |
|--------------------|---------------------------------------------|
| `npm run dev`      | Next.js dev server with HMR                 |
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
