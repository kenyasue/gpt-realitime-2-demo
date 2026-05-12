// scripts/e2e-survey-test.mjs
// Verifies the Survey persona auto-starts the conversation:
// the assistant produces a `response.created` and an assistant transcript turn
// without the user sending any audio or `response.create` event first.

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const WAV = path.join(ROOT, ".test-artifacts", "speech.wav").replace(/\\/g, "/");
const URL = process.env.TEST_URL || "http://localhost:3000";

if (!fs.existsSync(WAV)) {
  console.error(`Missing ${WAV} — run scripts/make-tts-wav.ps1 first.`);
  process.exit(2);
}

const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${WAV}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const context = await browser.newContext({ permissions: ["microphone"] });
const page = await context.newPage();

const events = [];
const seenEventTypes = new Set();
let sessionPostBody = null;

page.on("console", (msg) => {
  const text = msg.text();
  if (text.startsWith("[realtime]")) {
    const evType = text.split(/\s+/)[1];
    if (evType) {
      events.push({ at: Date.now(), type: evType });
      seenEventTypes.add(evType);
    }
  }
});

// Capture the body the page sends to /api/session so we can verify the
// language hint travels through.
page.on("request", (req) => {
  if (req.url().endsWith("/api/session") && req.method() === "POST") {
    try { sessionPostBody = JSON.parse(req.postData() || "null"); } catch {}
  }
});

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
console.log("✓ Page loaded");

// Switch to PTT so we KNOW we're not sending any user audio that could trigger VAD
await page.getByRole("tab", { name: /push-to-talk/i }).click();
console.log("✓ Switched to PTT (no user audio will be committed)");

// Select Survey persona from the dropdown
await page.selectOption('select[aria-label="Persona"]', "surveyor");
console.log("✓ Selected 'Survey (5 questions)' persona");

// Check that the default voice flipped to the persona's defaultVoice
const voiceAfter = await page.$eval('select[aria-label="Voice"]', (el) => el.value);
console.log(`  voice after persona select: ${voiceAfter}`);
if (voiceAfter !== "coral") {
  console.log("✗ Expected voice to flip to 'coral' (Survey default)");
  await browser.close();
  process.exit(1);
}

// Start the session
await page.getByRole("button", { name: /start talking/i }).click();
await page.getByText(/Connected ·/i).waitFor({ timeout: 20000 });
console.log("✓ Session live");

// Wait up to 15s for the AI to greet on its own (no user input sent)
const startedAt = Date.now();
const deadline = startedAt + 15000;
let assistantTurnFound = false;
let assistantText = "";

while (Date.now() < deadline) {
  await page.waitForTimeout(500);
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
  const assistantTurn = turns.find((t) => t.who === "Assistant" && t.text.length > 5);
  if (assistantTurn && seenEventTypes.has("response.output_audio_transcript.done")) {
    assistantTurnFound = true;
    assistantText = assistantTurn.text;
    break;
  }
}

await page.screenshot({ path: path.join(ROOT, ".test-artifacts", "survey-autostart.png"), fullPage: true });
await browser.close();

// Croatian markers: words that appear in Croatian but not English/most others.
// We expect at least one to appear in the assistant's greeting.
const CROATIAN_MARKERS = /\b(bok|pozdrav|mo[zž]emo|anket(?:a|u|e|i|om)|hrvatski|po[čc]eti|zapo[čc]eti|pet pitanja)\b/i;

const proofs = {
  responseCreatedWithoutUserInput: seenEventTypes.has("response.created"),
  assistantTranscriptDone: seenEventTypes.has("response.output_audio_transcript.done"),
  assistantTurnInDom: assistantTurnFound,
  // Negative proof: we never sent input_audio_buffer.commit, so the user shouldn't have a turn
  noUserTurn: ![...seenEventTypes].includes("conversation.item.input_audio_transcription.completed"),
  // Croatian content checks
  openingIsCroatian: CROATIAN_MARKERS.test(assistantText),
  // The page sent language: "hr" to /api/session
  languageHintSent: sessionPostBody?.language === "hr",
};

console.log("\n──────── SUMMARY ────────");
console.log({
  proofs,
  assistantOpening: assistantText,
  eventCount: events.length,
  uniqueEvents: [...seenEventTypes].sort(),
});

const allOk = Object.values(proofs).every(Boolean);
if (allOk) {
  console.log("\n✅ Survey persona auto-greets without user input.");
  process.exit(0);
}
console.log("\n❌ Survey auto-start NOT confirmed.");
process.exit(1);
