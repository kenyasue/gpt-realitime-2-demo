# Testing Notes

**Last run:** 2026-05-12
**Status:** ✅ Voice-to-voice + transcripting confirmed against the real `gpt-realtime-2` model

---

## What was verified

A headless Chromium test (`scripts/e2e-voice-test.mjs`) was run against the live OpenAI Realtime GA API using the `.env` key. Every claim below corresponds to an actual event captured during the run — see `.test-artifacts/summary.json` and `.test-artifacts/final.png` for the raw artefacts.

| Proof | Event(s) observed | Confirmed |
|---|---|---|
| Next.js `/api/session` mints a GA ephemeral key | `POST /api/session 200`, body has `ephemeralKey: "ek_..."` | ✅ |
| Browser → OpenAI WebRTC handshake completes | `session.created` received over data channel | ✅ |
| Model produces a spoken response | `response.created` → `response.output_audio.done` → `response.done` | ✅ |
| Assistant transcript streams back | `response.output_audio_transcript.delta` (multiple) + `response.output_audio_transcript.done` | ✅ |
| User audio is transcribed | `conversation.item.input_audio_transcription.completed` | ✅ |
| Transcript renders both roles in the UI | DOM contained one "Assistant" turn (full reply) and one "You" turn | ✅ |
| Push-to-talk mode disables VAD and accepts manual commit | `input_audio_buffer.committed` followed by a model response | ✅ |
| Persona/voice change clears transcript + restarts session | See `e2e-restart-test.mjs` section below — 3 `session.created` events across 2 changes | ✅ |

Full set of unique event types observed during one test run (17 distinct types):

```
session.created
conversation.item.added
conversation.item.done
conversation.item.input_audio_transcription.completed
conversation.item.input_audio_transcription.delta
input_audio_buffer.committed
output_audio_buffer.started
rate_limits.updated
response.content_part.added
response.content_part.done
response.created
response.done
response.output_audio.done
response.output_audio_transcript.delta
response.output_audio_transcript.done
response.output_item.added
response.output_item.done
```

## Survey persona auto-greets

`scripts/e2e-survey-test.mjs` selects the **Survey (5 questions)** persona, starts a session in PTT mode (so no user audio is ever committed), and verifies the assistant speaks first.

| Check | Observed | Confirmed |
|---|---|---|
| Voice flips to `coral` (Survey default) after persona select | `<select Voice>` value = "coral" | ✅ |
| Page sends `language: "hr"` to `/api/session` | POST body intercepted, `body.language === "hr"` | ✅ |
| `response.created` arrives without any user input | event seen on data channel | ✅ |
| `response.output_audio_transcript.done` arrives | event seen on data channel | ✅ |
| Assistant turn appears in transcript DOM | turn text = *"Bok! Ja sam tvoj prijateljski voditelj ankete. Možemo li započeti kratku anketu od pet pitanja?"* | ✅ |
| Greeting is in Croatian | regex match on Croatian-only tokens (`anket`, `možemo`, `bok`, …) | ✅ |
| No user turn was produced | no `conversation.item.input_audio_transcription.completed` event | ✅ |

The auto-start mechanism is generic — any persona with `autoStart: true` in `lib/personas.ts` will trigger the assistant to speak first when a session begins. The trigger fires on the `session.created` event the data channel emits, not on a timer, so it's safe across reconnects.

The language hint is also generic: set `language: "hr"` (or any ISO 639-1 code) on a persona and it's forwarded to Whisper's input transcription via `audio.input.transcription.language`. Confirmed against the upstream API — `POST /v1/realtime/client_secrets` accepts and echoes the field.

```bash
node scripts/e2e-survey-test.mjs
```

## Persona / voice change → fresh session

`scripts/e2e-restart-test.mjs` covers the dropdown-driven restart behavior. Latest run:

