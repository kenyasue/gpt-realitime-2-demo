"use client";

import { useEffect, useState } from "react";
import styles from "./Stage.module.css";

export type SessionState = "idle" | "connecting" | "live" | "ending" | "error";

interface StageProps {
  state: SessionState;
  micLevel: number;
  sessionSeconds: number;
  mode: "vad" | "ptt";
  pttActive: boolean;
  errorMessage?: string;
  onToggle: () => void;
  onPttDown?: () => void;
  onPttUp?: () => void;
}

function fmtTime(s: number) {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

const BAR_COUNT = 10;
const BAR_HEIGHTS = [30, 60, 90, 75, 50, 35, 65, 45, 20, 15];

export function Stage({
  state,
  micLevel,
  sessionSeconds,
  mode,
  pttActive,
  errorMessage,
  onToggle,
  onPttDown,
  onPttUp,
}: StageProps) {
  // animated bar levels — use the actual mic level as a multiplier
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (state !== "live") return;
    let raf = 0;
    const tick = () => {
      setPhase((p) => p + 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state]);

  const isLive = state === "live";
  const showMeter = isLive;

  let label = "Tap to start a conversation";
  let title = "Start talking";
  let pillText = "Idle";
  let pillDot: "idle" | "live" | "warn" = "idle";

  if (state === "connecting") {
    label = "Negotiating connection…";
    title = "Connecting";
    pillText = "Connecting…";
    pillDot = "warn";
  } else if (state === "live") {
    label = mode === "ptt"
      ? "Hold the orb (or Space) to talk"
      : "Just talk — tap the orb to end the session";
    title = "Listening…";
    pillText = `Connected · ${fmtTime(sessionSeconds)}`;
    pillDot = "live";
  } else if (state === "ending") {
    label = "Closing connection…";
    title = "Ending";
    pillText = "Ending…";
    pillDot = "warn";
  } else if (state === "error") {
    label = errorMessage || "Something went wrong";
    title = "Error";
    pillText = "Error";
    pillDot = "warn";
  }

  const pttMode = mode === "ptt" && isLive;

  return (
    <section className={styles.stage}>
      <div className={`${styles.pill} ${styles[`dot-${pillDot}`]}`}>
        <span className={styles.dot} />
        {pillText}
      </div>

      <button
        type="button"
        className={`${styles.micBtn} ${isLive ? styles.live : ""} ${pttMode && pttActive ? styles.pttHold : ""}`}
        onClick={pttMode ? undefined : onToggle}
        onPointerDown={pttMode ? onPttDown : undefined}
        onPointerUp={pttMode ? onPttUp : undefined}
        onPointerLeave={pttMode && pttActive ? onPttUp : undefined}
        aria-label={isLive ? "End session" : "Start talking"}
        disabled={state === "connecting" || state === "ending"}
      >
        {isLive && <span className={styles.micRing} aria-hidden />}
        <svg className={styles.micSvg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="9" y="3" width="6" height="12" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0" />
          <line x1="12" y1="18" x2="12" y2="22" />
        </svg>
      </button>

      <div className={styles.stageLabel}>
        <h2>{title}</h2>
        <p>{label}</p>
      </div>

      {showMeter && (
        <div className={`${styles.meter} ${styles.active}`} aria-hidden>
          {Array.from({ length: BAR_COUNT }, (_, i) => {
            const base = BAR_HEIGHTS[i] ?? 50;
            // small wave so it animates even when the user is silent
            const wave = 4 + 6 * Math.sin((phase / 6) + i * 0.7);
            const level = Math.min(1, micLevel + wave / 100);
            const height = Math.max(8, Math.round(base * (0.25 + 0.75 * level)));
            return <span key={i} style={{ height: `${height}%` }} />;
          })}
        </div>
      )}
    </section>
  );
}
