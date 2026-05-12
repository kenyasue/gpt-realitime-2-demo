# Implementation Plan — Voice Playground

**Companion to:** [`PROPOSAL.md`](./PROPOSAL.md), [`ui-mockup.html`](./ui-mockup.html), [`TESTING.md`](./TESTING.md)
**Status:** ✅ Implemented and end-to-end verified against the live `gpt-realtime-2` GA API
**Last updated:** 2026-05-12

## Completion status

All 8 milestones below have shipped. The headless E2E test in `scripts/e2e-voice-test.mjs` produces the proofs documented in [`TESTING.md`](./TESTING.md).

| # | Milestone | Status |
|---|-----------|--------|
| 1 | Persona presets + UI shell | ✅ |
| 2 | Token-mint API route (GA endpoint `/v1/realtime/client_secrets`) | ✅ |
| 3 | WebRTC handshake (GA endpoint `/v1/realtime/calls`) | ✅ |
| 4 | Typed DataChannel events | ✅ |
| 5 | Live transcript UI (handles `response.output_audio_transcript.*` GA names) | ✅ |
| 6 | Persona/voice switching mid-session via `session.update` | ✅ |
| 7 | Push-to-talk + interruption indicator | ✅ |
| 8 | Mic meter, session timer, 5-min cap, error states | ✅ |

### Deviations from the original plan

- Used the **GA** `/v1/realtime/client_secrets` + `/v1/realtime/calls` endpoints. The original plan referenced the beta `/v1/realtime/sessions` + `/v1/realtime` URLs. `gpt-realtime-2` is GA-only, so the beta endpoints return *"API version mismatch."* — the route was rewritten to the GA shape (see [`README.md`](../README.md) for both gotchas).
- Session config moved `turn_detection` under `audio.input` (GA shape) instead of top-level (beta shape).
- Token-mint response is unwrapped on the server side: the client sees `{ ephemeralKey, model, expiresAt }` instead of OpenAI's raw `{ value, session: { model } }` shape, so the GA/beta change is invisible to the page.

---

---

## 0. What's already done

The repository is scaffolded with a minimal, working Next.js 15 project:

```
package.json              next@15.5.18, react@19, typescript@5.7
tsconfig.json             strict, bundler resolution, "@/*" path alias
next.config.ts            reactStrictMode: true
next-env.d.ts             auto-generated
.env.example              OPENAI_API_KEY, OPENAI_REALTIME_MODEL
app/
  layout.tsx              <html><body> shell + global metadata
  page.tsx                placeholder landing page (gradient title)
  page.module.css         placeholder styles
  globals.css             dark-theme CSS variables + base resets
```

Verified locally:

- `npm install` → 57 packages, no warnings worth fixing
- `npm run type-check` → clean
- `npm run build` → succeeds, `/` is statically pre-rendered

No WebRTC code, no API route, no components beyond the placeholder. **Everything below is the work to do, not work already done.**

---

## 1. Implementation order (8 milestones)

Each milestone is a self-contained slice that ends in a working app. Build them in order — don't skip ahead.

| # | Milestone | Output you can demo |
|---|-----------|---------------------|
| 1 | Persona presets + UI shell (no audio) | Layout matches `ui-mockup.html`, persona/voice dropdowns work, all state is local |
| 2 | Token-mint API route | `curl -XPOST /api/session` returns an ephemeral key |
| 3 | WebRTC handshake | Click → mic permission → audio plays back from the model |
| 4 | DataChannel event plumbing | Console logs every Realtime event; typed message handler |
| 5 | Live transcript UI | Two-column transcript streams in real time |
| 6 | Persona switching mid-session | Dropdown change sends `session.update`, no reconnect |
| 7 | Push-to-talk + interruption indicator | Spacebar mode + red "interrupted" marker on barge-in |
| 8 | Polish + deploy | Mic meter, session timer, hard cap, README + Vercel deploy |

Estimated total: ~4.5 days as in the proposal. Each milestone is ~half a day except #3 (~1 day) and #4–5 (~1 day combined).

---

## 2. Milestone 1 — Persona presets + UI shell

**Goal:** render the dark-theme UI from `doc/ui-mockup.html` as real React components. No network, no audio.

### Files to create

