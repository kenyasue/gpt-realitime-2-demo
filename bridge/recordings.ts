/**
 * Per-session recordings for the Twilio bridge.
 *
 * Audio on the wire is G.711 μ-law @ 8 kHz mono (both directions). We decode
 * to PCM16 in-memory as samples arrive, and on session end write two WAV
 * files plus a JSON transcript + metadata to:
 *
 *   ${RECORDINGS_DIR}/<sessionId>/{user.wav,assistant.wav,transcript.json,meta.json}
 *
 * RECORDINGS_DIR defaults to <cwd>/recordings.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const SAMPLE_RATE = 8000;

export const RECORDINGS_DIR =
  process.env.RECORDINGS_DIR && process.env.RECORDINGS_DIR.length > 0
    ? path.resolve(process.env.RECORDINGS_DIR)
    : path.resolve(process.cwd(), "recordings");

/* ─── μ-law → PCM16 ─────────────────────────────────────────────────────── */

const MULAW_DECODE_TABLE = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    t[i] = sign ? -sample : sample;
  }
  return t;
})();

export function muLawBufferToPcm16(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) {
    out.writeInt16LE(MULAW_DECODE_TABLE[buf[i]], i * 2);
  }
  return out;
}

/* ─── WAV header ────────────────────────────────────────────────────────── */

function wavHeader(dataLength: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits/sample
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

/* ─── Types ─────────────────────────────────────────────────────────────── */

export interface RecordedTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
  interrupted?: boolean;
}

export interface SessionMeta {
  id: string;
  startedAt: string;
  endedAt?: string;
  callSid?: string;
  to?: string;
  personaId: string;
  personaLabel?: string;
  voice: string;
  endReason?: string;
  hasUserAudio: boolean;
  hasAssistantAudio: boolean;
  userBytes: number;
  assistantBytes: number;
  durationSec: number;
  userTurns: number;
  assistantTurns: number;
}

/* ─── In-memory recorder ────────────────────────────────────────────────── */

export class SessionRecorder {
  meta: SessionMeta;
  private userPcm: Buffer[] = [];
  private assistantPcm: Buffer[] = [];
  turns: RecordedTurn[] = [];
  private finalized = false;

  constructor(init: {
    id: string;
    callSid?: string;
    to?: string;
    personaId: string;
    personaLabel?: string;
    voice: string;
  }) {
    this.meta = {
      id: init.id,
      startedAt: new Date().toISOString(),
      callSid: init.callSid,
      to: init.to,
      personaId: init.personaId,
      personaLabel: init.personaLabel,
      voice: init.voice,
      hasUserAudio: false,
      hasAssistantAudio: false,
      userBytes: 0,
      assistantBytes: 0,
      durationSec: 0,
      userTurns: 0,
      assistantTurns: 0,
    };
  }

  pushUserMuLawBase64(b64: string): void {
    if (this.finalized || !b64) return;
    const pcm = muLawBufferToPcm16(Buffer.from(b64, "base64"));
    this.userPcm.push(pcm);
  }

  pushAssistantMuLawBase64(b64: string): void {
    if (this.finalized || !b64) return;
    const pcm = muLawBufferToPcm16(Buffer.from(b64, "base64"));
    this.assistantPcm.push(pcm);
  }

  /**
   * Upsert a turn by id (matches the frontend's reducer logic).
   */
  upsertTurn(patch: Partial<RecordedTurn> & { id: string; role: "user" | "assistant" }): void {
    if (this.finalized) return;
    const i = this.turns.findIndex((t) => t.id === patch.id);
    if (i === -1) {
      this.turns.push({
        id: patch.id,
        role: patch.role,
        text: patch.text ?? "",
        final: patch.final ?? false,
        interrupted: patch.interrupted,
      });
    } else {
      this.turns[i] = { ...this.turns[i], ...patch };
    }
  }

  appendAssistantDelta(id: string, delta: string): void {
    if (this.finalized) return;
    const i = this.turns.findIndex((t) => t.id === id);
    if (i === -1) {
      this.turns.push({ id, role: "assistant", text: delta, final: false });
    } else {
      this.turns[i] = { ...this.turns[i], text: this.turns[i].text + delta };
    }
  }

