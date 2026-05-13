"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./WebTab.module.css";
import { Controls } from "./Controls";
import { Stage, type SessionState } from "./Stage";
import { Transcript, type Turn } from "./Transcript";
import { getPersona, type PersonaId, type VoiceId } from "@/lib/personas";
import { createRealtimeClient, type RealtimeClient } from "@/lib/realtime-client";
import type { ServerEvent } from "@/lib/realtime-events";

const SESSION_HARD_CAP_SECONDS = 5 * 60;

export function WebTab() {
  const [personaId, setPersonaId] = useState<PersonaId>("assistant");
  const [voice, setVoice] = useState<VoiceId>(getPersona("assistant").defaultVoice);
  const [mode, setMode] = useState<"vad" | "ptt">("vad");
  const [session, setSession] = useState<SessionState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [micLevel, setMicLevel] = useState(0);
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const [pttActive, setPttActive] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const clientRef = useRef<RealtimeClient | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const meterRafRef = useRef<number>(0);
  const sessionTimerRef = useRef<number | null>(null);
  const currentAssistantTurnIdRef = useRef<string | null>(null);
  const currentUserTurnIdRef = useRef<string | null>(null);
  const autoStartNextSessionRef = useRef(false);

  /* Cleanup on unmount */
  useEffect(() => {
    return () => {
      clientRef.current?.disconnect();
      stopMeter();
      stopTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startTimer() {
    stopTimer();
    setSessionSeconds(0);
    const startedAt = Date.now();
    sessionTimerRef.current = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      setSessionSeconds(elapsed);
      if (elapsed >= SESSION_HARD_CAP_SECONDS) {
        void endSession("Session reached the 5-minute demo cap.");
      }
    }, 250);
  }

  function stopTimer() {
    if (sessionTimerRef.current !== null) {
      clearInterval(sessionTimerRef.current);
      sessionTimerRef.current = null;
    }
  }

  function startMeter(stream: MediaStream) {
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      audioContextRef.current = ctx;
      analyserRef.current = analyser;

      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        setMicLevel(Math.min(1, rms * 3));
        meterRafRef.current = requestAnimationFrame(tick);
      };
      meterRafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      console.warn("[mic-meter] failed to start", err);
    }
  }

  function stopMeter() {
    if (meterRafRef.current) {
      cancelAnimationFrame(meterRafRef.current);
      meterRafRef.current = 0;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => undefined);
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    setMicLevel(0);
  }

  const handleEvent = useCallback((event: ServerEvent) => {
    if (process.env.NODE_ENV !== "production") {
      console.log("[realtime]", event.type);
    }

    switch (event.type) {
      case "session.created": {
        if (autoStartNextSessionRef.current) {
          autoStartNextSessionRef.current = false;
          clientRef.current?.send({ type: "response.create" });
        }
        break;
      }

      case "input_audio_buffer.speech_started": {
        const id = (event as { item_id?: string }).item_id ?? `user-${crypto.randomUUID()}`;
        currentUserTurnIdRef.current = id;
        setTurns((prev) => {
          if (prev.some((t) => t.id === id)) return prev;
          return [...prev, { id, role: "user", text: "", final: false }];
        });
        setTurns((prev) =>
          prev.map((t) =>
            t.role === "assistant" && !t.final ? { ...t, interrupted: true } : t,
          ),
        );
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const ev = event as { item_id: string; transcript: string };
        setTurns((prev) => {
          const idx = prev.findIndex((t) => t.id === ev.item_id);
          if (idx === -1) {
            return [
              ...prev,
              { id: ev.item_id, role: "user", text: ev.transcript, final: true },
            ];
          }
          const copy = [...prev];
          copy[idx] = { ...copy[idx], text: ev.transcript, final: true };
          return copy;
        });
        break;
      }

      case "conversation.item.input_audio_transcription.failed": {
        const ev = event as { item_id: string };
        setTurns((prev) =>
          prev.map((t) => (t.id === ev.item_id ? { ...t, final: true } : t)),
        );
        break;
      }

      case "response.created": {
        const ev = event as { response: { id: string } };
        const id = ev.response.id;
        currentAssistantTurnIdRef.current = id;
        setTurns((prev) => [
          ...prev,
          { id, role: "assistant", text: "", final: false },
        ]);
        break;
      }

      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta": {
        const ev = event as { delta: string; response_id: string };
        setTurns((prev) =>
          prev.map((t) =>
            t.id === ev.response_id ? { ...t, text: t.text + ev.delta } : t,
          ),
        );
        break;
      }

      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done": {
        const ev = event as { response_id: string; transcript: string };
        setTurns((prev) =>
          prev.map((t) =>
            t.id === ev.response_id ? { ...t, text: ev.transcript, final: true } : t,
          ),
        );
        break;
      }

      case "response.done": {
        const ev = event as { response: { id: string } };
        setTurns((prev) =>
          prev.map((t) =>
            t.id === ev.response.id && !t.final ? { ...t, final: true } : t,
          ),
        );
        break;
      }

      case "response.cancelled": {
        const ev = event as { response_id: string };
        setTurns((prev) =>
          prev.map((t) =>
            t.id === ev.response_id && !t.final
              ? { ...t, final: true, interrupted: true }
              : t,
          ),
        );
        break;
      }

      case "error": {
        const ev = event as { error: { message: string } };
        console.error("[realtime] error event", ev.error);
        setErrorMessage(ev.error.message);
        break;
      }

      default:
        break;
    }
  }, []);

  const persona = useMemo(() => getPersona(personaId), [personaId]);
  void persona;

  type StartOverrides = { voice?: VoiceId; personaId?: PersonaId; mode?: "vad" | "ptt" };

  async function startSession(overrides?: StartOverrides) {
    if (!audioRef.current) return;

    const targetVoice = overrides?.voice ?? voice;
    const targetPersonaId = overrides?.personaId ?? personaId;
    const targetMode = overrides?.mode ?? mode;
    const targetPersona = getPersona(targetPersonaId);

    autoStartNextSessionRef.current = !!targetPersona.autoStart;
    setErrorMessage(undefined);
    setSession("connecting");

    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voice: targetVoice,
          personaId: targetPersonaId,
          instructions: targetPersona.instructions,
          mode: targetMode,
          language: targetPersona.language,
        }),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(err.message || err.error || `Session request failed (${res.status})`);
      }

      const sessionData = (await res.json()) as { ephemeralKey?: string; model?: string };

      const ephemeralKey = sessionData.ephemeralKey;
      if (!ephemeralKey) throw new Error("No ephemeral key returned from /api/session");
      const model = sessionData.model || "gpt-realtime-2";

      const client = createRealtimeClient();
      clientRef.current = client;
      const unsubscribe = client.on(handleEvent);
      if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
        (window as unknown as { __realtimeClient?: unknown }).__realtimeClient = client;
      }

      await client.connect({
        ephemeralKey,
        model,
        audioElement: audioRef.current,
        onLocalStream: (stream) => startMeter(stream),
      });

      startTimer();
      setSession("live");
      (client as RealtimeClient & { _unsub?: () => void })._unsub = unsubscribe;
    } catch (err) {
      console.error("[session] start failed", err);
      setErrorMessage(err instanceof Error ? err.message : "Failed to start session");
      setSession("error");
      await clientRef.current?.disconnect();
      clientRef.current = null;
      stopMeter();
    }
  }

  async function endSession(reason?: string) {
    if (session === "idle") return;
    setSession("ending");
    try {
      const client = clientRef.current as (RealtimeClient & { _unsub?: () => void }) | null;
      client?._unsub?.();
      await client?.disconnect();
    } catch (err) {
      console.warn("[session] disconnect failed", err);
    }
    clientRef.current = null;
    stopMeter();
    stopTimer();
    currentAssistantTurnIdRef.current = null;
    currentUserTurnIdRef.current = null;
    setPttActive(false);
    if (reason) {
      setErrorMessage(reason);
      setSession("error");
    } else {
      setSession("idle");
    }
  }

  function toggleSession() {
    if (session === "idle" || session === "error") {
      void startSession();
    } else if (session === "live") {
      void endSession();
    }
  }

  async function onPersonaChange(id: PersonaId) {
    if (id === personaId) return;
    const p = getPersona(id);
    setPersonaId(id);
    setVoice(p.defaultVoice);
    setTurns([]);
    if (session === "live") {
      await endSession();
      await startSession({ personaId: id, voice: p.defaultVoice });
    }
  }

  async function onVoiceChange(v: VoiceId) {
    if (v === voice) return;
    setVoice(v);
    setTurns([]);
    if (session === "live") {
      await endSession();
      await startSession({ voice: v });
    }
  }

  function onModeChange(m: "vad" | "ptt") {
    if (m === mode) return;
    setMode(m);
    if (session === "live" && clientRef.current) {
      clientRef.current.send({
        type: "session.update",
        session: {
          audio: {
            input: {
              turn_detection:
                m === "vad"
                  ? { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 }
                  : null,
            },
          },
        },
      });
    }
  }

  const pttDown = useCallback(() => {
    if (session !== "live" || mode !== "ptt" || !clientRef.current) return;
    setPttActive(true);
    clientRef.current.send({ type: "input_audio_buffer.clear" });
  }, [session, mode]);

  const pttUp = useCallback(() => {
    if (!pttActive || !clientRef.current) {
      setPttActive(false);
      return;
    }
    setPttActive(false);
    clientRef.current.send({ type: "input_audio_buffer.commit" });
    clientRef.current.send({ type: "response.create" });
  }, [pttActive]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.repeat) return;
      if (e.key === "Escape" && session === "live") {
        e.preventDefault();
        void endSession();
        return;
      }
      if (e.code === "Space" && session === "live" && mode === "ptt") {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        pttDown();
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space" && session === "live" && mode === "ptt") {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        pttUp();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [session, mode, pttDown, pttUp]);

  function copyTranscript() {
    const text = turns
      .map((t) => `${t.role === "user" ? "You" : "Assistant"}: ${t.text}${t.interrupted ? " [interrupted]" : ""}`)
      .join("\n\n");
    void navigator.clipboard.writeText(text);
  }

  function clearTranscript() {
    setTurns([]);
  }

  return (
    <div className={styles.wrap}>
      <Controls
        personaId={personaId}
        voice={voice}
        mode={mode}
        disabled={session === "connecting" || session === "ending"}
        onPersonaChange={onPersonaChange}
        onVoiceChange={onVoiceChange}
        onModeChange={onModeChange}
      />

      <Stage
        state={session}
        micLevel={micLevel}
        sessionSeconds={sessionSeconds}
        mode={mode}
        pttActive={pttActive}
        errorMessage={errorMessage}
        onToggle={toggleSession}
        onPttDown={pttDown}
        onPttUp={pttUp}
      />

      <Transcript turns={turns} onCopy={copyTranscript} onClear={clearTranscript} />

      <p className={styles.hint}>
        {mode === "ptt" ? (
          <>
            Hold <kbd>Space</kbd> to talk · <kbd>Esc</kbd> to end
          </>
        ) : (
          <>
            Speak naturally · <kbd>Esc</kbd> to end
          </>
        )}
      </p>

      <p className={styles.footer}>
        Audio is streamed directly to OpenAI. Not stored by this app.
      </p>

      <audio ref={audioRef} autoPlay playsInline hidden />
    </div>
  );
}
