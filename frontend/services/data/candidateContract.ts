import type {CsvRow,DatasetColumnSchema,DatasetTableRole,DatasetRelationshipCardinality,DatasetScopeBinding} from '../../types';
import type {CodeExecutionReceipt,CodeArtifactRef} from '../agent/execution/codeExecutionContract';
export type CandidateRowOrigin={kind:'table';name:string;row:number}|{kind:'source';name:string;row:number};
export type CandidateCellOrigin=CandidateRowOrigin & {column:string|number};
export interface CandidateTable {
    name:string;role:DatasetTableRole;schema:DatasetColumnSchema[];rowCount:number;rows:CsvRow[];
    lineage:Array<{row:number;column:string;origins:CandidateCellOrigin[]}>;
}
export interface CandidateRelationship {fromTable:string;toTable:string;fromKeys:string[];toKeys:string[];cardinality:DatasetRelationshipCardinality}
/** Guest declaration only. Staging verifies structural completeness, never business semantics. */
export interface CandidateOutput {
    schemaVersion:1;complete:true;tables:CandidateTable[];relationships:CandidateRelationship[];
    excludedRows:Array<{origin:CandidateRowOrigin;reason:string}>;
}
export interface StagedDatasetCandidate extends CandidateOutput {
    candidateId:string;namespaceId:string;taskId:string;taskRevision:number;
    sessionId:string;sessionEpoch:number;runId:string;turnId?:string;
    status:'staged';validation:'pending';answerEvidence:false;
    changeDigest:string;lineageDigest:string;createdAt:number;
    inputBindings:DatasetScopeBinding[];
    requestedChange:{goal:string;intentDigest:string;scopeDigest:string};
    protectedSource:{sourceId:string;sha256:string}|null;
    execution:Readonly<CodeExecutionReceipt>;
    staging:{toolCallId:string;stepId:string};
    outputArtifacts:CodeArtifactRef[];
    /** Opt-in host staging extension, never accepted by the closed guest CandidateOutput v1 parser.
     * Tables expose metadata only; rows and implicit one-to-one lineage live in authenticated chunks. */
    spill?:{manifest:Readonly<import('./candidateSpill').SpillManifest>;meaning:import('./spillCandidateValidation').SpillCandidateMeaning;meaningDigest:string};
    streamedDual?:{manifest:Readonly<import('./candidateSpill').SpillManifest>;meaning:import('./streamedDualGrain').StreamedDualMeaning;meaningDigest:string};
}
const exact=(v:unknown,keys:string[])=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)
    &&Object.keys(v).sort().join('|')===[...keys].sort().join('|'));
/** Shared by strict admission and the model-facing plan; inference fields are a different contract. */
export const CANDIDATE_OUTPUT_FIELDS=Object.freeze({
    envelope:Object.freeze(['schemaVersion','complete','tables','relationships','excludedRows']),
    table:Object.freeze(['name','role','schema','rowCount','rows','lineage']),
    schema:Object.freeze(['name','dataType','nullable']),
    cellLineage:Object.freeze(['row','column','origins']),
});
const name=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=240&&!['__proto__','constructor','prototype'].includes(v);
const index=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const rowOrigin=(v:CandidateRowOrigin)=>exact(v,['kind','name','row'])&&['table','source'].includes(v.kind)&&name(v.name)&&index(v.row);
const cellOrigin=(v:CandidateCellOrigin)=>exact(v,['kind','name','row','column'])&&rowOrigin({kind:v.kind,name:v.name,row:v.row})
    &&(v.kind==='table'?name(v.column):index(v.column));
export const parseCandidateOutput=(text:string):CandidateOutput=>{
    let v:CandidateOutput;
    try{v=JSON.parse(text);}catch{throw new Error('candidate_malformed');}
    const fail=()=>{throw new Error('candidate_malformed');};
    if(!exact(v,[...CANDIDATE_OUTPUT_FIELDS.envelope])||v.schemaVersion!==1||v.complete!==true
        ||!Array.isArray(v.tables)||!v.tables.length||v.tables.length>20||!Array.isArray(v.relationships)||v.relationships.length>100
        ||!Array.isArray(v.excludedRows)||v.excludedRows.length>50000)fail();
    const names=new Set<string>();let rows=0,cells=0;
    for(const t of v.tables){
        if(!exact(t,[...CANDIDATE_OUTPUT_FIELDS.table])||!name(t.name)||names.has(t.name)
            ||!['fact','dimension','bridge','reference','unknown'].includes(t.role)||!Array.isArray(t.schema)||!t.schema.length||t.schema.length>256
            ||!index(t.rowCount)||!Array.isArray(t.rows)||t.rowCount!==t.rows.length||!Array.isArray(t.lineage))fail();
        names.add(t.name);rows+=t.rowCount;if(rows>50000)throw new Error('resource_limit');
        const columns=new Set<string>();
        for(const s of t.schema){if(!exact(s,[...CANDIDATE_OUTPUT_FIELDS.schema])||!name(s.name)||columns.has(s.name)
            ||!['string','number','boolean','date','unknown'].includes(s.dataType)||typeof s.nullable!=='boolean')fail();columns.add(s.name);}
        for(const r of t.rows){if(!exact(r,[...columns])||Object.values(r).some(x=>x!==null&&!['string','number','boolean'].includes(typeof x)
            ||typeof x==='number'&&!Number.isFinite(x)))fail();}
        const mapped=new Set<string>();
        for(const l of t.lineage){if(!exact(l,[...CANDIDATE_OUTPUT_FIELDS.cellLineage])||!index(l.row)||l.row>=t.rowCount||!columns.has(l.column)
            ||!Array.isArray(l.origins)||!l.origins.length||l.origins.length>256||l.origins.some(o=>!cellOrigin(o)))fail();
            const key=JSON.stringify([l.row,l.column]);if(mapped.has(key)||new Set(l.origins.map(o=>JSON.stringify(o))).size!==l.origins.length)fail();mapped.add(key);}
        if(mapped.size!==t.rowCount*t.schema.length)throw new Error('candidate_lineage_incomplete');
        cells+=mapped.size;if(cells>200000)throw new Error('resource_limit');
    }
    const relationships=new Set<string>();
    for(const r of v.relationships){
        if(!exact(r,['fromTable','toTable','fromKeys','toKeys','cardinality'])||!names.has(r.fromTable)||!names.has(r.toTable)
            ||!Array.isArray(r.fromKeys)||!Array.isArray(r.toKeys)||!r.fromKeys.length||r.fromKeys.length>8||r.fromKeys.length!==r.toKeys.length
            ||new Set(r.fromKeys).size!==r.fromKeys.length||new Set(r.toKeys).size!==r.toKeys.length
            ||!['one_to_one','one_to_many','many_to_one','many_to_many','unknown'].includes(r.cardinality)
            ||r.fromKeys.some(k=>!v.tables.find(t=>t.name===r.fromTable)!.schema.some(s=>s.name===k))
            ||r.toKeys.some(k=>!v.tables.find(t=>t.name===r.toTable)!.schema.some(s=>s.name===k)))fail();
        const key=JSON.stringify([r.fromTable,r.toTable,r.fromKeys,r.toKeys]);if(relationships.has(key))fail();relationships.add(key);
    }
    if(v.excludedRows.some(e=>!exact(e,['origin','reason'])||!rowOrigin(e.origin)||typeof e.reason!=='string'||!e.reason.trim()||e.reason.length>500))fail();
    return v;
};
