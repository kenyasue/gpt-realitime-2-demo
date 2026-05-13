"use client";

import { useState } from "react";
import styles from "./page.module.css";
import { Header } from "./components/Header";
import { Tabs, type TabId } from "./components/Tabs";
import { WebTab } from "./components/WebTab";
import { IncomingCallTab } from "./components/IncomingCallTab";
import { OutgoingCallTab } from "./components/OutgoingCallTab";

export default function Page() {
  const [tab, setTab] = useState<TabId>("home");

  return (
    <main className={styles.app}>
      <Header />
      <Tabs active={tab} onChange={setTab} />
      {tab === "home" && <WebTab />}
      {tab === "incoming" && <IncomingCallTab />}
      {tab === "outgoing" && <OutgoingCallTab />}
    </main>
  );
}
