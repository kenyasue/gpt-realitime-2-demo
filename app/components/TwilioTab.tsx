"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./TwilioTab.module.css";
import { PERSONAS, VOICES, getPersona, type PersonaId, type VoiceId } from "@/lib/personas";
import { Transcript, type Turn } from "./Transcript";

type CallState = "idle" | "dialing" | "ringing" | "connected" | "ending" | "ended" | "error";

const BRIDGE_URL = process.env.NEXT_PUBLIC_BRIDGE_URL || "http://localhost:5050";

export function TwilioTab() {
  const [personaId, setPersonaId] = useState<PersonaId>("assistant");
  const [voice, setVoice] = useState<VoiceId>(getPersona("assistant").defaultVoice);
  const [phone, setPhone] = useState("");
  const [state, setState] = useState<CallState>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [turns, setTurns] = useState<Turn[]>([]);

  const eventSourceRef = useRef<EventSource | null>(null);

  /* Cleanup on unmount */
  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  function onPersonaChange(id: PersonaId) {
    if (id === personaId) return;
    const p = getPersona(id);
    setPersonaId(id);
    setVoice(p.defaultVoice);
    setTurns([]);
  }

  function onVoiceChange(v: VoiceId) {
    if (v === voice) return;
    setVoice(v);
    setTurns([]);
  }

  function isValidE164(num: string) {
    return /^\+\d{6,15}$/.test(num.trim());
  }

  const subscribeToEvents = useCallback((id: string) => {
    eventSourceRef.current?.close();
    const es = new EventSource(`${BRIDGE_URL}/events/${id}`);
    eventSourceRef.current = es;

    const onStatus = (evt: MessageEvent) => {
      try {
        const data = JSON.parse(evt.data) as { status: string; reason?: string; twilioStatus?: string };
        switch (data.status) {
          case "dialing":
            setState("dialing");
            break;
          case "ringing":
            setState("ringing");
            break;
          case "answered":
          case "connected":
            setState("connected");
            break;
          case "ended":
            setState((prev) => (prev === "ending" ? "ended" : "ended"));
            if (data.reason && data.reason !== "user_ended") {
              setErrorMessage(`Call ended: ${data.reason}${data.twilioStatus ? ` (${data.twilioStatus})` : ""}`);
            }
            es.close();
            break;
        }
      } catch {
        /* noop */
      }
    };

    const onUserTranscript = (evt: MessageEvent) => {
      try {
        const data = JSON.parse(evt.data) as { id: string; text: string };
        setTurns((prev) => {
          if (prev.some((t) => t.id === data.id)) {
            return prev.map((t) => (t.id === data.id ? { ...t, text: data.text, final: true } : t));
          }
          return [...prev, { id: data.id, role: "user", text: data.text, final: true }];
        });
      } catch {
        /* noop */
      }
    };

    const onAssistantStarted = (evt: MessageEvent) => {
      try {
        const data = JSON.parse(evt.data) as { id: string };
        setTurns((prev) => {
          if (prev.some((t) => t.id === data.id)) return prev;
          return [...prev, { id: data.id, role: "assistant", text: "", final: false }];
        });
      } catch {
        /* noop */
      }
    };

    const onAssistantDelta = (evt: MessageEvent) => {
      try {
        const data = JSON.parse(evt.data) as { id: string; delta: string };
        setTurns((prev) =>
          prev.map((t) => (t.id === data.id ? { ...t, text: t.text + data.delta } : t)),
        );
      } catch {
        /* noop */
      }
    };

    const onAssistantDone = (evt: MessageEvent) => {
      try {
        const data = JSON.parse(evt.data) as { id: string; text: string };
        setTurns((prev) =>
          prev.map((t) => (t.id === data.id ? { ...t, text: data.text, final: true } : t)),
        );
      } catch {
        /* noop */
      }
    };

    const onSpeechStarted = () => {
      // Mark the currently-playing assistant turn as interrupted.
      setTurns((prev) =>
        prev.map((t) =>
          t.role === "assistant" && !t.final ? { ...t, interrupted: true } : t,
        ),
      );
    };

    const onError = (evt: MessageEvent) => {
      try {
        const data = JSON.parse(evt.data) as { message: string };
        setErrorMessage(data.message);
      } catch {
        /* noop */
      }
    };

    es.addEventListener("status", onStatus);
    es.addEventListener("user_transcript", onUserTranscript);
    es.addEventListener("assistant_started", onAssistantStarted);
    es.addEventListener("assistant_delta", onAssistantDelta);
    es.addEventListener("assistant_done", onAssistantDone);
    es.addEventListener("speech_started", onSpeechStarted);
    es.addEventListener("error", onError);

    es.onerror = () => {
      // EventSource will auto-reconnect; only surface if we never got a status.
      console.warn("[twilio] event stream error");
    };
  }, []);

  async function startCall() {
    if (!isValidE164(phone)) {
      setErrorMessage("Please enter a phone number in E.164 format, e.g. +14155550123");
      return;
    }
    setErrorMessage(undefined);
    setTurns([]);
    setState("dialing");

    try {
      const res = await fetch(`${BRIDGE_URL}/api/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: phone.trim(), personaId, voice }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(err.message || err.error || `Call request failed (${res.status})`);
      }
      const data = (await res.json()) as { sessionId: string; callSid: string };
      setSessionId(data.sessionId);
      subscribeToEvents(data.sessionId);
    } catch (err) {
      console.error("[twilio] startCall failed", err);
      const message = err instanceof Error ? err.message : "Failed to place call";
      setErrorMessage(
        message.includes("Failed to fetch")
          ? `Cannot reach bridge at ${BRIDGE_URL}. Did you run \`npm run dev:bridge\`?`
          : message,
      );
      setState("error");
    }
  }

  async function endCall() {
    if (!sessionId) return;
    setState("ending");
    try {
      await fetch(`${BRIDGE_URL}/api/end/${sessionId}`, { method: "POST" });
    } catch (err) {
      console.warn("[twilio] hangup failed", err);
    }
  }

  function copyTranscript() {
    const text = turns
      .map((t) => `${t.role === "user" ? "Caller" : "Assistant"}: ${t.text}${t.interrupted ? " [interrupted]" : ""}`)
      .join("\n\n");
    void navigator.clipboard.writeText(text);
  }

  function clearTranscript() {
    setTurns([]);
  }

  function reset() {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setSessionId(null);
    setState("idle");
    setErrorMessage(undefined);
  }

  const inCall = state === "dialing" || state === "ringing" || state === "connected" || state === "ending";

  return (
    <div className={styles.wrap}>
      <div className={styles.row}>
        <label className={styles.control}>
          <span className={styles.label}>Persona</span>
          <div className={styles.selectWrap}>
            <select
              className={styles.select}
              value={personaId}
              onChange={(e) => onPersonaChange(e.target.value as PersonaId)}
              disabled={inCall}
              aria-label="Persona"
            >
              {PERSONAS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <svg className={styles.chev} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
        </label>

        <label className={styles.control}>
          <span className={styles.label}>Voice</span>
          <div className={styles.selectWrap}>
            <select
              className={styles.select}
              value={voice}
              onChange={(e) => onVoiceChange(e.target.value as VoiceId)}
              disabled={inCall}
              aria-label="Voice"
            >
              {VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
            <svg className={styles.chev} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
        </label>
      </div>

      <div className={styles.dialer}>
        <label className={styles.phoneLabel}>
          <span className={styles.label}>Destination number (E.164)</span>
          <input
            type="tel"
            className={styles.phoneInput}
            placeholder="+14155550123"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            disabled={inCall}
            inputMode="tel"
            autoComplete="tel"
          />
        </label>

        {!inCall && state !== "ended" && (
          <button
            type="button"
            className={`${styles.btn} ${styles.callBtn}`}
            onClick={startCall}
            disabled={!isValidE164(phone)}
          >
            <PhoneIcon /> Call
          </button>
        )}

        {inCall && (
          <button
            type="button"
            className={`${styles.btn} ${styles.hangupBtn}`}
            onClick={endCall}
            disabled={state === "ending"}
          >
            <HangupIcon /> Hang up
          </button>
        )}

        {state === "ended" && (
          <button type="button" className={`${styles.btn} ${styles.callBtn}`} onClick={reset}>
            New call
          </button>
        )}
      </div>

      <div className={styles.status} data-state={state}>
        <span className={styles.dot} />
        <span>{describeState(state)}</span>
        {sessionId && <span className={styles.sid}>session {sessionId.slice(0, 8)}</span>}
      </div>

      {errorMessage && <div className={styles.error}>{errorMessage}</div>}

      <Transcript turns={turns} onCopy={copyTranscript} onClear={clearTranscript} />

      <p className={styles.footnote}>
        Bridge: <code>{BRIDGE_URL}</code> · Audio streams between Twilio and
        OpenAI via this bridge — not stored by this app.
      </p>
    </div>
  );
}

function describeState(s: CallState): string {
  switch (s) {
    case "idle":
      return "Idle — enter a number and tap Call";
    case "dialing":
      return "Dialing…";
    case "ringing":
      return "Ringing…";
    case "connected":
      return "Connected — speak normally";
    case "ending":
      return "Hanging up…";
    case "ended":
      return "Call ended";
    case "error":
      return "Error";
  }
}

function PhoneIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

function HangupIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z" transform="rotate(135 12 12)" />
    </svg>
  );
}