  markCurrentAssistantInterrupted(): void {
    if (this.finalized) return;
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const t = this.turns[i];
      if (t.role === "assistant" && !t.final) {
        this.turns[i] = { ...t, interrupted: true };
        return;
      }
    }
  }

  async finalize(endReason: string): Promise<SessionMeta | null> {
    if (this.finalized) return this.meta;
    this.finalized = true;

    const userData = Buffer.concat(this.userPcm);
    const assistantData = Buffer.concat(this.assistantPcm);

    this.meta.endedAt = new Date().toISOString();
    this.meta.endReason = endReason;
    this.meta.durationSec = Math.max(
      0,
      Math.round(
        (new Date(this.meta.endedAt).getTime() -
          new Date(this.meta.startedAt).getTime()) /
          1000,
      ),
    );
    this.meta.userBytes = userData.length;
    this.meta.assistantBytes = assistantData.length;
    this.meta.hasUserAudio = userData.length > 0;
    this.meta.hasAssistantAudio = assistantData.length > 0;
    this.meta.userTurns = this.turns.filter((t) => t.role === "user").length;
    this.meta.assistantTurns = this.turns.filter((t) => t.role === "assistant").length;

    if (!this.meta.hasUserAudio && !this.meta.hasAssistantAudio && this.turns.length === 0) {
      return null;
    }

    const dir = path.join(RECORDINGS_DIR, this.meta.id);
    await fs.mkdir(dir, { recursive: true });

    const writes: Promise<unknown>[] = [
      fs.writeFile(
        path.join(dir, "transcript.json"),
        JSON.stringify(this.turns, null, 2),
      ),
      fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(this.meta, null, 2)),
    ];
    if (this.meta.hasUserAudio) {
      writes.push(
        fs.writeFile(
          path.join(dir, "user.wav"),
          Buffer.concat([wavHeader(userData.length), userData]),
        ),
      );
    }
    if (this.meta.hasAssistantAudio) {
      writes.push(
        fs.writeFile(
          path.join(dir, "assistant.wav"),
          Buffer.concat([wavHeader(assistantData.length), assistantData]),
        ),
      );
    }
    await Promise.all(writes);

    // Free the buffers after flushing.
    this.userPcm = [];
    this.assistantPcm = [];
    return this.meta;
  }
}

/* ─── Filesystem helpers ────────────────────────────────────────────────── */

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export function isSafeSessionId(id: string): boolean {
  return SAFE_ID.test(id);
}

export async function listSessions(): Promise<SessionMeta[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(RECORDINGS_DIR);
  } catch {
    return [];
  }
  const results: SessionMeta[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const raw = await fs.readFile(
          path.join(RECORDINGS_DIR, entry, "meta.json"),
          "utf-8",
        );
        results.push(JSON.parse(raw) as SessionMeta);
      } catch {
        /* skip */
      }
    }),
  );
  results.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return results;
}

export async function readSessionDetail(
  id: string,
): Promise<{ meta: SessionMeta; turns: RecordedTurn[] } | null> {
  if (!isSafeSessionId(id)) return null;
  try {
    const dir = path.join(RECORDINGS_DIR, id);
    const [metaRaw, turnsRaw] = await Promise.all([
      fs.readFile(path.join(dir, "meta.json"), "utf-8"),
      fs.readFile(path.join(dir, "transcript.json"), "utf-8"),
    ]);
    return {
      meta: JSON.parse(metaRaw) as SessionMeta,
      turns: JSON.parse(turnsRaw) as RecordedTurn[],
    };
  } catch {
    return null;
  }
}

export function sessionAudioPath(id: string, leg: "user" | "assistant"): string | null {
  if (!isSafeSessionId(id)) return null;
  return path.join(RECORDINGS_DIR, id, `${leg}.wav`);
}

export async function deleteSession(id: string): Promise<boolean> {
  if (!isSafeSessionId(id)) return false;
  try {
    await fs.rm(path.join(RECORDINGS_DIR, id), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
