import type { CsvCellValue, CsvRow, DatasetColumnSchema } from '../../types';
import type { CandidateOutput } from './candidateContract';
import type { CandidateValidationContract, ValidationInputs, ValidationCell } from './candidateValidation';
import { validateCandidateSemantics, convertValidationCell } from './candidateValidation';

/** A model proposes interpretation, never candidate values, tolerance or a validation verdict. */
export interface CandidateMeaningProposal {
    input: {kind:'table'|'source';name:string;tableId?:string};
    table: {
        name:string;grain:string[];groupBy:string[];
        columns:Array<{name:string;sourceColumn:string|number;dataType:'string'|'number'|'date'|'boolean';nullable:boolean;
            conversion:ValidationCell['conversion'];scale?:number;unit?:string}>;
        detailRanges:Array<{start:number;end:number}>;
    };
    exclusions:Array<{row:number;role:'header'|'note'|'subtotal'|'grand_total'|'duplicate';duplicateOf?:number}>;
    assumptions:string[];
}
const object=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const only=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).every(k=>keys.includes(k));
const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=240;
const strings=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=24&&v.every(text)&&new Set(v).size===v.length;
const index=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<50000;
export const isCandidateMeaningProposal=(v:unknown):v is CandidateMeaningProposal=>{
    if(!object(v)||!only(v,['input','table','exclusions','assumptions'])||!object(v.input)||!object(v.table))return false;
    const i=v.input,t=v.table;
    return only(i,['kind','name','tableId'])&&['table','source'].includes(String(i.kind))&&text(i.name)&&/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(i.name)&&!['constructor','prototype','stream'].includes(i.name)
        &&(i.kind==='table'?text(i.tableId):i.tableId===undefined)
        &&only(t,['name','grain','groupBy','columns','detailRanges'])&&text(t.name)&&strings(t.grain)&&t.grain.length>0&&strings(t.groupBy)
        &&Array.isArray(t.columns)&&t.columns.length>0&&t.columns.length<=96&&t.columns.every(c=>object(c)&&only(c,['name','sourceColumn','dataType','nullable','conversion','scale','unit'])
            &&text(c.name)&&(i.kind==='source'?index(c.sourceColumn):text(c.sourceColumn))&&['string','number','date','boolean'].includes(String(c.dataType))
            &&typeof c.nullable==='boolean'&&['identity','trim','decimal','iso_date'].includes(String(c.conversion))
            &&(c.scale===undefined||Number.isInteger(c.scale)&&Number(c.scale)>=0&&Number(c.scale)<=6)&&(c.unit===undefined||text(c.unit)))
        &&Array.isArray(t.detailRanges)&&t.detailRanges.length>0&&t.detailRanges.length<=256&&t.detailRanges.every(r=>object(r)&&only(r,['start','end'])&&index(r.start)&&index(r.end)&&r.end>=r.start)
        &&Array.isArray(v.exclusions)&&v.exclusions.length<=2048&&v.exclusions.every(e=>object(e)&&only(e,['row','role','duplicateOf'])&&index(e.row)
            &&['header','note','subtotal','grand_total','duplicate'].includes(String(e.role))&&(e.duplicateOf===undefined||index(e.duplicateOf)))
        &&Array.isArray(v.assumptions)&&v.assumptions.length<=12&&v.assumptions.every(text);
};

