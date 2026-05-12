# Proposal: Voice Playground — A Simple Demo for `gpt-realtime-2`

**Date:** 2026-05-12
**Author:** Ken Yasue
**Status:** Draft v1
**Target model:** `gpt-realtime-2` (OpenAI)
**Transport:** WebRTC (browser ⇄ OpenAI Realtime API)

---

## 1. Goal

Build the **smallest possible web app** that lets anyone press one button, speak to `gpt-realtime-2` over WebRTC, and immediately feel what the model can do — natural turn-taking, low-latency speech, multiple voices, and on-the-fly persona switching.

> **One-liner:** *"Open the page → click 'Start Talking' → have a real conversation. That's it."*

The demo is intentionally **not** a product. It is a single-page playground that highlights what's new about `gpt-realtime-2` vs. the previous Realtime API.

---

## 2. Why this design

| Driver | Decision |
|---|---|
| User wants to **try** the model, not configure it | One-click start, sensible defaults |
| WebRTC is the recommended transport | Direct browser ⇄ OpenAI peer connection; no audio relay server |
| Showcase what's distinctive about `gpt-realtime-2` | Persona/voice switching, live transcript, interruption handling |
| Keep it cheap to host | Static frontend + one tiny token-mint endpoint |
| Easy to fork and remix | Single page, ~1 file of meaningful code |

---

## 3. Core features (MVP)

### 3.1 One-click voice conversation
- Single **"Start Talking"** button initiates `getUserMedia` + WebRTC handshake with OpenAI.
- **"Stop"** button cleanly tears down the peer connection.
- Visible mic-level indicator so the user knows they are being heard.

### 3.2 Persona picker (4 presets)
Dropdown to switch the system prompt + voice mid-session. Each preset is a one-line instruction.

| Persona | Voice | Vibe |
|---|---|---|
| Friendly Assistant | `cedar` | Default helpful tone |
| Language Tutor (English) | `marin` | Patient, corrects gently |
| Interview Coach | `alloy` | Asks probing questions |
| Storyteller | `verse` | Theatrical, expressive |

Changing persona sends a `session.update` event — no reconnect required.

### 3.3 Live transcript
- Two-column transcript panel: **You** (user transcription) vs. **Assistant** (model response).
- Streams as `response.audio_transcript.delta` / `input_audio_buffer.committed` events arrive.
- "Copy transcript" button.

### 3.4 Interruption / barge-in
- User can speak over the assistant — the model stops talking immediately (built-in VAD turn-detection).
- This is a key showcase moment for `gpt-realtime-2`; surface a small "interrupted" indicator when it happens.

### 3.5 Push-to-talk toggle (optional)
- Default: **server VAD** (always listening).
- Toggle to **manual mode** (hold spacebar to talk) — useful in noisy rooms / demos.

---

## 4. Out of scope (v1)

- Login / accounts
- Conversation history / persistence
- Tool calling / function execution
- Image input
- Multi-user rooms
- Mobile-native UI polish (works on mobile, but not tuned)

These belong in v2 if the demo gets traction.

---

## 5. Architecture

```
┌──────────────────┐   1. POST /api/session    ┌──────────────────────┐
│  Next.js client  │ ────────────────────────► │  Next.js 15 Route    │
│  component       │ ◄──────────────────────── │  Handler             │
│  - getUserMedia  │   2. ephemeral key        │  app/api/session/    │
│  - RTCPeerConn   │                           │  route.ts            │
│  - DataChannel   │                           │  (holds OPENAI_API_  │
│    (events)      │                           │   KEY server-side)   │
└────────┬─────────┘                           └──────────────────────┘
         │
         │  3. SDP offer  (POST to /v1/realtime?model=gpt-realtime-2)
         │  4. SDP answer
         ▼
┌──────────────────────────────────────┐
│   OpenAI Realtime API (WebRTC)       │
│   - audio in/out                     │
│   - events over DataChannel          │
└──────────────────────────────────────┘
```

### Why a token endpoint?
The OpenAI key **must not** ship to the browser. The endpoint mints an **ephemeral session token** (`/v1/realtime/sessions`) that the browser then uses for the WebRTC handshake. This is the same pattern OpenAI's cookbook example uses.

---

