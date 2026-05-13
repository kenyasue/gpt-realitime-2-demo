/**
 * Twilio ↔ OpenAI Realtime bridge.
 *
 * Architecture
 * ────────────
 *  Browser (Twilio tab) ──HTTP──► POST /api/call         (this server)
 *                                  └─► Twilio REST ──dials──► user's phone
 *
 *  Twilio Voice ──HTTP──► GET /twiml?session=<id>        (this server)
 *                          └─► returns TwiML with <Stream wss://…/media-stream>
 *
 *  Twilio Media ──WS──► /media-stream?session=<id>       (this server)
 *                          └─► opens WS to OpenAI Realtime API
 *                              and bridges g711_ulaw audio both ways.
 *
 *  Browser ──SSE──► GET /events/:sessionId               (this server)
 *                          └─► streams transcript + status events.
 *
 * Audio format: g711 μ-law @ 8 kHz both directions, so no resampling is
 * needed — Twilio's payload is forwarded verbatim as base64 to OpenAI
 * and back.
 */

import { config as dotenvConfig } from "dotenv";
// Match Next.js's precedence: .env.local overrides .env.
// We load .env first so existing values are present, then .env.local with
// `override: true` so anything there wins.
dotenvConfig({ path: ".env" });
dotenvConfig({ path: ".env.local", override: true });

import Fastify from "fastify";
import fastifyFormbody from "@fastify/formbody";
import fastifyWebsocket from "@fastify/websocket";
import fastifyCors from "@fastify/cors";
import Twilio from "twilio";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PERSONAS, type PersonaId, type VoiceId } from "../lib/personas";

const {
  OPENAI_API_KEY,
  OPENAI_REALTIME_MODEL = "gpt-realtime-2",
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  PUBLIC_BRIDGE_URL,
  BRIDGE_PORT = "5050",
  BRIDGE_CORS_ORIGIN = "http://localhost:3000",
} = process.env;

if (!OPENAI_API_KEY) {
  console.error("[bridge] OPENAI_API_KEY is missing — set it in .env.local");
  process.exit(1);
}

const twilioConfigured = Boolean(
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER && PUBLIC_BRIDGE_URL,
);
const twilio = twilioConfigured
  ? Twilio(TWILIO_ACCOUNT_SID!, TWILIO_AUTH_TOKEN!)
  : null;

/* ─── Session registry ──────────────────────────────────────────────────── */

interface SessionConfig {
  personaId: PersonaId;
  voice: VoiceId;
  instructions: string;
  language?: string;
  autoStart: boolean;
}

interface BridgeSession {
  id: string;
  config: SessionConfig;
  /** Twilio Call SID, set after the REST call create() returns */
  callSid?: string;
  /** Twilio Media Stream SID, set after the WS "start" event */
  streamSid?: string;
  /** WebSocket to OpenAI Realtime API (set when Twilio Media Stream opens) */
  openaiWs?: WebSocket;
  /** WebSocket to Twilio (set when Twilio Media Stream opens) */
  twilioWs?: WebSocket;
  /** Event bus the SSE endpoint subscribes to */
  events: EventEmitter;
  /** True once the AI's first "speak first" response has been triggered */
  autoStarted: boolean;
  /** True once the call has ended; further events are dropped */
  ended: boolean;
}

const sessions = new Map<string, BridgeSession>();

/* ─── HTTP server ───────────────────────────────────────────────────────── */

const fastify = Fastify({
  logger: {
    level: "info",
    transport: {
      target: "pino-pretty",
      options: { translateTime: "HH:MM:ss", ignore: "pid,hostname,reqId" },
    },
  },
});

fastify.addHook("onRequest", async (req) => {
  req.log.info({ method: req.method, url: req.url }, "→ request");
});
fastify.addHook("onResponse", async (req, reply) => {
  req.log.info(
    { method: req.method, url: req.url, status: reply.statusCode, ms: reply.elapsedTime?.toFixed?.(0) },
    "← response",
  );
});

// Plugins MUST be registered before routes so their onRoute hooks (especially
// @fastify/websocket, which transforms routes flagged { websocket: true }) see
// the route definitions. The `.register()` calls are queued — Fastify processes
// them in order during `.ready()` / `.listen()`.
fastify.register(fastifyCors, { origin: BRIDGE_CORS_ORIGIN });
fastify.register(fastifyFormbody);
fastify.register(fastifyWebsocket);

fastify.get("/", async () => ({
  ok: true,
  message: "Twilio ↔ OpenAI Realtime bridge",
  twilioConfigured,
  publicBridgeUrl: PUBLIC_BRIDGE_URL ?? null,
  activeSessions: sessions.size,
}));

