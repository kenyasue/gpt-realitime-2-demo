import { NextResponse } from "next/server";
import { PERSONAS, type PersonaId, type VoiceId } from "@/lib/personas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RequestBody {
  voice?: VoiceId;
  personaId?: PersonaId;
  instructions?: string;
  mode?: "vad" | "ptt";
  /** ISO 639-1 language code for input-audio transcription (e.g. "hr"). */
  language?: string;
}

const DEFAULT_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2";

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured on the server" },
      { status: 500 },
    );
  }

  let body: RequestBody = {};
  try {
    if (req.headers.get("content-type")?.includes("application/json")) {
      body = (await req.json()) as RequestBody;
    }
  } catch {
    // ignore malformed JSON; fall through to defaults
  }

  const persona = body.personaId
    ? PERSONAS.find((p) => p.id === body.personaId)
    : PERSONAS[0];

  const voice = body.voice ?? persona?.defaultVoice ?? "cedar";
  const instructions = body.instructions ?? persona?.instructions ?? "";
  const mode = body.mode ?? "vad";
  const language = body.language ?? persona?.language;

  const turnDetection =
    mode === "ptt"
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        };

  const transcription: { model: string; language?: string } = { model: "whisper-1" };
  if (language) transcription.language = language;

  const sessionRequestBody = {
    session: {
      type: "realtime",
      model: DEFAULT_MODEL,
      instructions,
      audio: {
        output: { voice },
        input: {
          transcription,
          turn_detection: turnDetection,
        },
      },
    },
  };

  let upstream: Response;
  try {
    upstream = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sessionRequestBody),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "upstream_network_error",
        message: err instanceof Error ? err.message : "unknown",
      },
      { status: 502 },
    );
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    return NextResponse.json(
      {
        error: "upstream_error",
        status: upstream.status,
        message: text.slice(0, 800),
      },
      { status: upstream.status },
    );
  }

  let payload: { value?: string; expires_at?: number; session?: { model?: string } };
  try {
    payload = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { error: "upstream_invalid_json", message: text.slice(0, 400) },
      { status: 502 },
    );
  }

  if (!payload.value) {
    return NextResponse.json(
      { error: "upstream_missing_value", message: "No ephemeral key in upstream response" },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ephemeralKey: payload.value,
    expiresAt: payload.expires_at,
    model: payload.session?.model ?? DEFAULT_MODEL,
  });
}