/** Builds the reference from complete captured inputs before any guest candidate exists. */
export const compileInferredCandidateMeaning=(proposal:CandidateMeaningProposal,inputs:ValidationInputs):{
    contract:CandidateValidationContract;reference:CandidateOutput;assumptions:string[];
}=>{
    if(!isCandidateMeaningProposal(proposal))throw new Error('meaning_proposal_invalid');
    const p=structuredClone(proposal),spec=p.table;
    const rows=p.input.kind==='table'?inputs.tables[p.input.name]:inputs.sources[p.input.name];
    if(!rows?.length||rows.length>50000)throw new Error('meaning_complete_input_unavailable');
    const detail:number[]=[];
    for(const range of spec.detailRanges)for(let row=range.start;row<=range.end;row++){
        if(detail.length>=50000)throw new Error('meaning_resource_limit');
        detail.push(row);
    }
    if(detail.length>50000||new Set(detail).size!==detail.length||detail.some(r=>r>=rows.length)||detail.some((r,i)=>i>0&&r<=detail[i-1]))throw new Error('meaning_row_scope_invalid');
    if(new Set(spec.columns.map(c=>c.name)).size!==spec.columns.length||new Set(spec.columns.map(c=>c.sourceColumn)).size!==spec.columns.length)throw new Error('meaning_mapping_invalid');
    // Bound reference memory alongside the existing 8 MiB candidate envelope; refuse rather than sample.
    if(detail.length*spec.columns.length>80000)throw new Error('meaning_resource_limit');
    const read=(row:number,column:string|number):CsvCellValue=>{
        if(!rows[row]||!Object.hasOwn(rows[row],column))throw new Error('meaning_mapping_invalid');
        return (rows[row] as Record<string,CsvCellValue>)[column];
    };
    const mapped=new Set(spec.columns.map(c=>String(c.sourceColumn)));
    for(const row of detail){
        for(const column of spec.columns)read(row,column.sourceColumn);
        for(const [column,value] of Object.entries(rows[row])){
            if(!mapped.has(column)&&(p.input.kind==='table'||value!==null&&String(value).trim()!==''))throw new Error('meaning_input_columns_incomplete');
        }
    }
    const origin=(row:number,column:string|number)=>({kind:p.input.kind,name:p.input.name,row,column});
    const schema:DatasetColumnSchema[]=spec.columns.map(({name,dataType,nullable})=>({name,dataType,nullable}));
    if(spec.grain.some(g=>!spec.columns.some(c=>c.name===g&&['string','date'].includes(c.dataType)))||spec.groupBy.some(g=>!spec.columns.some(c=>c.name===g)))throw new Error('meaning_grain_unresolved');
    const expected=detail.map(row=>Object.fromEntries(spec.columns.map(c=>{
        try{return [c.name,convertValidationCell(read(row,c.sourceColumn),{column:c.name,origin:origin(row,c.sourceColumn),conversion:c.conversion,scale:c.scale})];}
        catch{throw new Error('meaning_conversion_unresolved');}
    })) as CsvRow);
    const metrics=spec.columns.filter(c=>c.dataType==='number'&&!spec.grain.includes(c.name)&&!spec.groupBy.includes(c.name)).map(c=>{
        // Unlabelled values preserve their original scale; they do not acquire an invented currency/unit.
        const unit=c.unit??'source-value-preserved';
        if(unit!=='source-value-preserved'){
            const supported=p.input.kind==='table'?String(c.sourceColumn).includes(unit):p.exclusions.some(e=>e.role==='header'&&String(read(e.row,c.sourceColumn)).includes(unit));
            if(!supported)throw new Error('meaning_unit_not_in_source');
        }
        return {column:c.name,scale:c.scale??0,toleranceMinor:0,unit};
    });
    const cells=detail.map(row=>({cells:spec.columns.map(c=>({column:c.name,origin:origin(row,c.sourceColumn),conversion:c.conversion,scale:c.scale}))}));
    const exclusions:CandidateValidationContract['exclusions']=p.exclusions.map(e=>{
        if(e.row>=rows.length||detail.includes(e.row))throw new Error('meaning_row_scope_invalid');
        if(e.role==='header'){
            if(p.input.kind!=='source'||spec.columns.some(c=>String(read(e.row,c.sourceColumn)).trim()!==c.name))throw new Error('meaning_header_unverified');
        }
        if(e.role==='note'){
            // Labels alone never justify dropping legitimate zero/negative facts or populated key rows.
            if(spec.columns.some(c=>c.dataType==='number'&&read(e.row,c.sourceColumn)!==null&&String(read(e.row,c.sourceColumn)).trim()!==''))throw new Error('meaning_note_contains_facts');
            if(spec.grain.every(g=>String(read(e.row,spec.columns.find(c=>c.name===g)!.sourceColumn)??'').trim()))throw new Error('meaning_note_contains_keys');
        }
        const checks:CandidateValidationContract['exclusions'][number]['checks']=[];
        if(e.role==='subtotal'||e.role==='grand_total')for(const m of metrics){
            const scope=e.role==='subtotal'?spec.groupBy.map(field=>({field,origin:origin(e.row,spec.columns.find(c=>c.name===field)!.sourceColumn)})):[];
            const matching=expected.map((r,i)=>({r,i})).filter(({r})=>scope.every(s=>r[s.field]===read(e.row,s.origin.column))).map(({i})=>i);
            if(!matching.length)throw new Error('meaning_summary_scope_unresolved');
            checks.push({column:spec.columns.find(c=>c.name===m.column)!.sourceColumn,table:spec.name,metric:m.column,detailRows:matching,scope});
        }
        return {origin:{kind:p.input.kind,name:p.input.name,row:e.row},role:e.role,checks,
            ...(e.duplicateOf===undefined?{}:{duplicateOf:{kind:p.input.kind,name:p.input.name,row:e.duplicateOf}})};
    });
    const contract:CandidateValidationContract={version:1,ambiguities:[],tables:[{name:spec.name,role:'fact',schema,grain:spec.grain,groupBy:spec.groupBy,metrics,
        mutableColumns:spec.columns.filter(c=>c.conversion!=='identity').map(c=>c.name),rows:cells}],relationships:[],exclusions};
    const reference:CandidateOutput={schemaVersion:1,complete:true,tables:[{name:spec.name,role:'fact',schema,rowCount:expected.length,rows:expected,
        lineage:cells.flatMap((r,row)=>r.cells.map(c=>({row,column:c.column,origins:[c.origin]})))}],relationships:[],excludedRows:exclusions.map(e=>({origin:e.origin,reason:e.role}))};
    const verdict=validateCandidateSemantics(reference,contract,inputs);
    if(verdict.decision!=='validated')throw new Error(verdict.reasonCodes.join(',')||'meaning_reference_invalid');
    return {contract,reference,assumptions:[...p.assumptions,'Business grain and row roles are AI-inferred; host checks establish source equivalence, not external business truth.',
        ...(metrics.some(m=>m.unit==='source-value-preserved')?['Unlabelled metric units remain unspecified; unit conversion is not authorized.']:[])]};
};
