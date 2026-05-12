"use client";

import { PERSONAS, VOICES, type PersonaId, type VoiceId } from "@/lib/personas";
import styles from "./Controls.module.css";

interface ControlsProps {
  personaId: PersonaId;
  voice: VoiceId;
  mode: "vad" | "ptt";
  disabled: boolean;
  onPersonaChange: (id: PersonaId) => void;
  onVoiceChange: (id: VoiceId) => void;
  onModeChange: (mode: "vad" | "ptt") => void;
}

export function Controls({
  personaId,
  voice,
  mode,
  disabled,
  onPersonaChange,
  onVoiceChange,
  onModeChange,
}: ControlsProps) {
  return (
    <div className={styles.controls}>
      <label className={styles.control}>
        <span className={styles.label}>Persona</span>
        <div className={styles.selectWrap}>
          <select
            className={styles.select}
            value={personaId}
            onChange={(e) => onPersonaChange(e.target.value as PersonaId)}
            disabled={disabled}
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
            disabled={disabled}
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

      <div className={styles.modeToggle} role="tablist" aria-label="Turn detection mode">
        <button
          type="button"
          className={mode === "vad" ? styles.active : ""}
          onClick={() => onModeChange("vad")}
          role="tab"
          aria-selected={mode === "vad"}
          disabled={disabled}
        >
          Auto VAD
        </button>
        <button
          type="button"
          className={mode === "ptt" ? styles.active : ""}
          onClick={() => onModeChange("ptt")}
          role="tab"
          aria-selected={mode === "ptt"}
          disabled={disabled}
        >
          Push-to-talk
        </button>
      </div>
    </div>
  );
}
