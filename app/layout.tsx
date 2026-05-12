import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Voice Playground · gpt-realtime-2",
  description:
    "A simple WebRTC demo for OpenAI's gpt-realtime-2 model. One click to talk, switch personas on the fly.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