## 6. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 15** (App Router, React 19) | Single project for both UI and the token-mint endpoint |
| Language | TypeScript | Type-safe event handling for the Realtime DataChannel |
| Styling | **Plain CSS Modules** (no Tailwind) | One small UI; co-locate styles per component, zero build-time config |
| Backend | Next.js Route Handler at `app/api/session/route.ts` | One endpoint: `POST /api/session` — runs server-side, holds the OpenAI key |
| Hosting | Vercel | First-class Next.js 15 support, env vars, edge runtime if needed |
| Realtime SDK | None — use raw `RTCPeerConnection` + `fetch` | Following OpenAI's WebRTC guide directly keeps the demo educational |

### Project layout

```
gpt-realitime-2-demo/
├── app/
│   ├── layout.tsx
│   ├── page.tsx                 # Voice Playground UI (client component)
│   ├── page.module.css          # Page styles
│   ├── components/
│   │   ├── VoiceButton.tsx
│   │   ├── VoiceButton.module.css
│   │   ├── Transcript.tsx
│   │   ├── Transcript.module.css
│   │   ├── PersonaPicker.tsx
│   │   └── PersonaPicker.module.css
│   └── api/
│       └── session/
│           └── route.ts         # POST → mints ephemeral OpenAI token
├── lib/
│   ├── realtime-client.ts       # RTCPeerConnection + DataChannel wrapper
│   └── personas.ts              # 4 preset persona configs
├── public/
├── .env.local                   # OPENAI_API_KEY (gitignored)
├── next.config.ts
├── tsconfig.json
└── package.json
```

---

## 7. UI sketch

```
┌────────────────────────────────────────────────────────────────┐
│  Voice Playground · gpt-realtime-2                  [GitHub]   │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│   Persona:  [ Friendly Assistant ▼ ]   Voice: cedar            │
│                                                                │
│            ┌──────────────────────────────┐                    │
│            │      ●  Start Talking        │                    │
│            └──────────────────────────────┘                    │
│                                                                │
│   ▰▰▰▱▱▱▱▱▱▱  (mic level)                                       │
│                                                                │
├──────────────────────────────┬─────────────────────────────────┤
│  You                         │  Assistant                      │
│                              │                                 │
│  > Hey, can you help me      │  Of course! What are you        │
│    practice my English       │  working on today?              │
│    interview?                │                                 │
│                              │  ...                            │
└──────────────────────────────┴─────────────────────────────────┘
```

---

## 8. Build plan (rough estimate)

| Step | Description | Estimate |
|---|---|---|
| 1 | Scaffold Next.js 15 app (App Router, no Tailwind), deploy "hello" to Vercel | 0.5 day |
| 2 | Token-mint Route Handler `app/api/session/route.ts` + env wiring | 0.5 day |
| 3 | WebRTC handshake (offer/answer, audio tracks) | 1 day |
| 4 | DataChannel event handling + live transcript UI | 1 day |
| 5 | Persona picker + `session.update` on switch | 0.5 day |
| 6 | Push-to-talk toggle, mic meter, polish | 0.5 day |
| 7 | README + 60-second demo video | 0.5 day |
| **Total** | | **~4.5 days** |

---

## 9. Open questions

1. **Cost guardrail.** A single token has no per-session spend limit on OpenAI's side. Do we add a soft cap (e.g. 5-minute hard cutoff per session) for the public demo?
2. **Region.** Realtime API has region-specific latency. Default to `auto`?
3. **Telemetry.** Anonymous usage counter (sessions started / avg duration) — useful or unnecessary for a demo?
4. **Branding.** "Voice Playground" working title — open to alternatives.

---

## 10. Success criteria

The demo succeeds if a first-time visitor can:

- [ ] Start a conversation in **under 10 seconds** from page load
- [ ] Interrupt the assistant mid-sentence and have it stop **within ~300ms**
- [ ] Switch persona and immediately hear the new voice on the next turn
- [ ] Read a live transcript of both sides of the conversation

If all four work on a flaky cafe wifi, we ship.

---

## Appendix A — References

- Model card: <https://developers.openai.com/api/docs/models/gpt-realtime-2>
- WebRTC guide: <https://developers.openai.com/api/docs/guides/realtime-webrtc>
- Realtime conversations guide: <https://developers.openai.com/api/docs/guides/realtime-conversations>
- Translation demo (reference implementation): <https://github.com/openai/openai-cookbook/tree/main/examples/voice_solutions/realtime_translation_guide/browser-translation-demo>
- DataCamp tutorial: <https://www.datacamp.com/tutorial/gpt-realtime-2-api>