| Check | Observed | Confirmed |
|---|---|---|
| Persona change while live → new `session.created` | 2nd `session.created` arrived | ✅ |
| Persona change → transcript cleared | DOM had 0 turn rows after change | ✅ |
| Persona change → voice updated to persona default | `select[Voice]` value flipped to persona's `defaultVoice` (`marin` for tutor) | ✅ |
| Voice change while live → new `session.created` | 3rd `session.created` arrived | ✅ |
| Voice change → transcript cleared | DOM had 0 turn rows after change | ✅ |
| Total `session.created` events across two changes | 3 (initial + 2 restarts) | ✅ |

Run it:

```bash
node scripts/e2e-restart-test.mjs
```

## How the tests work

The browser cannot use the user's real microphone in CI, so the test:

1. Generates a TTS WAV via `System.Speech` (`.test-artifacts/speech.wav` — 48 kHz mono 16-bit, ~5 s of speech + 3 s of trailing silence).
2. Launches headless Chromium with Playwright using `--use-fake-device-for-media-stream` and `--use-file-for-fake-audio-capture=…/speech.wav`. Chromium feeds that WAV as the synthetic microphone, looping.
3. Switches the app to **Push-to-talk** mode (disabling server VAD — Chromium's fake audio doesn't reliably trip VAD energy detection).
4. Clicks **Start Talking** and waits for the data channel `session.created` event.
5. After ~8 s of fake audio capture, manually sends:
   ```json
   { "type": "input_audio_buffer.commit" }
   { "type": "response.create" }
   ```
6. Watches `console.log("[realtime]", event.type)` for the protocol events listed above, and reads the rendered turns from the DOM.
7. Saves `summary.json`, `final.png`, and `console.log` under `.test-artifacts/`.

The test passes when all 5 protocol proofs fire.

## Run it yourself

```bash
# Prereqs: .env with OPENAI_API_KEY, deps installed.
npm install
npx playwright install chromium       # one-time, ~170 MB

# Make sure the TTS WAV exists (regenerate if it doesn't):
#   pwsh -File scripts/make-tts-wav.ps1   # ← script below
# Already present at .test-artifacts/speech.wav after first run.

# In one terminal:
npm run dev

# In another:
node scripts/e2e-voice-test.mjs       # voice loop + transcripts
node scripts/e2e-restart-test.mjs     # persona / voice change → fresh session
node scripts/e2e-survey-test.mjs      # Survey persona auto-greets without user input
```

Optional knobs (env vars):

| Var | Default | Meaning |
|---|---|---|
| `TEST_URL` | `http://localhost:3000` | Where the running app is |
| `RUN_SECONDS` | `35` | Max wait after starting the session before declaring failure |

## What this *doesn't* prove

- **Server-VAD auto-response with fake audio.** Chromium's synthesised microphone doesn't pass the VAD energy gate at the default threshold (0.5). Real human speech on a real device does — manually verified by opening the app in a normal browser tab. The test deliberately uses Push-to-talk to side-step this, since the goal is to verify the *app's* code path, not Chromium's fake-media behaviour.
- **Interruption (barge-in).** Requires concurrent input + assistant audio. Easy to verify manually in a browser; not in scope for this automated run.
- **Persona switching mid-session.** Code path implemented and type-checked; manual smoke recommended.

## Manual test recipe (1 minute)

1. `npm run dev`
2. Open <http://localhost:3000>
3. Click **Start Talking** → grant microphone permission once.
4. Status pill should turn green: `Connected · 00:01` within ~2 s.
5. Say: *"Hi, can you say a short greeting back to me?"*
6. The assistant should reply audibly within ~500 ms of you finishing.
7. Both turns should appear in the transcript panel.
8. Try barge-in: while it's speaking, start talking again — it should stop within ~300 ms and the truncated turn should show the red `interrupted` marker.
9. Switch the persona dropdown — the next turn should clearly use the new tone (e.g. **Storyteller** is theatrical).

If any of those fail, the dev console (`F12`) will print every protocol event prefixed with `[realtime]` plus the underlying error.
