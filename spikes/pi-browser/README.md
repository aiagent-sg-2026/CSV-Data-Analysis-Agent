# Pi browser spike

This isolated page tests the official `@earendil-works/pi-agent-core` loop with a user-selected CSV in a browser. It does not modify the React application. Papa Parse scans a local file in 2 MB chunks; Pi can inspect its schema and request filtered, grouped numeric aggregates. Live mode uses the Pi OpenAI provider with `gpt-5.4-mini` and medium reasoning.

## Run without a key

From this directory:

```sh
npm ci --ignore-scripts
npm run dev
```

Open the local Vite URL, choose a CSV file up to 128 MB, and select **Run mock tool cycle**. The deterministic mock inspects the schema, aggregates a numeric column named in the question (or the first likely numeric column), and consumes both tool results through three Pi model turns. It does not answer the typed question. No backend or OpenAI request is used in mock mode. Node.js is used only for local development and bundling; the agent runs in the browser.

## Optional live request

Copy `.env.example` to `.env.local`, then put your own OpenAI API key in `VITE_OPENAI_API_KEY`. Restart Vite, choose a CSV, write a question that matches its columns, and select **Run live OpenAI**. Local `.env*` files are ignored by Git. The question, column names, and bounded aggregate results go to OpenAI; the CSV file and raw rows stay in the browser. The key is delivered to your local browser, as required by direct browser-to-OpenAI requests. Use this only on localhost; do not deploy a build containing a key. The build script refuses to run while a local key is configured.

The parser expects one header row and rejects malformed records. The file stays in the browser: the initial scan retains only schema, row count, and up to 200 sample rows. Each aggregate tool call scans the file again, trading repeated I/O for bounded memory. The 128 MB file limit and 30-group output limit bound this spike. Sums use compensated floating-point addition; this is not an accounting decimal engine. The repository's 83 MB HDB demo CSV can be tested directly. This does not use the React app's full CSV intake, integrate with its state, or prove full feature parity.
