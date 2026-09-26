# Pi browser spike

This isolated page tests the official `@earendil-works/pi-agent-core` loop in a browser. It does not modify the React application. A mock provider requests the `summarize_rows` tool, receives its result, and produces a second-turn answer. Live mode uses the Pi OpenAI provider with `gpt-5.4-mini` and medium reasoning.

## Run without a key

From this directory:

```sh
npm ci --ignore-scripts
npm run dev
```

Open the local Vite URL and select **Run mock tool cycle**. The timeline should show a tool call, a tool result, and two model turns. No backend or OpenAI request is used in mock mode. Node.js is used only for local development and bundling; the agent runs in the browser.

## Optional live request

Copy `.env.example` to `.env.local`, then put your own OpenAI API key in `VITE_OPENAI_API_KEY`. Restart Vite and select **Run live OpenAI**. `.env.local` is ignored by Git. The key is still delivered to your local browser, as required by direct browser-to-OpenAI requests. Use this only on localhost; do not deploy a build containing a key. The build script refuses to run while a local key is configured.

The sample rows and `summarize_rows` are deliberately small. The spike tests browser compatibility and Pi tool-loop behavior; it does not integrate with React app state or prove full CSV feature parity.
