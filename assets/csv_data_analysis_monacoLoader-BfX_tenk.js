const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./csv_data_analysis_vendor-storage-Dda2oZrY.js","./csv_data_analysis_vendor-data-CIO9Xlwr.js","./csv_data_analysis_vendor-react-core-DlbdMisc.js","./csv_data_analysis_vendor-ai-sdk-Ckh0jYjM.js","./csv_data_analysis_vendor-ai-google-Bz8kFxpl.js","./csv_data_analysis_vendor-ai-openai--ddZFqjw.js"])))=>i.map(i=>d[i]);
import { q as __vitePreload } from "./csv_data_analysis_app-agent-DrJ_9197.js";
import "./csv_data_analysis_vendor-storage-Dda2oZrY.js";
import "./csv_data_analysis_vendor-data-CIO9Xlwr.js";
import "./csv_data_analysis_vendor-react-core-DlbdMisc.js";
import "./csv_data_analysis_vendor-ai-sdk-Ckh0jYjM.js";
import "./csv_data_analysis_vendor-ai-google-Bz8kFxpl.js";
import "./csv_data_analysis_vendor-ai-openai--ddZFqjw.js";
let configured = false;
async function ensureMonacoConfigured() {
  if (configured) return;
  const [
    { loader },
    monaco,
    editorWorkerMod,
    jsonWorkerMod,
    cssWorkerMod,
    htmlWorkerMod,
    tsWorkerMod
  ] = await Promise.all([
    __vitePreload(() => import("./csv_data_analysis_vendor-react-core-DlbdMisc.js").then((n) => n.i), true ? [] : void 0, import.meta.url),
    __vitePreload(() => import("./csv_data_analysis_vendor-monaco-BxMSuHbY.js").then((n) => n.i), true ? __vite__mapDeps([0,1,2,3,4,5]) : void 0, import.meta.url),
    __vitePreload(() => import("./csv_data_analysis_vendor-monaco-BxMSuHbY.js").then((n) => n.e), true ? __vite__mapDeps([0,1,2,3,4,5]) : void 0, import.meta.url),
    __vitePreload(() => import("./csv_data_analysis_vendor-monaco-BxMSuHbY.js").then((n) => n.j), true ? __vite__mapDeps([0,1,2,3,4,5]) : void 0, import.meta.url),
    __vitePreload(() => import("./csv_data_analysis_vendor-monaco-BxMSuHbY.js").then((n) => n.c), true ? __vite__mapDeps([0,1,2,3,4,5]) : void 0, import.meta.url),
    __vitePreload(() => import("./csv_data_analysis_vendor-monaco-BxMSuHbY.js").then((n) => n.h), true ? __vite__mapDeps([0,1,2,3,4,5]) : void 0, import.meta.url),
    __vitePreload(() => import("./csv_data_analysis_vendor-monaco-BxMSuHbY.js").then((n) => n.t), true ? __vite__mapDeps([0,1,2,3,4,5]) : void 0, import.meta.url)
  ]);
  const EditorWorker = editorWorkerMod.default;
  const JsonWorker = jsonWorkerMod.default;
  const CssWorker = cssWorkerMod.default;
  const HtmlWorker = htmlWorkerMod.default;
  const TsWorker = tsWorkerMod.default;
  const localMonacoEnvironment = {
    getWorker(_workerId, label) {
      if (label === "json") return new JsonWorker();
      if (label === "css" || label === "scss" || label === "less") return new CssWorker();
      if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
      if (label === "typescript" || label === "javascript") return new TsWorker();
      return new EditorWorker();
    }
  };
  const monacoGlobal = self;
  monacoGlobal.MonacoEnvironment = localMonacoEnvironment;
  loader.config({ monaco });
  configured = true;
}
export {
  ensureMonacoConfigured
};
