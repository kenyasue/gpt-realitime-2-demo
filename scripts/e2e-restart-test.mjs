// scripts/e2e-restart-test.mjs
// Verifies that changing persona OR voice while the session is live triggers:
//   - a fresh `session.created` event (= new ephemeral key + new WebRTC handshake)
//   - the transcript is cleared
// Run alongside e2e-voice-test.mjs after the basic voice loop is confirmed.

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

const context = await browser.newContext({
  permissions: ["microphone"],
});

const page = await context.newPage();

const eventLog = [];
page.on("console", (msg) => {
  const text = msg.text();
  if (text.startsWith("[realtime]")) {
    const evType = text.split(/\s+/)[1];
    if (evType) eventLog.push({ at: Date.now(), type: evType });
  }
});

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
console.log("✓ Page loaded");

// Switch to PTT for deterministic test (bypasses VAD with fake audio)
await page.getByRole("tab", { name: /push-to-talk/i }).click();
console.log("✓ Switched to PTT");

// Start first session: default persona (assistant) + default voice (cedar)
await page.getByRole("button", { name: /start talking/i }).click();
await page.getByText(/Connected ·/i).waitFor({ timeout: 20000 });
console.log("✓ Session 1 live");

// Force a response so a turn appears in the transcript
await page.waitForTimeout(2000);
await page.evaluate(() => {
  const c = (window).__realtimeClient;
  c.send({ type: "input_audio_buffer.commit" });
  c.send({ type: "response.create" });
});

// Wait for an assistant turn
await page
  .locator('[class*="msg"][class*="assistant"]')
  .first()
  .waitFor({ timeout: 15000 });
console.log("✓ Session 1 produced an assistant turn");

const session1Created = eventLog.filter((e) => e.type === "session.created").length;
const turnsBefore = await page.$$eval('[class*="msg"]', (els) => els.length);
console.log(`  events: session.created=${session1Created}, transcript turns=${turnsBefore}`);

if (session1Created !== 1) {
  console.log("✗ Expected exactly 1 session.created before persona change");
  await browser.close();
  process.exit(1);
}
if (turnsBefore < 1) {
  console.log("✗ Expected at least 1 turn in transcript before persona change");
  await browser.close();
  process.exit(1);
}

/* ════════════════════════════ Persona change ════════════════════════════ */
console.log("\n— Changing persona to 'tutor'…");
await page.selectOption('select[aria-label="Persona"]', "tutor");

// Wait for second session.created (the restart)
const t0 = Date.now();
while (Date.now() - t0 < 20000) {
  const count = eventLog.filter((e) => e.type === "session.created").length;
  if (count >= 2) break;
  await page.waitForTimeout(300);
}

const session2Created = eventLog.filter((e) => e.type === "session.created").length;
const turnsAfterPersona = await page.$$eval('[class*="msg"]', (els) => els.length);
const voiceAfterPersona = await page.$eval('select[aria-label="Voice"]', (el) => el.value);
console.log(`  events: session.created=${session2Created}, transcript turns=${turnsAfterPersona}, voice=${voiceAfterPersona}`);

const personaRestartOk = session2Created === 2;
const personaTranscriptCleared = turnsAfterPersona === 0;
const personaVoiceUpdated = voiceAfterPersona === "marin"; // tutor's default

console.log(`  ${personaRestartOk ? "✓" : "✗"} 2nd session.created received`);
console.log(`  ${personaTranscriptCleared ? "✓" : "✗"} transcript cleared after persona change`);
console.log(`  ${personaVoiceUpdated ? "✓" : "✗"} voice updated to persona default (marin)`);

if (!personaRestartOk || !personaTranscriptCleared || !personaVoiceUpdated) {
  await page.screenshot({ path: path.join(ROOT, ".test-artifacts", "restart-persona-failure.png"), fullPage: true });
  await browser.close();
  process.exit(1);
}

// Produce another assistant turn in session 2 so we have transcript content again
await page.waitForTimeout(2000);
await page.evaluate(() => {
  const c = (window).__realtimeClient;
  c.send({ type: "input_audio_buffer.commit" });
  c.send({ type: "response.create" });
});
await page
  .locator('[class*="msg"][class*="assistant"]')
  .first()
  .waitFor({ timeout: 15000 });
console.log("✓ Session 2 produced an assistant turn");
const turnsBeforeVoice = await page.$$eval('[class*="msg"]', (els) => els.length);
console.log(`  transcript turns before voice change: ${turnsBeforeVoice}`);

/* ════════════════════════════ Voice change ═════════════════════════════ */
console.log("\n— Changing voice to 'verse'…");
await page.selectOption('select[aria-label="Voice"]', "verse");

const t1 = Date.now();
while (Date.now() - t1 < 20000) {
  const count = eventLog.filter((e) => e.type === "session.created").length;
  if (count >= 3) break;
  await page.waitForTimeout(300);
}

const session3Created = eventLog.filter((e) => e.type === "session.created").length;
const turnsAfterVoice = await page.$$eval('[class*="msg"]', (els) => els.length);
console.log(`  events: session.created=${session3Created}, transcript turns=${turnsAfterVoice}`);

const voiceRestartOk = session3Created === 3;
const voiceTranscriptCleared = turnsAfterVoice === 0;

console.log(`  ${voiceRestartOk ? "✓" : "✗"} 3rd session.created received`);
console.log(`  ${voiceTranscriptCleared ? "✓" : "✗"} transcript cleared after voice change`);

await page.screenshot({ path: path.join(ROOT, ".test-artifacts", "after-voice-change.png"), fullPage: true });
await browser.close();

const allOk = personaRestartOk && personaTranscriptCleared && personaVoiceUpdated && voiceRestartOk && voiceTranscriptCleared;

console.log("\n────── SUMMARY ──────");
console.log({
  personaChange: { restart: personaRestartOk, transcriptCleared: personaTranscriptCleared, voiceUpdated: personaVoiceUpdated },
  voiceChange: { restart: voiceRestartOk, transcriptCleared: voiceTranscriptCleared },
  sessionCreatedEventsTotal: session3Created,
});

if (allOk) {
  console.log("\n✅ Persona/voice change → fresh session + cleared transcript: confirmed.");
  process.exit(0);
}
console.log("\n❌ Restart behavior not fully confirmed.");
process.exit(1);
