import type { ToolManifest } from '../../../../types';
import { validateCodeRunRequest } from '../../execution/codeExecutionContract';

const artifact = { type: 'object', additionalProperties: false, required: ['path', 'revision', 'sha256'], properties: {
    path: { type: 'string', maxLength: 240 }, revision: { type: 'integer', minimum: 1 }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
} };
const jobSchema = (required: boolean) => ({ type: 'object', additionalProperties: false, required: required ? ['jobId'] : [],
    properties: { jobId: { type: 'string', maxLength: 80 } } });
export const createCodeToolManifests = (): ToolManifest[] => (['code.run', 'code.inspect', 'code.cancel'] as const).map(name => ({
    name, category: 'workspace', risk: name === 'code.run' ? 'high' : 'low', enabledByDefault: true,
    groups: [name === 'code.run' ? 'code.execute' : 'code.inspect'],
    requiresCleaningCompleted: false,
    description: name === 'code.run' ? 'Execute an immutable JavaScript function body over exact artifacts or complete current tables in bounded QuickJS workers. Supports whole_table and explicit stateful_stream; stage one artifact.'
        : name === 'code.inspect' ? 'Inspect owned execution receipts or list the last 20 jobs.' : 'Cancel an exact owned job. Inspect again for its terminal outcome.',
    promptHints: name === 'code.run' ? [
        'Execution precondition: FIRST create a real program with workspace_write (or inspect an existing immutable program). END that assistant turn and WAIT for its tool result. In a later turn COPY the exact artifact path, revision and SHA-256 returned by that successful call into program. Never batch workspace_write and code_run in one response: the hash is not yet available. Never invent a path/revision/hash, REPLACE placeholder or all-zero hash. Only then invoke code_run. A computation completes only after computation_validate accepts its actual returned jobId.',
        'Program content is the BODY of a synchronous JavaScript function with exactly one parameter named input. Use a top-level return. Do not use module.exports, exports, export default, a standalone main function, or globals named tables/rows; none exists. A table binding {name:"facts",tableId} exposes input.facts.rows and input.facts.columns. inputs is always required: send inputs:[] when using only tables. The table rows are supplied by the host, not embedded or fabricated in program source.',
        'Requires a host-issued task grant. Use current program/input path, revision and SHA-256 references. input[name].content contains immutable workspace text; source inputs contain bounded original bytes. tables:[{name,tableId}] supplies input[name].rows from the complete current table. Arbitrary code defaults to whole_table. Backed previews, unsupported row_map and over-capacity inputs are refused without sampling.',
        'stateful_stream requires stream:{table,batchRows,partitionBy,initialState} and JSON output. Each step runs in a fresh guest; return exactly {state:JSON,rows:JSON[]}. input.stream contains state, phase (batch or finish), reset, partitionIndex, startRow, endRow, endOfPartition and final. Only the stream table is sliced; other tables are complete. Carry passes across batches, resets for each contiguous partition; finish runs once per partition with no rows. Reappearing partition keys are refused. State is limited to 64 KiB and the job to 128 steps; checkpoints are inspection only, not reload/resume authority.',
        'Whole-table output is JSON (or a string for text format). Console logs are bounded across the job. No async, network, packages or dataset commits. Complete input coverage is not independent data validation.',
    ] : [],
    resultShape: 'Host-owned job receipt with status, retry classification, digests and staged output reference. This is execution evidence, not validated data evidence.',
    isAvailable: context => context.hasCodeExecution ? { available: true } : { available: false, reason: 'A host-issued task execution adapter is required.' },
    inputSchema: name === 'code.run' ? {
        type: 'object', additionalProperties: false, required: ['program', 'inputs', 'output'], properties: {
            program: artifact,
            inputs: { type: 'array', maxItems: 20, items: { ...artifact, required: ['name', ...artifact.required], properties: { ...artifact.properties, name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$' } } } },
            tables: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', additionalProperties: false,
                required: ['name','tableId'], properties: {name:{type:'string',pattern:'^[A-Za-z][A-Za-z0-9_]{0,63}$'},tableId:{type:'string',minLength:1,maxLength:160}} } },
            mode: { type: 'string', enum: ['whole_table','stateful_stream'] },
            stream: { type: 'object', additionalProperties: false, required: ['table','batchRows','partitionBy','initialState'], properties: {
                table: {type:'string'}, batchRows:{type:'integer',minimum:1,maximum:5000},
                partitionBy:{type:'array',maxItems:8,uniqueItems:true,items:{type:'string',minLength:1,maxLength:240}},
                initialState: {type:['object','array','string','number','boolean','null']},
            } },
            sources: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['name','sourceId','sha256','offset','length'], properties: {
                name: { type: 'string' }, sourceId: { type: 'string' }, sha256: artifact.properties.sha256,
                offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: 65536 },
            } } },
            output: { type: 'object', additionalProperties: false, required: ['path','expectedRevision','format'], properties: {
                path: { type: 'string', maxLength: 240 }, expectedRevision: { type: 'integer', minimum: 0 }, format: { type: 'string', enum: ['json','text'] },
            } },
        },
    } : jobSchema(name === 'code.cancel'),
    validate: args => name === 'code.run' ? validateCodeRunRequest(args) ? [] : ['Invalid immutable execution request.']
        : args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).every(key => key === 'jobId')
            && (args.jobId === undefined && name === 'code.inspect' || typeof args.jobId === 'string' && args.jobId.length > 0 && args.jobId.length <= 80)
            ? [] : ['An owned jobId is required.'],
}));

