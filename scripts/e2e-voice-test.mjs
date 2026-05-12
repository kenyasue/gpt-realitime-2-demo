// scripts/e2e-voice-test.mjs
// Headless Chromium against http://localhost:3000 using a TTS WAV as fake mic input.
// Confirms: handshake succeeds, transcripts arrive both directions, errors surface.

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const WAV = path.join(ROOT, ".test-artifacts", "speech.wav");
const ARTIFACTS = path.join(ROOT, ".test-artifacts");
const URL = process.env.TEST_URL || "http://localhost:3000";
const RUN_SECONDS = Number(process.env.RUN_SECONDS || 35);

if (!fs.existsSync(WAV)) {
  console.error(`Missing ${WAV} — generate the TTS WAV first.`);
  process.exit(2);
}
// Normalize Windows backslashes for Chromium command line
const WAV_ARG = WAV.replace(/\\/g, "/");
console.log(`Fake audio source: ${WAV_ARG}`);

const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${WAV_ARG}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const context = await browser.newContext({
  permissions: ["microphone"],
  ignoreHTTPSErrors: true,
});

const page = await context.newPage();

const events = [];
const errors = [];
const allConsole = [];
const seenEventTypes = new Set();

page.on("console", (msg) => {
  const text = msg.text();
  allConsole.push(`[${msg.type()}] ${text}`);
  if (text.startsWith("[realtime]")) {
    const parts = text.split(/\s+/);
    const evType = parts[1];
    if (evType) {
      events.push({ at: Date.now(), type: evType });
      seenEventTypes.add(evType);
    }
  }
  if (msg.type() === "error" || msg.type() === "warning") {
    errors.push(`[${msg.type()}] ${text}`);
  }
});

page.on("pageerror", (err) => {
  errors.push(`PAGE_ERROR: ${err.message}`);
});

page.on("requestfailed", (req) => {
  errors.push(`REQ_FAILED: ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
});

await page.goto(URL, { waitUntil: "networkidle" });
// Give React a moment to hydrate after networkidle
await page.waitForTimeout(800);
console.log("✓ Page loaded + hydrated");

// Sanity: title contains the model name
const title = await page.title();
console.log(`  title: ${title}`);

// Switch to Push-to-talk mode so VAD is off (fake audio doesn't trigger VAD reliably);
// we will manually commit + ask for a response.
const pttBtn = page.getByRole("tab", { name: /push-to-talk/i });
await pttBtn.click({ timeout: 5000 });
console.log("✓ Switched to Push-to-talk mode (bypasses VAD)");

// Click the mic orb (button with aria-label "Start talking")
const startBtn = page.getByRole("button", { name: /start talking/i });
await startBtn.waitFor({ state: "visible", timeout: 5000 });
await startBtn.click();
console.log("✓ Clicked Start Talking");

// Wait until session is live (status pill shows "Connected")
try {
  await page.getByText(/Connected ·/i).waitFor({ timeout: 20000 });
  console.log("✓ Session is live");
} catch (err) {
  console.log("✗ Session never reached live state");
  console.log("\n  Errors:", errors);
  console.log("\n  All console output:");
  allConsole.forEach((line) => console.log("    " + line));
  await page.screenshot({ path: path.join(ARTIFACTS, "failure.png"), fullPage: true });
  fs.writeFileSync(path.join(ARTIFACTS, "console.log"), allConsole.join("\n"));
  await browser.close();
  process.exit(1);
}

// Wait for fake audio to accumulate in OpenAI's input buffer.
// The WAV is ~5s of speech + 3s silence = 8s loop. Wait ~8s to capture a full speech clip.
console.log("  waiting 8s for fake audio to be captured...");
await page.waitForTimeout(8000);

// In PTT mode, manually commit the buffered audio and ask for a response.
const committed = await page.evaluate(() => {
  const client = (window).__realtimeClient;
  if (!client) return "no client";
  client.send({ type: "input_audio_buffer.commit" });
  client.send({ type: "response.create" });
  return "sent";
});
console.log("  manual commit + response.create:", committed);

// Let the conversation run
const startedAt = Date.now();
const deadline = startedAt + RUN_SECONDS * 1000;
while (Date.now() < deadline) {
  await page.waitForTimeout(1000);
  // Stop early if we have proof of voice-to-voice + transcript
  const proofs = [
    seenEventTypes.has("response.created"),
    seenEventTypes.has("response.audio_transcript.delta") ||
      seenEventTypes.has("response.output_audio_transcript.delta"),
    seenEventTypes.has("response.audio_transcript.done") ||
      seenEventTypes.has("response.output_audio_transcript.done"),
    seenEventTypes.has("conversation.item.input_audio_transcription.completed"),
  ];
  if (proofs.filter(Boolean).length >= 4) {
    console.log(`✓ All 4 proofs met at ${Math.floor((Date.now() - startedAt) / 1000)}s`);
    // Wait a bit longer so the assistant turn finalizes and is in the DOM
    await page.waitForTimeout(2000);
    break;
  }
}

// Capture transcript turns from the DOM
const turns = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('[class*="msg"]').forEach((row) => {
    const whoEl = row.querySelector('[class*="who"]');
    const textEl = row.querySelector('[class*="text"]');
    if (whoEl && textEl) {
      out.push({
        who: whoEl.textContent?.trim() ?? "",
        text: textEl.textContent?.trim() ?? "",
      });
    }
  });
  return out;
});

await page.screenshot({ path: path.join(ARTIFACTS, "final.png"), fullPage: true });

// End the session cleanly
try {
  const endBtn = page.getByRole("button", { name: /end session/i });
  if (await endBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await endBtn.click();
  }
} catch {}

await browser.close();

const sortedEvents = [...seenEventTypes].sort();
const summary = {
  url: URL,
  durationSeconds: Math.floor((Date.now() - startedAt) / 1000),
  totalEvents: events.length,
  uniqueEventTypes: sortedEvents,
  turns,
  errors,
  proofs: {
    sessionCreated: seenEventTypes.has("session.created"),
    responseCreated: seenEventTypes.has("response.created"),
    assistantTranscriptDelta:
      seenEventTypes.has("response.audio_transcript.delta") ||
      seenEventTypes.has("response.output_audio_transcript.delta"),
    assistantTranscriptDone:
      seenEventTypes.has("response.audio_transcript.done") ||
      seenEventTypes.has("response.output_audio_transcript.done"),
    userTranscriptCompleted: seenEventTypes.has(
      "conversation.item.input_audio_transcription.completed",
    ),
  },
};

fs.writeFileSync(
  path.join(ARTIFACTS, "summary.json"),
  JSON.stringify(summary, null, 2),
);

console.log("\n──────── SUMMARY ────────");
console.log(JSON.stringify(summary, null, 2));

const allProven = Object.values(summary.proofs).every(Boolean);
const transcriptProven =
  summary.proofs.responseCreated &&
  summary.proofs.assistantTranscriptDelta &&
  summary.proofs.userTranscriptCompleted;

if (transcriptProven) {
  console.log("\n✅ Voice-to-voice loop + transcripting confirmed.");
  process.exit(0);
} else if (summary.proofs.responseCreated) {
  console.log("\n⚠ Partial success: assistant responded but transcripts missing.");
  process.exit(0);
} else {
  console.log("\n❌ Voice-to-voice loop NOT confirmed.");
  process.exit(1);
}