```
lib/
  personas.ts                       # 4 preset configs (typed)
app/
  page.tsx                          # rewrite as client component
  page.module.css                   # full page layout
  components/
    Header.tsx + Header.module.css
    PersonaPicker.tsx + .module.css
    VoicePicker.tsx + .module.css
    ModeToggle.tsx + .module.css    # Auto-VAD / Push-to-talk
    Stage.tsx + .module.css         # mic orb + status pill + meter
    Transcript.tsx + .module.css    # two-column conversation
```

### `lib/personas.ts` shape

```ts
export type VoiceId = "cedar" | "marin" | "alloy" | "verse";

export interface Persona {
  id: "assistant" | "tutor" | "interviewer" | "storyteller";
  label: string;
  instructions: string;       // sent as session.instructions
  defaultVoice: VoiceId;
}

export const PERSONAS: Persona[];
export const VOICES: { id: VoiceId; label: string }[];
```

### State shape

A single `useState` object on `app/page.tsx`:

```ts
type UiState = {
  persona: Persona;
  voice: VoiceId;
  mode: "vad" | "ptt";
  session: "idle" | "connecting" | "live" | "ending" | "error";
  errorMessage?: string;
};
```

### Definition of done

- Page renders 1:1 with `ui-mockup.html`
- Mic button is just a stub (`onClick` toggles `session` between `"idle"` and `"live"` for visual testing)
- Persona dropdown changes the displayed voice via the persona's `defaultVoice`
- `npm run build` still passes

---

## 3. Milestone 2 — Token-mint API route

**Goal:** server-side endpoint that exchanges the long-lived `OPENAI_API_KEY` for a short-lived **ephemeral key** for the browser. The browser must never see the long key.

### File

```
app/api/session/route.ts
```

### Behavior

`POST /api/session` with optional JSON body `{ voice?: VoiceId, instructions?: string }`:

1. Read `OPENAI_API_KEY` and `OPENAI_REALTIME_MODEL` from `process.env`
2. POST to `https://api.openai.com/v1/realtime/sessions` with that key
3. Body: `{ model, voice, instructions, modalities: ["audio", "text"], input_audio_transcription: { model: "whisper-1" } }`
4. Return the upstream JSON to the client unchanged

### Hardening

