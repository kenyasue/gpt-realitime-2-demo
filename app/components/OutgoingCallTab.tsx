"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./IncomingCallTab.module.css";
import outgoingStyles from "./OutgoingCallTab.module.css";
import { PERSONAS, VOICES, getPersona, type PersonaId, type VoiceId } from "@/lib/personas";
import { Transcript, type Turn } from "./Transcript";
import { CallHistory } from "./CallHistory";

type CallState = "idle" | "waiting" | "ringing" | "connected" | "ending" | "ended" | "error";

const BRIDGE_URL = process.env.NEXT_PUBLIC_BRIDGE_URL || "http://localhost:5050";

const REARM_DELAY_MS = 600;

export function OutgoingCallTab() {
  const [personaId, setPersonaId] = useState<PersonaId>("assistant");
  const [voice, setVoice] = useState<VoiceId>(getPersona("assistant").defaultVoice);
  const [dialNumber, setDialNumber] = useState<string | null>(null);
  const [publicBridgeUrl, setPublicBridgeUrl] = useState<string | null>(null);
  const [twilioConfigured, setTwilioConfigured] = useState<boolean | null>(null);
  const [state, setState] = useState<CallState>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [armed, setArmed] = useState(false);
  const [callsCompleted, setCallsCompleted] = useState(0);

  const eventSourceRef = useRef<EventSource | null>(null);
  /** Mirrors `armed` so SSE handler closures can read the latest value. */
  const armedRef = useRef(false);
  /** Latest persona/voice so the re-arm uses the current selection. */
  const personaRef = useRef<PersonaId>(personaId);
  const voiceRef = useRef<VoiceId>(voice);

  useEffect(() => {
    armedRef.current = armed;
  }, [armed]);
  useEffect(() => {
    personaRef.current = personaId;
  }, [personaId]);
  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${BRIDGE_URL}/api/config`);
        if (!res.ok) throw new Error(`bridge returned ${res.status}`);
        const data = (await res.json()) as {
          twilioConfigured: boolean;
          fromNumber: string | null;
          publicBridgeUrl: string | null;
        };
        if (cancelled) return;
        setTwilioConfigured(data.twilioConfigured);
        setDialNumber(data.fromNumber);
        setPublicBridgeUrl(data.publicBridgeUrl);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Failed to load bridge config";
        setErrorMessage(
          msg.includes("Failed to fetch")
            ? `Cannot reach bridge at ${BRIDGE_URL}. Did you run \`npm run dev:bridge\`?`
            : msg,
        );
        setTwilioConfigured(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  /**
   * On mount, ask the bridge if there's already an armed / in-progress inbound
   * session (e.g. from a previous browser tab). If so, take it over instead of
   * starting fresh — the bridge is the source of truth.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${BRIDGE_URL}/api/incoming/state`);
        if (!res.ok) return;
        const data = (await res.json()) as {
          items: Array<{
            sessionId: string;
            personaId: PersonaId;
            voice: VoiceId;
            state: "waiting" | "ringing" | "connected";
          }>;
        };
        if (cancelled || data.items.length === 0) return;
        const item = data.items[0];
        setPersonaId(item.personaId);
        setVoice(item.voice);
        personaRef.current = item.personaId;
        voiceRef.current = item.voice;
        setSessionId(item.sessionId);
        setArmed(true);
        armedRef.current = true;
        setState(item.state);
        subscribeToEvents(item.sessionId);
      } catch (err) {
        console.warn("[outgoing] state restore failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const subscribeToEvents = useCallback((id: string) => {
    eventSourceRef.current?.close();
    const es = new EventSource(`${BRIDGE_URL}/events/${id}`);
    eventSourceRef.current = es;

    const onStatus = (evt: MessageEvent) => {
      try {
        const data = JSON.parse(evt.data) as { status: string; reason?: string; twilioStatus?: string };
        switch (data.status) {
          case "waiting":
            setState("waiting");
            break;
          case "ringing":
            setState("ringing");
            break;
          case "answered":
          case "connected":
            setState("connected");
            break;
          case "ended": {
            setState("ended");
            const wasArmed = armedRef.current;
            const benignReason =
              !data.reason ||
              data.reason === "user_ended" ||
              data.reason === "user_cancelled" ||
              data.reason === "twilio_stop" ||
              data.reason === "twilio_close" ||
              data.reason === "completed" ||
              data.reason === "expired_waiting_for_call";
            if (!benignReason) {
              setErrorMessage(
                `Call ended: ${data.reason}${data.twilioStatus ? ` (${data.twilioStatus})` : ""}`,
              );
            }
            // Only count completed calls (not pre-call expirations).
            if (data.reason !== "expired_waiting_for_call") {
              setCallsCompleted((c) => c + 1);
            }
            es.close();
            if (wasArmed) {
              // Auto-re-arm so the next caller can dial in.
              setTimeout(() => {
                if (armedRef.current) void prepareSession();
              }, REARM_DELAY_MS);
            }
            break;
          }
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

    const onRecordingSaved = () => setHistoryVersion((v) => v + 1);

    es.addEventListener("status", onStatus);
    es.addEventListener("user_transcript", onUserTranscript);
    es.addEventListener("assistant_started", onAssistantStarted);
    es.addEventListener("assistant_delta", onAssistantDelta);
    es.addEventListener("assistant_done", onAssistantDone);
    es.addEventListener("speech_started", onSpeechStarted);
    es.addEventListener("recording_saved", onRecordingSaved);
    es.addEventListener("error", onError);

    es.onerror = () => {
      console.warn("[outgoing] event stream error");
    };
  }, []);

  /** Post a new pending session and subscribe. Uses the latest persona/voice. */
  const prepareSession = useCallback(async () => {
    setErrorMessage(undefined);
    setTurns([]);
    setState("waiting");
    try {
      const res = await fetch(`${BRIDGE_URL}/api/incoming/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personaId: personaRef.current, voice: voiceRef.current }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(err.message || err.error || `Prepare failed (${res.status})`);
      }
      const data = (await res.json()) as { sessionId: string; dialNumber: string | null };
      setSessionId(data.sessionId);
      if (data.dialNumber) setDialNumber(data.dialNumber);
      subscribeToEvents(data.sessionId);
    } catch (err) {
      console.error("[outgoing] prepare failed", err);
      const message = err instanceof Error ? err.message : "Failed to prepare";
      setErrorMessage(
        message.includes("Failed to fetch")
          ? `Cannot reach bridge at ${BRIDGE_URL}. Did you run \`npm run dev:bridge\`?`
          : message,
      );
      setState("error");
      setArmed(false);
    }
  }, [subscribeToEvents]);

  async function openLine() {
    setCallsCompleted(0);
    setArmed(true);
    armedRef.current = true;
    await prepareSession();
  }

  async function closeLine() {
    setArmed(false);
    armedRef.current = false;
    // If we're idle/waiting (no active call), cancel the pending session right
    // away. If a call is in progress, let it finish; the auto-rearm guard will
    // not fire again because `armedRef.current` is now false.
    if (state === "waiting" && sessionId) {
      try {
        await fetch(`${BRIDGE_URL}/api/incoming/cancel/${sessionId}`, { method: "POST" });
      } catch (err) {
        console.warn("[outgoing] cancel failed", err);
      }
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      setState("idle");
      setSessionId(null);
    }
  }

  async function endCurrentCall() {
    if (!sessionId) return;
    setState("ending");
    try {
      await fetch(`${BRIDGE_URL}/api/end/${sessionId}`, { method: "POST" });
    } catch (err) {
      console.warn("[outgoing] hangup failed", err);
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

  const inCall =
    state === "ringing" || state === "connected" || state === "ending";

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
              disabled={armed}
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
              disabled={armed}
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

      <div className={outgoingStyles.dialBox}>
        <div className={outgoingStyles.dialHead}>
          <span className={styles.label}>Dial this number from your phone</span>
        </div>
        <div className={outgoingStyles.dialNumber}>
          {dialNumber ? (
            <a href={`tel:${dialNumber}`} className={outgoingStyles.dialLink}>
              {dialNumber}
            </a>
          ) : twilioConfigured === false ? (
            <span className={outgoingStyles.dialMissing}>
              Twilio not configured on the bridge
            </span>
          ) : (
            <span className={outgoingStyles.dialMissing}>Loading…</span>
          )}
        </div>
        <div className={outgoingStyles.actions}>
          {!armed && (
            <button
              type="button"
              className={`${styles.btn} ${styles.callBtn}`}
              onClick={openLine}
              disabled={!twilioConfigured || !dialNumber}
            >
              <BellIcon /> Open line
            </button>
          )}
          {armed && (
            <button
              type="button"
              className={`${styles.btn} ${styles.hangupBtn}`}
              onClick={closeLine}
            >
              Close line
            </button>
          )}
          {armed && inCall && (
            <button
              type="button"
              className={`${styles.btn} ${styles.hangupBtn}`}
              onClick={endCurrentCall}
              disabled={state === "ending"}
            >
              <HangupIcon /> Hang up
            </button>
          )}
        </div>
      </div>

      <div className={styles.status} data-state={mapStatusAttr(state)}>
        <span className={styles.dot} />
        <span>{describeState(state, armed)}</span>
        {armed && callsCompleted > 0 && (
          <span className={styles.sid}>
            {callsCompleted} call{callsCompleted === 1 ? "" : "s"} so far
          </span>
        )}
        {sessionId && !armed && <span className={styles.sid}>session {sessionId.slice(0, 8)}</span>}
      </div>

      {errorMessage && <div className={styles.error}>{errorMessage}</div>}

      <CallHistory bridgeUrl={BRIDGE_URL} refreshKey={historyVersion} />

      <Transcript turns={turns} onCopy={copyTranscript} onClear={clearTranscript} />

      <p className={styles.footnote}>
        Bridge: <code>{BRIDGE_URL}</code> · Configure your Twilio number&apos;s
        &quot;A Call Comes In&quot; webhook to{" "}
        <code>{(publicBridgeUrl ?? "<PUBLIC_BRIDGE_URL>") + "/twiml-incoming"}</code>.
      </p>
    </div>
  );
}

function mapStatusAttr(s: CallState): string {
  if (s === "waiting") return "dialing";
  return s;
}

function describeState(s: CallState, armed: boolean): string {
  switch (s) {
    case "idle":
      return "Idle — tap Open Line to start accepting calls";
    case "waiting":
      return armed
        ? "Line open — waiting for the next caller…"
        : "Waiting for your call…";
    case "ringing":
      return "Incoming call ringing…";
    case "connected":
      return "Connected — speak normally";
    case "ending":
      return "Hanging up…";
    case "ended":
      return armed ? "Call ended — re-arming for the next caller…" : "Call ended";
    case "error":
      return "Error";
  }
}

function BellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
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
