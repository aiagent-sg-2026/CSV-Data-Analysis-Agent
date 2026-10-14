/// <reference lib="webworker" />
import variant from '@jitl/quickjs-wasmfile-release-sync';
import wasmUrl from '@jitl/quickjs-wasmfile-release-sync/wasm?url';
import { newVariant, newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { executeQuickJsGuest } from '../sandbox/quickJsGuest';
import type { GuestOutcome, GuestRequest } from '../sandbox/javascriptGuestProtocol';

const worker = self as unknown as DedicatedWorkerGlobalScope;
let started = false;
worker.onmessage = async (event: MessageEvent<GuestRequest>) => {
    if (started) return;
    started = true;
    const request = event.data;
    let result: GuestOutcome;
    try {
        result = await executeQuickJsGuest(request, () => newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmLocation: wasmUrl })),
            () => worker.postMessage({ generation: request.generation, event: 'executing' }));
    } catch {
        result = { generation: request.generation, status: 'unavailable', code: 'guest_runtime_unavailable' };
    }
    worker.postMessage(result);
    worker.close();
};