- **`runtime = "nodejs"`** (not edge) — keep the secret with normal env semantics
- **`dynamic = "force-dynamic"`** — never cache
- Reject anything other than POST
- If `OPENAI_API_KEY` is missing, return 500 with a clear message — don't leak `process.env`
- Wrap the upstream call in `try/catch`; on non-2xx, return `{ error: "upstream", status, message }` (don't forward upstream error verbatim)

### Definition of done

```bash
curl -s -XPOST http://localhost:3000/api/session \
  -H 'content-type: application/json' \
  -d '{"voice":"cedar"}' | jq .client_secret.value
```

returns an `ek_…` string.

---

## 4. Milestone 3 — WebRTC handshake

**Goal:** click the mic button, browser captures the microphone, negotiates a WebRTC peer connection with OpenAI, and audio from the model plays back.

### File

```
lib/realtime-client.ts
```

### Public API

```ts
export interface RealtimeClient {
  connect(opts: { ephemeralKey: string; model: string }): Promise<void>;
  disconnect(): Promise<void>;
  send(event: ClientEvent): void;            // for milestone 6
  on(handler: (e: ServerEvent) => void): () => void;
}

export function createRealtimeClient(): RealtimeClient;
```

### Steps inside `connect()`

1. `pc = new RTCPeerConnection()`
2. `pc.ontrack = (e) => audioEl.srcObject = e.streams[0]` — wire to a hidden `<audio autoplay>` element on the page
3. `dc = pc.createDataChannel("oai-events")` — milestone 4 uses it
4. `stream = await navigator.mediaDevices.getUserMedia({ audio: true })`
5. `stream.getTracks().forEach(t => pc.addTrack(t, stream))`
6. `offer = await pc.createOffer(); await pc.setLocalDescription(offer)`
7. `POST https://api.openai.com/v1/realtime?model=<model>` with `Authorization: Bearer <ephemeralKey>`, body = `offer.sdp`, content-type `application/sdp`
8. `answer = { type: "answer", sdp: await res.text() }; await pc.setRemoteDescription(answer)`

### Hooking up to UI

In `app/page.tsx`:

- On mic-button click while `session === "idle"`:
  1. `setSession("connecting")`
  2. `const { client_secret, model } = await fetch("/api/session", { method: "POST", ... }).then(r => r.json())`
  3. `await client.connect({ ephemeralKey: client_secret.value, model })`
  4. `setSession("live")`
- On click while `live`: `await client.disconnect(); setSession("idle")`

### Definition of done

- Click → grant mic → hear the model say something within ~2s
- Click again → silence, mic LED off in OS chrome
- No `OPENAI_API_KEY` in browser devtools network tab

---

## 5. Milestone 4 — DataChannel events (typed)

**Goal:** every event the server sends is parsed and dispatched to a typed handler. Foundation for transcript, interruption, and persona switching.

### File

```
lib/realtime-events.ts
```

### Minimum event types

Enough for v1; full Realtime event surface is much larger.

```ts
export type ServerEvent =
  | { type: "session.created"; session: { id: string } }
  | { type: "session.updated" }
  | { type: "input_audio_buffer.speech_started" }
  | { type: "input_audio_buffer.speech_stopped" }
  | { type: "conversation.item.input_audio_transcription.completed"; transcript: string; item_id: string }
  | { type: "response.created"; response: { id: string } }
  | { type: "response.audio_transcript.delta"; delta: string; response_id: string }
  | { type: "response.audio_transcript.done"; transcript: string; response_id: string }
  | { type: "response.done" }
  | { type: "error"; error: { type: string; message: string } };

export type ClientEvent =
  | { type: "session.update"; session: Partial<SessionConfig> }
  | { type: "response.cancel" };
```

### Wiring

In `realtime-client.ts`:

```ts
dc.onmessage = (e) => {
  const event = JSON.parse(e.data) as ServerEvent;
  handlers.forEach((h) => h(event));
};
```

### Definition of done

- DevTools console shows a clean stream of typed events as you speak
- `error` events are surfaced as a red toast in the UI (state field already exists from M1)

---

## 6. Milestone 5 — Live transcript

**Goal:** the two-column transcript in the mockup, fed by the events from M4.

### Reducer state

```ts
type Turn =
  | { id: string; role: "user"; text: string; final: boolean }
  | { id: string; role: "assistant"; text: string; final: boolean; interrupted?: boolean };

type TranscriptState = { turns: Turn[] };
```

### Event → state rules

| Event | Action |
|---|---|
| `input_audio_buffer.speech_started` | Append new user turn `{ id, text: "", final: false }` |
| `conversation.item.input_audio_transcription.completed` | Replace matching user turn's text, set `final: true` |
| `response.created` | Append new assistant turn `{ id, text: "", final: false }` |
| `response.audio_transcript.delta` | Append `delta` to matching assistant turn's text |
| `response.audio_transcript.done` | Set assistant turn `final: true` |

### UI

`<Transcript turns={turns} />` reuses the styles from `ui-mockup.html`. Streaming assistant turns get the blinking caret (`final: false`).

### Definition of done

- Both sides of the conversation appear within ~300ms of being spoken
- Copy button copies the full transcript as plain text
- Auto-scrolls to bottom on new turn (`useEffect` + `ref.scrollIntoView({ block: "end" })`)

---

## 7. Milestone 6 — Persona switching mid-session

**Goal:** changing the dropdown updates the active conversation without reconnecting WebRTC.

### Behavior

When `persona` or `voice` changes **while `session === "live"`**:

```ts
client.send({
  type: "session.update",
  session: {
    voice: nextVoice,
    instructions: nextPersona.instructions,
  },
});
```

When changed while idle: no-op (the next `/api/session` call uses the new values).

### Edge cases to handle

- Voice can only be changed before the first audio response — note this in the persona-picker UI and disable the voice dropdown after the first `response.created` event of a session.
- Instructions can change anytime — they take effect on the next turn.

### Definition of done

- Switch persona → next response uses the new persona's tone
- Switch voice while disabled → tooltip explains why; switching is only possible at the start of a session

---

## 8. Milestone 7 — Push-to-talk + interruption

### Push-to-talk

In `mode === "ptt"`:

- Disable server VAD via `session.update` with `turn_detection: null`
- Hold `Space` (or hold the mic orb): send `input_audio_buffer.commit` on release, then `response.create`
- Release `Space` after a short utterance → reply starts

### Interruption indicator

When `input_audio_buffer.speech_started` fires **while there is an active assistant turn with `final === false`**:

- Mark that assistant turn `interrupted: true`
- Optionally: `client.send({ type: "response.cancel" })` to stop the model immediately

### Definition of done

- In VAD mode, talk over the model → it stops within ~300ms, red marker appears on its truncated turn
- In PTT mode, holding Space is the only way to send audio

---

## 9. Milestone 8 — Polish + deploy

- **Mic level meter** — `AudioContext` + `AnalyserNode` on the local audio track, drive the 10 bars in `Stage.tsx`
- **Session timer** — `00:42` in the status pill, `setInterval` started on `session.created`
- **Hard cap** — 5-minute auto-disconnect with a non-blocking toast 30s before
- **Cost / privacy notice** — small footer line: "Audio is streamed directly to OpenAI. Not stored by this app."
- **Error states** — mic permission denied, no `OPENAI_API_KEY`, upstream 4xx/5xx all render in `errorMessage`
- **README** — replace boilerplate notes with screenshots + a 60s GIF
- **Deploy** — push to GitHub, import into Vercel, set `OPENAI_API_KEY` + `OPENAI_REALTIME_MODEL` env vars

---

## 10. Cross-cutting concerns

### Secrets

- The only place `OPENAI_API_KEY` may appear is `app/api/session/route.ts` (server-only). Never expose to a client component, never include `NEXT_PUBLIC_` in its name.
- A lint sanity check: `grep -R "process.env.OPENAI_API_KEY" app/ lib/ components/ | grep -v "api/session"` should be empty.

### Browser support

- Target: latest Chrome, Edge, Safari on macOS, Safari on iOS 17+
- iOS Safari quirk: `getUserMedia` requires the page to be in response to a user gesture — keep the connection logic inside the button's onClick handler, not a `useEffect`.
- Autoplay: the `<audio>` element receiving the model output should have `autoplay` and `playsInline`. Set `srcObject` only after the user has clicked.

### TypeScript

- All Realtime event types live in `lib/realtime-events.ts`. Adding a new event type that the runtime might emit but we don't yet handle is fine — `dc.onmessage` should `JSON.parse` and forward; handlers do exhaustive `switch` with `default: /* ignore */`.

### Testing

- v1 has no automated tests. Manual checklist (matches success criteria from `PROPOSAL.md` §10):
  1. Cold load → talking within 10s on home wifi
  2. Interrupt the assistant → stops in < 300ms
  3. Persona switch → audible tone change next turn
  4. Live transcript visible for both sides

If v2 happens, add Playwright happy-path that mocks `/api/session` and uses a fake `MediaStream`.

### Cost guardrail

Open question from the proposal — for the public deploy, the 5-minute auto-disconnect in M8 plus rate-limiting `/api/session` (e.g., 10 sessions / IP / hour via an in-memory `Map` or Vercel KV) is enough for a demo. Anything more belongs in v2.

---

## 11. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| OpenAI Realtime API SDP endpoint or event names change | M | Pin model id via env; centralize event types in `lib/realtime-events.ts` |
| Ephemeral token endpoint shape changes | M | Same — one fetch in one file |
| iOS Safari autoplay/microphone gesture rules | M | Connection logic stays inside button handler; no auto-connect |
| Public demo abuse (long sessions, scripted bots) | H | 5-min cap + IP rate limit on `/api/session` (M8) |
| `gpt-realtime-2` model id not available on the account | M | Surface upstream 400 verbatim in `errorMessage` so it's diagnosable |

---

## 12. When to revisit the proposal

Open these `PROPOSAL.md §9` questions **before starting M8**, not at the end:

- Cost guardrail concrete numbers (5-min cap, sessions/IP/hour)
- Region (default `auto` unless data says otherwise)
- Telemetry (in or out — keep it out unless there's a real reason)
- Final name ("Voice Playground" or something else)

If any of these change the demo's surface area, update `PROPOSAL.md` in the same PR.
