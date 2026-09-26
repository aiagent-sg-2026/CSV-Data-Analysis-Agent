# Pi Browser Spike Context

## 2026-09-27 request and direction

- The user decided to keep the React application and assigned Vanilla removal to another AI agent. This spike is isolated from that cleanup and changes no React application or `original/` files.
- The user requested a browser-first Pi harness test, an `.env.example` for a key they will provide later, and `gpt-5.4-mini` with medium reasoning as defaults.
- The product requirement is no Node.js application server. This spike uses Node/Vite only to install and bundle browser JavaScript; the built page was served by Python static HTTP during verification.

## Completed steps

1. Created an isolated worktree and nested `spikes/pi-browser/` application.
2. Installed official `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` version 0.87.1. The Pi model catalog resolves `openai/gpt-5.4-mini` with reasoning support; the Agent state requests `medium`.
3. Added a browser-safe `summarize_rows` tool. A deterministic mock provider makes Pi call it, passes the result back through the real agent loop, and produces a second-turn answer. Live mode uses the Pi OpenAI provider when a user key is supplied locally.
4. Added `.env.example`, ignored `.env.local`, localhost-only live mode, and a build guard that refuses to bundle a configured key.
5. Verified `npm ci`, focused test, Vite build, dependency audit, build-key refusal, and the built page running from static HTTP in a real browser. Browser mock timeline showed two model turns, one tool result, and `sum=250`; browser console had no errors.

## Remaining verification and constraints

- A real OpenAI API call was not run because no key is available yet. The user will add their key to `.env.local` and run local development mode for this check.
- This is a harness feasibility spike. It does not connect Pi to the React application's CSV state, history, or existing tool registry.
- Browser-direct API use exposes a user-supplied key to that browser. Never deploy a client bundle with a key; a product-owned hidden key would require a proxy.