export const createComputationToolManifest = (): ToolManifest => ({
    isAvailable:context=>context.hasCodeExecution?{available:true}:{available:false,reason:'A host task execution adapter is required.'},
    name:'computation.validate', category:'workspace', risk:'low', enabledByDefault:true, groups:['code.inspect'], requiresCleaningCompleted:false,
    description:'Independently validate a successful owned code.run JSON artifact for the fixed current-task Pearson correlation or lower weighted median contract. Only host-bound complete table execution is eligible. Stdout, arbitrary methods and model assertions are experimental.',
    promptHints:['Read the fixed coding task answer.computation scope. Write your own program over complete code.run tables and apply the exact typed filters. Pearson returns JSON {method:"pearson_correlation",methodVersion:1,seed:"none",scopedRows,n,excluded,coefficient}; use finite numeric pairs, exclude null/undefined/empty-string pairs, and coefficient null for fewer than two pairs or zero variance.',
        'The host reference reads the current accepted table, not your converted local variables. If source numeric cells are strings, Number() inside a statistical program does not make that input eligible. First use candidate_infer_meaning, your own complete candidate-envelope code_run, candidate_stage, candidate_validate and exact candidate_request_approval to publish the permitted typed repair. Only then run a separate computation on the committed version. Meaning inference alone never changes accepted rows.',
        'Lower weighted median returns JSON {method:"lower_weighted_median",methodVersion:1,seed:"none",scopedRows,n,excluded,zeroWeightRows,totalWeight,median,unit}. n counts nonmissing positive-frequency pairs; excluded counts missing value/weight pairs; zeroWeightRows counts remaining zero weights. Use nonnegative safe integer frequencies and a safe integer total; select the first ascending value whose cumulative weight reaches half the total, including the lower value at equality. median is null without positive weights. unit is the single string from scope.unitColumn among contributing pairs, or null without a unit column; refuse mixed units. Preserve negative/zero values. No averaging, sampling or truncated inputs.',
        'whole_table returns the result object; stateful_stream emits exactly one final result record through rows, using explicit JSON carry and a global partition. Then call computation.validate with only jobId. Host recomputes the reference independently. No causal or significance claims are validated.'],
    inputSchema:{type:'object',additionalProperties:false,required:['jobId'],properties:{jobId:{type:'string',minLength:1,maxLength:80}}},
    resultShape:'Host-owned validated computation evidence or an explicit blocked reason.',
    validate: args => args && Object.keys(args).length===1 && typeof args.jobId==='string' && args.jobId.length>0 && args.jobId.length<=80 ? [] : ['Use only an owned jobId.'],
});
