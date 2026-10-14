// @vitest-environment node
import { describe, it, expect } from 'vitest';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { executeQuickJsGuest } from '../services/sandbox/quickJsGuest';
import { resolveGuestLimits } from '../services/sandbox/javascriptGuestProtocol';
import { qualifySkills } from '../services/agent/skills/skillQualification';
import type { preparePiTask } from '../services/agent/runtime/pi/piCodingTask';
const guest = { run: (code, inputJson, options) => executeQuickJsGuest({ generation: 1, code, inputJson, limits: resolveGuestLimits(options.limits) }, () => newQuickJSWASMModuleFromVariant(variant), options.onStarted), cancel() { }, dispose() { } } satisfies NonNullable<Parameters<typeof preparePiTask>[3]>;
describe('pinned skills on the controlled executor', () => {
    it('runs actual Pi/helper/QuickJS dispatch and refuses authority expansion', async () => {
        const result = await qualifySkills(new AbortController().signal, undefined, guest);
        expect(result.checks.filter(c => !c.passed)).toEqual([]);
        expect(result.passed).toBe(true);
        expect(result.checks).toHaveLength(12);
    }, 30000);
});
