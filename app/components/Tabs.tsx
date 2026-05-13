"use client";

import styles from "./Tabs.module.css";

export type TabId = "home" | "incoming" | "outgoing";

interface TabsProps {
  active: TabId;
  onChange: (id: TabId) => void;
}

const TABS: { id: TabId; label: string; sublabel: string }[] = [
  { id: "home", label: "Home", sublabel: "Browser · WebRTC" },
  { id: "incoming", label: "Incoming Call", sublabel: "Server dials you" },
  { id: "outgoing", label: "Outgoing Call", sublabel: "You dial Twilio" },
];

export function Tabs({ active, onChange }: TabsProps) {
  return (
    <nav className={styles.tabs} role="tablist" aria-label="Demo mode">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          className={`${styles.tab} ${active === t.id ? styles.active : ""}`}
          onClick={() => onChange(t.id)}
        >
          <span className={styles.label}>{t.label}</span>
          <span className={styles.sublabel}>{t.sublabel}</span>
        </button>
      ))}
    </nav>
  );
}
