import styles from "./Header.module.css";

export function Header() {
  return (
    <header className={styles.top}>
      <div className={styles.brand}>
        <div className={styles.logo} aria-hidden>
          V
        </div>
        <h1 className={styles.title}>Voice Playground</h1>
        <span className={styles.tag}>gpt-realtime-2</span>
      </div>
      <div className={styles.right}>
        <a
          className={styles.iconBtn}
          href="https://platform.openai.com/docs/guides/realtime"
          target="_blank"
          rel="noreferrer"
          aria-label="OpenAI Realtime docs"
          title="OpenAI Realtime docs"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </a>
      </div>
    </header>
  );
}
