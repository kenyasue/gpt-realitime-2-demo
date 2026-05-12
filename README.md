# Voice Playground · gpt-realtime-2 demo

A minimal WebRTC demo for OpenAI's `gpt-realtime-2` model. Press one button, talk live with the assistant, switch personas on the fly.

> **Status:** boilerplate scaffolded. Feature implementation has not started yet — see [`doc/IMPLEMENTATION_PLAN.md`](./doc/IMPLEMENTATION_PLAN.md).

## Stack

- **Next.js 15** (App Router) — frontend + token-mint API route in one project
- **React 19** + **TypeScript**
- **Plain CSS Modules** (no Tailwind)
- **WebRTC** directly against the OpenAI Realtime API — no audio relay server

## Setup

```bash
npm install
cp .env.example .env.local       # then fill in OPENAI_API_KEY
npm run dev
```

Open <http://localhost:3000>.

## Layout

```
app/
  layout.tsx
  page.tsx              # Voice Playground UI (placeholder)
  page.module.css
  globals.css
  api/session/route.ts  # POST → ephemeral OpenAI token (not yet implemented)
lib/                    # Realtime client + persona presets (not yet implemented)
doc/
  PROPOSAL.md
  IMPLEMENTATION_PLAN.md
  ui-mockup.html
```

## Scripts

| Command            | What it does                  |
|--------------------|-------------------------------|
| `npm run dev`      | Next.js dev server (Turbopack)|
| `npm run build`    | Production build              |
| `npm run start`    | Run the production build      |
| `npm run type-check` | `tsc --noEmit`              |

## License

MIT
