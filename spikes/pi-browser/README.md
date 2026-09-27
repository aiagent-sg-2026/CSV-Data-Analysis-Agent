# Pi browser spike

This isolated page tests the official `@earendil-works/pi-agent-core` loop with a user-selected CSV in a browser. It does not modify the React application. Papa Parse reads a local file with a header row; Pi can inspect its schema and request filtered, grouped numeric aggregates. Live mode uses the Pi OpenAI provider with `gpt-5.4-mini` and medium reasoning.

## Run without a key

From this directory:

```sh
npm ci --ignore-scripts
npm run dev
```

Open the local Vite URL, choose a CSV file up to 10 MB, and select **Run mock tool cycle**. The deterministic mock inspects the schema, aggregates the first likely numeric column, and consumes both tool results through three Pi model turns. It does not answer the typed question. No backend or OpenAI request is used in mock mode. Node.js is used only for local development and bundling; the agent runs in the browser.

## Optional live request

Copy `.env.example` to `.env.local`, then put your own OpenAI API key in `VITE_OPENAI_API_KEY`. Restart Vite, choose a CSV, write a question that matches its columns, and select **Run live OpenAI**. Local `.env*` files are ignored by Git. The question, column names, and bounded aggregate results go to OpenAI; the CSV file and raw rows stay in the browser. The key is delivered to your local browser, as required by direct browser-to-OpenAI requests. Use this only on localhost; do not deploy a build containing a key. The build script refuses to run while a local key is configured.

The parser expects one header row and rejects malformed records. The 10 MB file limit and 30-group aggregate limit keep this in-memory spike bounded. It does not use the React app's full CSV intake, integrate with its state, or prove full feature parity. The repository's 83 MB HDB demo CSV exceeds this spike's limit; a smaller public subset can be used for this test.
