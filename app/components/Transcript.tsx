"use client";

import { useEffect, useRef } from "react";
import styles from "./Transcript.module.css";

export interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
  interrupted?: boolean;
}

interface TranscriptProps {
  turns: Turn[];
  onCopy: () => void;
  onClear: () => void;
}

export function Transcript({ turns, onCopy, onClear }: TranscriptProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns]);

  return (
    <section className={styles.transcript}>
      <div className={styles.head}>
        <h3>Transcript</h3>
        <div className={styles.actions}>
          <button type="button" className={styles.btn} onClick={onCopy} disabled={turns.length === 0}>
            Copy
          </button>
          <button type="button" className={styles.btn} onClick={onClear} disabled={turns.length === 0}>
            Clear
          </button>
        </div>
      </div>
      <div ref={bodyRef} className={styles.body}>
        {turns.length === 0 ? (
          <div className={styles.empty}>The conversation transcript will appear here.</div>
        ) : (
          turns.map((t) => (
            <div key={t.id} className={`${styles.msg} ${styles[t.role]}`}>
              <div className={styles.who}>{t.role === "user" ? "You" : "Assistant"}</div>
              <div className={styles.text}>
                {t.text || (t.final ? <span className={styles.silent}>(silence)</span> : null)}
                {!t.final && <span className={styles.caret} aria-hidden />}
                {t.interrupted && (
                  <div className={styles.interrupt}>interrupted</div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
