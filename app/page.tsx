import styles from "./page.module.css";

export default function Page() {
  return (
    <main className={styles.main}>
      <div className={styles.placeholder}>
        <h1 className={styles.title}>Voice Playground</h1>
        <p className={styles.subtitle}>
          gpt-realtime-2 demo · boilerplate scaffolded · UI coming next
        </p>
      </div>
    </main>
  );
}
