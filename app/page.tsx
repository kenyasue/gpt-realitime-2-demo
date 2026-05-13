"use client";

import { useState } from "react";
import styles from "./page.module.css";
import { Header } from "./components/Header";
import { Tabs, type TabId } from "./components/Tabs";
import { WebTab } from "./components/WebTab";
import { TwilioTab } from "./components/TwilioTab";

export default function Page() {
  const [tab, setTab] = useState<TabId>("home");

  return (
    <main className={styles.app}>
      <Header />
      <Tabs active={tab} onChange={setTab} />
      {tab === "home" ? <WebTab /> : <TwilioTab />}
    </main>
  );
}
