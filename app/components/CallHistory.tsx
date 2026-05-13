"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./CallHistory.module.css";

interface SessionMeta {
  id: string;
  startedAt: string;
  endedAt?: string;
  callSid?: string;
  to?: string;
  personaId: string;
  personaLabel?: string;
  voice: string;
  endReason?: string;
  hasAudio: boolean;
  durationSec: number;
  userTurns: number;
  assistantTurns: number;
}

interface RecordedTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
  interrupted?: boolean;
}

interface CallHistoryProps {
  bridgeUrl: string;
  /** Bump this number to force a refresh of the list. */
  refreshKey: number;
}

export function CallHistory({ bridgeUrl, refreshKey }: CallHistoryProps) {
  const [items, setItems] = useState<SessionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, RecordedTurn[]>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`${bridgeUrl}/api/sessions`);
      if (!res.ok) throw new Error(`bridge returned ${res.status}`);
      const data = (await res.json()) as { items: SessionMeta[] };
      setItems(data.items);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load history";
      setLoadError(msg.includes("Failed to fetch") ? `Cannot reach bridge at ${bridgeUrl}` : msg);
    } finally {
      setLoading(false);
    }
  }, [bridgeUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  async function toggleExpand(id: string) {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!details[id]) {
      try {
        const res = await fetch(`${bridgeUrl}/api/sessions/${id}`);
        if (res.ok) {
          const data = (await res.json()) as { turns: RecordedTurn[] };
          setDetails((prev) => ({ ...prev, [id]: data.turns }));
        }
      } catch {
        /* noop */
      }
    }
  }

  async function deleteSession(id: string) {
    if (!confirm("Delete this recording and transcript?")) return;
    try {
      await fetch(`${bridgeUrl}/api/sessions/${id}`, { method: "DELETE" });
      if (expanded === id) setExpanded(null);
      setItems((prev) => prev.filter((s) => s.id !== id));
      setDetails((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch {
      /* noop */
    }
  }

  return (
    <section className={styles.history}>
      <div className={styles.head}>
        <h3>History</h3>
        <div className={styles.actions}>
          <span className={styles.count}>
            {loading ? "loading…" : `${items.length} session${items.length === 1 ? "" : "s"}`}
          </span>
          <button type="button" className={styles.btn} onClick={() => void refresh()} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>
      <div className={styles.body}>
        {loadError && <div className={styles.err}>{loadError}</div>}
        {!loadError && items.length === 0 && !loading && (
          <div className={styles.empty}>No past calls yet. Make a call and the recording will show up here.</div>
        )}
        {items.map((s) => {
          const isOpen = expanded === s.id;
          const turns = details[s.id];
          return (
            <div key={s.id} className={`${styles.row} ${isOpen ? styles.open : ""}`}>
              <button
                type="button"
                className={styles.rowHead}
                onClick={() => void toggleExpand(s.id)}
                aria-expanded={isOpen}
              >
                <span className={styles.when}>{formatTimestamp(s.startedAt)}</span>
                <span className={styles.to}>{s.to ?? "—"}</span>
                <span className={styles.persona}>{s.personaLabel ?? s.personaId}</span>
                <span className={styles.dur}>{formatDuration(s.durationSec)}</span>
                <svg
                  className={`${styles.chev} ${isOpen ? styles.chevOpen : ""}`}
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {isOpen && (
                <div className={styles.detail}>
                  <div className={styles.players}>
                    <AudioLeg
                      label="Call recording"
                      bridgeUrl={bridgeUrl}
                      sessionId={s.id}
                      available={s.hasAudio}
                    />
                  </div>
                  <div className={styles.turnsLabel}>Transcript</div>
                  <div className={styles.turns}>
                    {turns === undefined ? (
                      <div className={styles.empty}>Loading…</div>
                    ) : turns.length === 0 ? (
                      <div className={styles.empty}>No transcript captured.</div>
                    ) : (
                      turns.map((t) => (
                        <div key={t.id} className={`${styles.msg} ${styles[t.role]}`}>
                          <div className={styles.who}>{t.role === "user" ? "Caller" : "Assistant"}</div>
                          <div className={styles.text}>
                            {t.text || <span className={styles.silent}>(silence)</span>}
                            {t.interrupted && <span className={styles.interrupt}>interrupted</span>}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                  <div className={styles.footRow}>
                    <span className={styles.endReason}>
                      {s.endReason ? `Ended: ${s.endReason}` : ""}
                    </span>
                    <button type="button" className={styles.dangerBtn} onClick={() => void deleteSession(s.id)}>
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AudioLeg({
  label,
  bridgeUrl,
  sessionId,
  available,
}: {
  label: string;
  bridgeUrl: string;
  sessionId: string;
  available: boolean;
}) {
  const playUrl = `${bridgeUrl}/api/sessions/${sessionId}/audio`;
  const downloadUrl = `${playUrl}?download=1`;
  return (
    <div className={styles.player}>
      <div className={styles.playerHead}>
        <span className={styles.playerLabel}>{label}</span>
        {available ? (
          <a className={styles.dlLink} href={downloadUrl}>
            Download
          </a>
        ) : (
          <span className={styles.dlLinkDisabled}>No audio</span>
        )}
      </div>
      {available ? (
        <audio className={styles.audio} controls preload="none" src={playUrl} />
      ) : (
        <div className={styles.audioPlaceholder}>—</div>
      )}
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(sec: number): string {
  if (!sec || sec < 0) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
