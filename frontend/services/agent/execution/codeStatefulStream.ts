import type { CsvRow } from '../../../types';
import type { GuestLimits, GuestOutcome } from '../../sandbox/javascriptGuestProtocol';
import { CODE_TABLE_LIMITS, codeDigest } from './codeTableInputs';
import type { CodeStreamCheckpoint, CodeStreamOptions } from './codeExecutionContract';

type Tables = Record<string, {rows: CsvRow[];columns:string[]}>;
export interface CodeStreamStep {
    partitionIndex: number; phase: 'batch' | 'finish'; startRow: number; endRow: number;
    reset: boolean; endOfPartition: boolean; final: boolean;
}
export const serializeCodeState = (value: unknown): string => {
    let json: string | undefined;
    try { json = JSON.stringify(value, (_key, item) => {
        if (item !== null && !['string','number','boolean','object'].includes(typeof item)
            || typeof item === 'number' && !Number.isFinite(item)) throw new Error();
        return item;
    }); } catch { throw new Error('validation_failed'); }
    if (json === undefined) throw new Error('validation_failed');
    if (new TextEncoder().encode(json).length > CODE_TABLE_LIMITS.stateBytes) throw new Error('resource_limit');
    return json;
};

/** Partitions are contiguous and input order is preserved. Reappearing keys require an explicit global sort. */
export const planCodeStream = (options: CodeStreamOptions, tables: Tables): CodeStreamStep[] => {
    serializeCodeState(options.initialState);
    const rows = tables[options.table]?.rows;
    if (!rows || options.partitionBy.some(column => !tables[options.table].columns.includes(column)
        || rows.some(row => !Object.hasOwn(row, column)))) throw new Error('validation_failed');
    const partitions: Array<{start:number;end:number}> = [];
    const seen = new Set<string>();
    let start = 0;
    while (start < rows.length) {
        const key = JSON.stringify(options.partitionBy.map(column => rows[start][column]));
        if (seen.has(key)) throw new Error('partition_not_contiguous');
        seen.add(key);
        let end = start+1;
        while (end < rows.length && JSON.stringify(options.partitionBy.map(column=>rows[end][column])) === key) end++;
        partitions.push({start,end}); start=end;
        if (partitions.length*2 > CODE_TABLE_LIMITS.streamSteps) throw new Error('resource_limit');
    }
    if (!partitions.length) partitions.push({start:0,end:0});
    const steps: CodeStreamStep[] = [];
    partitions.forEach((partition,partitionIndex)=>{
        for(let offset=partition.start;offset<partition.end;offset+=options.batchRows){
            const endRow=Math.min(offset+options.batchRows,partition.end);
            if(steps.length>=CODE_TABLE_LIMITS.streamSteps)throw new Error('resource_limit');
            steps.push({partitionIndex,phase:'batch',startRow:offset,endRow,reset:offset===partition.start,
                endOfPartition:endRow===partition.end,final:partitionIndex===partitions.length-1&&endRow===partition.end});
        }
        steps.push({partitionIndex,phase:'finish',startRow:partition.end,endRow:partition.end,reset:partition.start===partition.end,
            endOfPartition:true,final:partitionIndex===partitions.length-1});
        if(steps.length>CODE_TABLE_LIMITS.streamSteps)throw new Error('resource_limit');
    });
    return steps;
};

/** Each step enters a new guest. The only carry is serialized JSON; no globals/closure can cross a step. */
export const executeCodeStream = async (options: CodeStreamOptions, steps: CodeStreamStep[], input: Record<string,unknown>,
    limits: GuestLimits, run: (json:string)=>Promise<GuestOutcome>, assertCurrent:()=>void,
    checkpoint: (value:CodeStreamCheckpoint)=>void, checkpointIdentity: unknown): Promise<GuestOutcome> => {
    const table = input[options.table] as {rows:CsvRow[]};
    let state = serializeCodeState(options.initialState), outputBytes=2, outputRows=0;
    const chunks: string[]=[];
    let result:GuestOutcome|undefined;
    for(let sequence=0;sequence<steps.length;sequence++){
        assertCurrent();
        const step=steps[sequence];
        if(step.reset)state=serializeCodeState(options.initialState);
        const json=JSON.stringify({...input,[options.table]:{...table,rows:table.rows.slice(step.startRow,step.endRow)},
            stream:{...step,state:JSON.parse(state)}});
        if(new TextEncoder().encode(json).length>limits.inputBytes)throw new Error('resource_limit');
        result=await run(json); assertCurrent();
        if(result.status!=='completed')return result;
        let parsed:{state:unknown;rows:unknown[]};
        try{parsed=JSON.parse(result.outputJson!);}catch{throw new Error('protocol_incompatible');}
        if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.keys(parsed).sort().join('|')!=='rows|state'
            ||!Array.isArray(parsed.rows))throw new Error('validation_failed');
        const nextState=serializeCodeState(parsed.state);
        const chunk=JSON.stringify(parsed.rows).slice(1,-1);
        outputBytes+=new TextEncoder().encode(chunk).length+(chunk.length&&outputRows?1:0);
        if(outputBytes>limits.outputBytes)throw new Error('resource_limit');
        if(chunk.length)chunks.push(chunk);
        outputRows+=parsed.rows.length;
        const stateDigest=await codeDigest(JSON.parse(nextState)); assertCurrent();
        const cursor={sequence,partitionIndex:step.partitionIndex,phase:step.phase,nextRow:step.endRow,
            stateDigest,stateBytes:new TextEncoder().encode(nextState).length,outputRows};
        const digest=await codeDigest({identity:checkpointIdentity,cursor,output:chunks}); assertCurrent();
        state=nextState;checkpoint({...cursor,digest});
    }
    return {...result!,outputJson:`[${chunks.join(',')}]`};
};