/* ─── POST /api/call — start an outbound call ───────────────────────────── */

interface CallRequestBody {
  to?: string;
  personaId?: PersonaId;
  voice?: VoiceId;
}

fastify.post("/api/call", async (request, reply) => {
  if (!twilio || !PUBLIC_BRIDGE_URL) {
    const missing = [
      ["TWILIO_ACCOUNT_SID", TWILIO_ACCOUNT_SID],
      ["TWILIO_AUTH_TOKEN", TWILIO_AUTH_TOKEN],
      ["TWILIO_FROM_NUMBER", TWILIO_FROM_NUMBER],
      ["PUBLIC_BRIDGE_URL", PUBLIC_BRIDGE_URL],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    return reply.code(503).send({
      error: "twilio_not_configured",
      missing,
      message: `Missing env var(s): ${missing.join(", ")}. Add them to .env or .env.local and restart \`npm run dev:bridge\`.`,
    });
  }

  const body = (request.body ?? {}) as CallRequestBody;
  const to = (body.to ?? "").trim();
  if (!/^\+\d{6,15}$/.test(to)) {
    return reply.code(400).send({
      error: "invalid_to",
      message: "Provide a destination number in E.164 format, e.g. +14155550123",
    });
  }

  const personaId = (body.personaId ?? "assistant") as PersonaId;
  const persona = PERSONAS.find((p) => p.id === personaId);
  if (!persona) {
    return reply.code(400).send({ error: "unknown_persona", message: personaId });
  }
  const voice = (body.voice ?? persona.defaultVoice) as VoiceId;

  const sessionId = randomUUID();
  const session: BridgeSession = {
    id: sessionId,
    config: {
      personaId,
      voice,
      instructions: persona.instructions,
      language: persona.language,
      autoStart: !!persona.autoStart,
    },
    events: new EventEmitter(),
    autoStarted: false,
    ended: false,
  };
  sessions.set(sessionId, session);

  // Auto-clean abandoned sessions (Twilio never opens the stream).
  setTimeout(() => {
    const s = sessions.get(sessionId);
    if (s && !s.twilioWs && !s.ended) {
      console.log(`[bridge] session ${sessionId} expired without media stream`);
      endSession(s, "expired_before_connect");
    }
  }, 2 * 60_000);

  try {
    const call = await twilio.calls.create({
      to,
      from: TWILIO_FROM_NUMBER!,
      url: `${PUBLIC_BRIDGE_URL}/twiml?session=${sessionId}`,
      statusCallback: `${PUBLIC_BRIDGE_URL}/api/status-callback?session=${sessionId}`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });
    session.callSid = call.sid;
    console.log(`[bridge] call ${call.sid} dialing ${to} (session ${sessionId})`);
    emitStatus(session, "dialing");
    return reply.send({ sessionId, callSid: call.sid });
  } catch (err) {
    sessions.delete(sessionId);
    const message = err instanceof Error ? err.message : String(err);
    console.error("[bridge] twilio.calls.create failed:", message);
    return reply.code(502).send({ error: "twilio_dial_failed", message });
  }
});

/* ─── POST /api/end/:sessionId — hang up ───────────────────────────────── */

fastify.post<{ Params: { sessionId: string } }>(
  "/api/end/:sessionId",
  async (request, reply) => {
    const session = sessions.get(request.params.sessionId);
    if (!session) return reply.code(404).send({ error: "no_such_session" });
    if (session.callSid && twilio) {
      try {
        await twilio.calls(session.callSid).update({ status: "completed" });
      } catch (err) {
        console.warn("[bridge] hangup failed (call may already be over):", err);
      }
    }
    endSession(session, "user_ended");
    return reply.send({ ok: true });
  },
);

/* ─── Twilio status callback (call progress events) ─────────────────────── */

fastify.post("/api/status-callback", async (request, reply) => {
  const query = request.query as { session?: string };
  const body = request.body as { CallStatus?: string };
  const session = query.session ? sessions.get(query.session) : null;
  const status = body.CallStatus;
  if (session && status) {
    if (status === "ringing") emitStatus(session, "ringing");
    else if (status === "in-progress") emitStatus(session, "answered");
    else if (status === "completed" || status === "failed" || status === "no-answer" || status === "busy") {
      emitStatus(session, "ended", { twilioStatus: status });
      endSession(session, status);
    }
  }
  return reply.code(204).send();
});

/* ─── GET /twiml — TwiML for the outbound call ──────────────────────────── */

fastify.all<{ Querystring: { session?: string } }>("/twiml", async (request, reply) => {
  const sessionId = request.query.session;
  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session) {
    return reply.code(404).type("text/xml").send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Session not found.</Say><Hangup/></Response>`,
    );
  }

  // Need the wss:// version of PUBLIC_BRIDGE_URL for the <Stream>.
  // Twilio strips query strings on the <Stream> WebSocket upgrade, so we
  // pass the session id as a path segment AND as a <Parameter> (belt + braces).
  const wsUrl = (PUBLIC_BRIDGE_URL ?? "").replace(/^https?:\/\//, "wss://");
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}/media-stream/${sessionId}">
      <Parameter name="session" value="${sessionId}" />
    </Stream>
  </Connect>
</Response>`;
  return reply.type("text/xml").send(twiml);
});

/* ─── WebSocket /media-stream/:sessionId — Twilio audio bridge ──────────── */

fastify.register(async (scoped) => {
  scoped.get<{ Params: { sessionId: string } }>(
    "/media-stream/:sessionId",
    { websocket: true },
    (twilioWs, request) => {
      const sessionId = request.params.sessionId;
      const session = sessionId ? sessions.get(sessionId) : null;
      if (!session) {
        console.warn(`[bridge] media-stream opened for unknown session ${sessionId}`);
        twilioWs.close();
        return;
      }
      console.log(`[bridge] media-stream opened for session ${sessionId}`);
      session.twilioWs = twilioWs;
      bridgeAudio(session);
    },
  );
});

/* ─── GET /events/:sessionId — SSE transcript stream ────────────────────── */

fastify.get<{ Params: { sessionId: string } }>(
  "/events/:sessionId",
  async (request, reply) => {
    const session = sessions.get(request.params.sessionId);
    if (!session) return reply.code(404).send({ error: "no_such_session" });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": BRIDGE_CORS_ORIGIN,
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(`: connected ${session.id}\n\n`);

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const onEvent = (name: string, payload: unknown) => send(name, payload);
    session.events.on("event", onEvent);

    // Heartbeat so corporate proxies don't kill the stream.
    const hb = setInterval(() => reply.raw.write(`: ping\n\n`), 15_000);

    request.raw.on("close", () => {
      clearInterval(hb);
      session.events.off("event", onEvent);
    });
  },
);

/* ─── Audio bridge ──────────────────────────────────────────────────────── */

function bridgeAudio(session: BridgeSession) {
  const { config } = session;
  // GA Realtime API: no OpenAI-Beta header. Adding it routes to the beta
  // endpoint which doesn't know about gpt-realtime-2 and replies with
  //   close 4000 invalid_request_error.invalid_model
  const openaiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`;
  console.log(`[bridge] connecting OpenAI WS → ${openaiUrl}`);
  const openaiWs = new WebSocket(openaiUrl, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
  });
  session.openaiWs = openaiWs;

  openaiWs.on("open", () => {
    console.log(`[bridge] OpenAI WS open for session ${session.id}`);
    const transcription: { model: string; language?: string } = { model: "whisper-1" };
    if (config.language) transcription.language = config.language;

    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model: OPENAI_REALTIME_MODEL,
          instructions: config.instructions,
          audio: {
            input: {
              format: { type: "audio/pcmu" },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
              },
              transcription,
            },
            output: {
              voice: config.voice,
              format: { type: "audio/pcmu" },
            },
          },
        },
      }),
    );
  });

  openaiWs.on("message", (raw) => handleOpenAiMessage(session, raw.toString()));
  openaiWs.on("error", (err) => {
    console.error(`[bridge] OpenAI WS error (${session.id}):`, err);
    emit(session, "error", { source: "openai", message: err.message });
  });
  openaiWs.on("close", (code, reason) => {
    console.log(`[bridge] OpenAI WS closed (${session.id}): ${code} ${reason}`);
    if (!session.ended) endSession(session, "openai_closed");
  });

  /* ── Twilio side ── */
  const { twilioWs } = session;
  if (!twilioWs) return;

  twilioWs.on("message", (raw) => {
    let msg: { event?: string; start?: { streamSid?: string }; media?: { payload?: string } };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.event) {
      case "start": {
        session.streamSid = msg.start?.streamSid;
        emitStatus(session, "connected");
        // If the persona is set to speak first, trigger a response now.
        if (config.autoStart && !session.autoStarted && openaiWs.readyState === WebSocket.OPEN) {
          session.autoStarted = true;
          openaiWs.send(JSON.stringify({ type: "response.create" }));
        }
        break;
      }
      case "media": {
        const payload = msg.media?.payload;
        if (payload && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
        }
        break;
      }
      case "stop": {
        console.log(`[bridge] Twilio stream stopped for session ${session.id}`);
        if (!session.ended) endSession(session, "twilio_stop");
        break;
      }
    }
  });

  twilioWs.on("close", () => {
    if (!session.ended) endSession(session, "twilio_close");
  });
}

function handleOpenAiMessage(session: BridgeSession, raw: string) {
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(raw);
  } catch {
    return;
  }
  const type = evt.type as string | undefined;
  if (!type) return;

  switch (type) {
    case "response.audio.delta":
    case "response.output_audio.delta": {
      const delta = (evt.delta as string | undefined) ?? "";
      if (delta && session.twilioWs && session.streamSid) {
        session.twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid: session.streamSid,
            media: { payload: delta },
          }),
        );
      }
      break;
    }

    case "input_audio_buffer.speech_started": {
      // Barge-in: tell Twilio to clear any audio it has buffered for playback.
      if (session.twilioWs && session.streamSid) {
        session.twilioWs.send(
          JSON.stringify({ event: "clear", streamSid: session.streamSid }),
        );
      }
      emit(session, "speech_started", {});
      break;
    }

    case "conversation.item.input_audio_transcription.completed": {
      emit(session, "user_transcript", {
        id: evt.item_id,
        text: evt.transcript ?? "",
      });
      break;
    }

    case "response.created": {
      const response = evt.response as { id?: string } | undefined;
      emit(session, "assistant_started", { id: response?.id });
      break;
    }

    case "response.audio_transcript.delta":
    case "response.output_audio_transcript.delta": {
      emit(session, "assistant_delta", {
        id: evt.response_id,
        delta: evt.delta ?? "",
      });
      break;
    }

    case "response.audio_transcript.done":
    case "response.output_audio_transcript.done": {
      emit(session, "assistant_done", {
        id: evt.response_id,
        text: evt.transcript ?? "",
      });
      break;
    }

    case "response.done": {
      const response = evt.response as { id?: string } | undefined;
      emit(session, "response_done", { id: response?.id });
      break;
    }

    case "error": {
      const e = evt.error as { message?: string } | undefined;
      emit(session, "error", { source: "openai", message: e?.message ?? "unknown" });
      break;
    }
  }
}

/* ─── Helpers ───────────────────────────────────────────────────────────── */

function emit(session: BridgeSession, name: string, payload: unknown) {
  if (session.ended && name !== "status") return;
  session.events.emit("event", name, payload);
}

function emitStatus(session: BridgeSession, status: string, extra: object = {}) {
  session.events.emit("event", "status", { status, ...extra });
}

function endSession(session: BridgeSession, reason: string) {
  if (session.ended) return;
  session.ended = true;
  emitStatus(session, "ended", { reason });
  try {
    session.openaiWs?.close();
  } catch {
    /* noop */
  }
  try {
    session.twilioWs?.close();
  } catch {
    /* noop */
  }
  // Keep the session entry around briefly so SSE clients can drain final events.
  setTimeout(() => sessions.delete(session.id), 5_000);
}

/* ─── Boot ──────────────────────────────────────────────────────────────── */

async function start() {
  const port = Number(BRIDGE_PORT);
  await fastify.listen({ port, host: "0.0.0.0" });
  console.log(`[bridge] listening on http://localhost:${port}`);
  console.log(`[bridge] env vars detected:`);
  console.log(`  OPENAI_API_KEY      ${OPENAI_API_KEY ? "✓ set" : "✗ MISSING"}`);
  console.log(`  TWILIO_ACCOUNT_SID  ${TWILIO_ACCOUNT_SID ? "✓ set" : "✗ MISSING"}`);
  console.log(`  TWILIO_AUTH_TOKEN   ${TWILIO_AUTH_TOKEN ? "✓ set" : "✗ MISSING"}`);
  console.log(`  TWILIO_FROM_NUMBER  ${TWILIO_FROM_NUMBER ? `✓ ${TWILIO_FROM_NUMBER}` : "✗ MISSING"}`);
  console.log(`  PUBLIC_BRIDGE_URL   ${PUBLIC_BRIDGE_URL ? `✓ ${PUBLIC_BRIDGE_URL}` : "✗ MISSING"}`);
  console.log(`[bridge] twilio configured: ${twilioConfigured}`);
  if (!twilioConfigured) {
    console.log(
      "[bridge] add the missing vars above to .env or .env.local, then restart this process.",
    );
  }
}

start().catch((err) => {
  console.error("[bridge] failed to start:", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("[bridge] SIGINT — shutting down");
  for (const s of sessions.values()) endSession(s, "shutdown");
  fastify.close().finally(() => process.exit(0));
});
