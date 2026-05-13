// PM2 process manifest for the gpt-realtime-2 demo.
//
// Usage:
//   npm run build                # build Next.js
//   pm2 start ecosystem.config.cjs
//   pm2 logs                     # tail both processes
//   pm2 save                     # persist for boot
//   pm2 startup                  # generate the boot script (Linux/macOS)
//
// Both processes read `.env` / `.env.local` from the cwd, so make sure the
// Twilio + OpenAI vars are present there before `pm2 start`. PM2 itself does
// not load .env files — Next.js and dotenv inside the bridge do.

module.exports = {
  apps: [
    {
      name: "gpt-realtime-2-demo",
      // Call the Next.js binary directly. Avoids the npm-shim layer so PM2
      // gets correct SIGINT/SIGTERM propagation on restart.
      script: "node_modules/next/dist/bin/next",
      args: "start -p 8081",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "512M",
      env: { NODE_ENV: "production" },
      out_file: "./logs/web.out.log",
      error_file: "./logs/web.err.log",
      merge_logs: true,
      time: true,
    },
    {
      name: "gpt-realtime-2-demo-bridge",
      // Run the TypeScript bridge directly via tsx — no separate build step.
      script: "node_modules/tsx/dist/cli.mjs",
      args: "bridge/server.ts",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "512M",
      // The bridge holds per-call session state in memory, so do NOT cluster
      // it. A second instance would split sessions and break SSE/WS routing.
      env: { NODE_ENV: "production" },
      out_file: "./logs/bridge.out.log",
      error_file: "./logs/bridge.err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
