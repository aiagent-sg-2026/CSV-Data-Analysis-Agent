import {describe,expect,it} from 'vitest';
import {validateCandidateSemantics,type CandidateValidationContract} from '../services/data/candidateValidation';
import type {CandidateOutput} from '../services/data/candidateContract';

const schema=[{name:'Id',dataType:'string',nullable:false},{name:'Group',dataType:'string',nullable:false},{name:'Amount',dataType:'number',nullable:false},{name:'Currency',dataType:'string',nullable:false}] as const;
const input=[{Id:'Total Solutions',Group:'East',Amount:0,Currency:'SGD'},{Id:'a',Group:'East',Amount:315,Currency:'SGD'},{Id:'b',Group:'West',Amount:-5,Currency:'SGD'},{Id:'subtotal',Group:'East',Amount:315,Currency:'SGD'},{Id:'grand',Group:'all',Amount:310,Currency:'SGD'}];
const origin=(row:number,column:string)=>({kind:'table' as const,name:'raw',row,column});
const contract=():CandidateValidationContract=>({version:1,ambiguities:[],tables:[{name:'facts',role:'fact',schema:structuredClone([...schema]),grain:['Id'],groupBy:['Group','Currency'],metrics:[{column:'Amount',scale:2,toleranceMinor:0,unit:'money',currencyColumn:'Currency',allowedCurrencies:['SGD']}],mutableColumns:[],rows:[0,1,2].map(row=>({cells:schema.map(s=>({column:s.name,origin:origin(row,s.name),conversion:'identity'}))}))}],relationships:[],exclusions:[{origin:{kind:'table',name:'raw',row:3},role:'subtotal',checks:[{column:'Amount',table:'facts',detailRows:[0,1],metric:'Amount'}]},{origin:{kind:'table',name:'raw',row:4},role:'grand_total',checks:[{column:'Amount',table:'facts',detailRows:[0,1,2],metric:'Amount'}]}]});
const candidate=():CandidateOutput=>({schemaVersion:1,complete:true,tables:[{name:'facts',role:'fact',schema:structuredClone([...schema]),rowCount:3,rows:structuredClone(input.slice(0,3)),lineage:[0,1,2].flatMap(row=>schema.map(s=>({row,column:s.name,origins:[origin(row,s.name)]})))}],relationships:[],excludedRows:[3,4].map(row=>({origin:{kind:'table',name:'raw',row},reason:'declared summary'}))});
const withScope=(spec:CandidateValidationContract)=>{for(const e of spec.exclusions)for(const c of e.checks)c.scope=(e.role==='subtotal'?['Group','Currency']:['Currency']).map(field=>({field,origin:origin(e.origin.row,field)}));return spec;};
const baseContract=contract;
const scopedContract=()=>withScope(baseContract());
const validate=(c=candidate(),spec=scopedContract())=>validateCandidateSemantics(c,spec,{tables:{raw:input},sources:{}});
describe('independent host candidate validation',()=>{
    it('accepts detail 310 instead of naive raw sum 935, retaining legitimate names, zero and negative facts',()=>{expect(validate()).toMatchObject({decision:'validated',reasonCodes:[]});});
    it.each(['wrong-group','duplicate','missing-group','currency','type','null','scope','lineage','summary','relationship'])('rejects %s even with declared successful assertions',fault=>{
        const c=candidate();
        if(fault==='wrong-group'){c.tables[0].rows[1].Amount=310;c.tables[0].rows[2].Amount=0;}
        if(fault==='duplicate')c.tables[0].rows[2].Id='a';
        if(fault==='missing-group')c.tables[0].rows[2].Group='East';
        if(fault==='currency')c.tables[0].rows[1].Currency='USD';
        if(fault==='type')c.tables[0].rows[1].Amount='315';
        if(fault==='null')c.tables[0].rows[1].Id=null;
        if(fault==='scope')c.tables[0].rows[0].Id='Renamed';
        if(fault==='lineage')c.tables[0].lineage[0].origins[0].row=1;
        if(fault==='summary')c.excludedRows.pop();
        if(fault==='relationship')c.relationships.push({fromTable:'facts',toTable:'facts',fromKeys:['Group'],toKeys:['Group'],cardinality:'many_to_one'});
        expect(validate(c).decision).toBe('blocked');expect(validate(c).reasonCodes.length).toBeGreaterThan(0);
    });
    it('does not certify missing or ambiguous host meaning',()=>{const spec=scopedContract();spec.ambiguities=['date convention'];expect(validate(candidate(),spec).decision).toBe('clarification');expect(validateCandidateSemantics(candidate(),undefined,{tables:{raw:input},sources:{}}).decision).toBe('clarification');});
    it('does not vacuously certify numeric measures with missing metric/unit interpretation',()=>{
        const spec=scopedContract();spec.tables[0].metrics=[];expect(validate(candidate(),spec)).toMatchObject({decision:'clarification',reasonCodes:['validation_metric_or_unit_unresolved']});
    });
    it('accepts reordered equivalent fact identity/value sets with correctly reordered lineage',()=>{
        const c=candidate();c.tables[0].rows.reverse();c.tables[0].lineage=c.tables[0].lineage.map(l=>({...l,row:2-l.row}));expect(validate(c).decision).toBe('validated');
    });
    it('rejects stale summary arithmetic instead of enforcing a naive input grand total',()=>{
        const raw=structuredClone(input);raw[3].Amount=314;expect(validateCandidateSemantics(candidate(),scopedContract(),{tables:{raw},sources:{}}).reasonCodes).toContain('validation_summary_reconciliation_failed');
    });
    it('reconciles nested group subtotals and grand total independently: raw 930, detail 310',()=>{
        const raw=[...input.slice(0,4),{Id:'west-subtotal',Group:'West',Amount:-5,Currency:'SGD'},input[4]],spec=scopedContract(),c=candidate();
        spec.exclusions[1].origin.row=5;spec.exclusions[1].checks[0].scope=[{field:'Currency',origin:origin(5,'Currency')}];spec.exclusions.push({origin:{kind:'table',name:'raw',row:4},role:'subtotal',checks:[{column:'Amount',table:'facts',detailRows:[2],metric:'Amount',scope:['Group','Currency'].map(field=>({field,origin:origin(4,field)}))}]});
        c.excludedRows=[3,4,5].map(row=>({origin:{kind:'table',name:'raw',row},reason:'nested summary'}));
        expect(raw.reduce((sum,r)=>sum+r.Amount,0)).toBe(930);expect(validateCandidateSemantics(c,spec,{tables:{raw},sources:{}}).decision).toBe('validated');
        c.tables[0].rows[0].Id='Subtotal';expect(validateCandidateSemantics(c,spec,{tables:{raw},sources:{}}).decision).toBe('blocked');
    });
    it('accepts unique, fully covered dimension keys and rejects mixed-currency summary addition',()=>{
        const c=candidate(),spec=scopedContract(),relation={fromTable:'facts',toTable:'facts',fromKeys:['Id'],toKeys:['Id'],cardinality:'one_to_one' as const};
        spec.relationships=[{...relation,maxAmplification:1,requireCoverage:true}];c.relationships=[relation];expect(validate(c,spec).decision).toBe('validated');
        const raw=structuredClone(input);raw[2].Currency='USD';c.tables[0].rows[2].Currency='USD';spec.tables[0].metrics[0].allowedCurrencies=['SGD','USD'];expect(validateCandidateSemantics(c,spec,{tables:{raw},sources:{}}).decision).toBe('clarification');
    });
    it('verifies units separately within the grouping contract',()=>{
        const spec=scopedContract(),c=candidate(),raw=input.map(r=>({...r,Unit:'kg'}));
        spec.tables[0].schema=[...spec.tables[0].schema,{name:'Unit',dataType:'string',nullable:false}];spec.tables[0].groupBy.push('Unit');
        spec.tables[0].metrics[0].unitColumn='Unit';spec.tables[0].metrics[0].allowedUnits=['kg'];for(const e of spec.exclusions)for(const c of e.checks)c.scope!.push({field:'Unit',origin:origin(e.origin.row,'Unit')});
        spec.tables[0].rows.forEach((r,i)=>r.cells.push({column:'Unit',origin:origin(i,'Unit'),conversion:'identity'}));
        c.tables[0].schema=[...c.tables[0].schema,{name:'Unit',dataType:'string',nullable:false}];c.tables[0].rows.forEach((r,i)=>{r.Unit='kg';c.tables[0].lineage.push({row:i,column:'Unit',origins:[origin(i,'Unit')]});});
        expect(validateCandidateSemantics(c,spec,{tables:{raw},sources:{}}).decision).toBe('validated');c.tables[0].rows[2].Unit='lb';
        expect(validateCandidateSemantics(c,spec,{tables:{raw},sources:{}}).reasonCodes).toContain('validation_unit_mismatch');
    });
    it('rejects amplified joins with unique dimension fact IDs even when totals and table rows match',()=>{
        const spec=scopedContract(),c=candidate();spec.tables.push({...structuredClone(spec.tables[0]),name:'dimension',role:'dimension'});c.tables.push({...structuredClone(c.tables[0]),name:'dimension',role:'dimension'});
        const relation={fromTable:'facts',toTable:'dimension',fromKeys:['Group'],toKeys:['Group'],cardinality:'many_to_one' as const};
        spec.relationships=[{...relation,maxAmplification:1,requireCoverage:true}];c.relationships=[relation];
        const verdict=validate(c,spec);expect(verdict.reasonCodes).toContain('validation_relationship_amplification');expect(verdict.reasonCodes).toContain('validation_relationship_cardinality_failed');
    });
    it('refuses missing join-key coverage and unknown/many-to-many semantics',()=>{
        const spec=scopedContract(),c=candidate();const r={fromTable:'facts',toTable:'facts',fromKeys:['Id'],toKeys:['Group'],cardinality:'many_to_one' as const};
        spec.relationships=[{...r,maxAmplification:1,requireCoverage:true}];c.relationships=[r];expect(validate(c,spec).reasonCodes).toContain('validation_relationship_coverage_failed');
        spec.relationships[0].cardinality='many_to_many';expect(validate(c,spec).decision).toBe('clarification');
    });
    it('requires independent duplicate equality, not an agent exclusion reason',()=>{
        const spec=scopedContract(),c=candidate();spec.exclusions[0]={...spec.exclusions[0],role:'duplicate',duplicateOf:{kind:'table',name:'raw',row:1},checks:[]};
        expect(validate(c,spec).reasonCodes).toContain('validation_duplicate_exclusion_invalid');
    });
    it('detects tail-only compensated group corruption on both sides of the 5,000-row boundary',()=>{
        const raw=Array.from({length:5002},(_,i)=>({Id:String(i),Group:i%2?'West':'East',Amount:i===5001?-5:0,Currency:'SGD'}));
        const spec=scopedContract();spec.exclusions=[];spec.tables[0].rows=raw.map((_r,row)=>({cells:schema.map(s=>({column:s.name,origin:origin(row,s.name),conversion:'identity'}))}));
        const c=candidate();c.excludedRows=[];c.tables[0].rows=structuredClone(raw);c.tables[0].rowCount=raw.length;c.tables[0].lineage=raw.flatMap((_r,row)=>schema.map(s=>({row,column:s.name,origins:[origin(row,s.name)]})));
        expect(validateCandidateSemantics(c,spec,{tables:{raw},sources:{}}).decision).toBe('validated');
        c.tables[0].rows[4999].Amount=5;c.tables[0].rows[5000].Amount=-5;expect(validateCandidateSemantics(c,spec,{tables:{raw},sources:{}}).reasonCodes).toContain('validation_group_reconciliation_failed');
    });
    it('checks positional raw-source mapping and explicit decimal/ISO-date conversion without locale guessing',()=>{
        const spec:CandidateValidationContract={version:1,ambiguities:[],tables:[{name:'facts',role:'fact',schema:[{name:'Id',dataType:'string',nullable:false},{name:'Amount',dataType:'number',nullable:false},{name:'Date',dataType:'date',nullable:false}],grain:['Id'],groupBy:[],metrics:[{column:'Amount',scale:2,toleranceMinor:0,unit:'SGD'}],mutableColumns:['Amount','Date'],rows:[{cells:[{column:'Id',origin:{kind:'source',name:'raw',row:1,column:1},conversion:'identity'},{column:'Amount',origin:{kind:'source',name:'raw',row:1,column:2},conversion:'decimal',scale:2},{column:'Date',origin:{kind:'source',name:'raw',row:1,column:3},conversion:'iso_date'}]}]}],relationships:[],exclusions:[{origin:{kind:'source',name:'raw',row:0},role:'header',checks:[]}]};
        const c:CandidateOutput={schemaVersion:1,complete:true,tables:[{name:'facts',role:'fact',schema:[...spec.tables[0].schema],rowCount:1,rows:[{Id:'Total,\nSolutions',Amount:-5.25,Date:'2026-10-01'}],lineage:spec.tables[0].rows[0].cells.map(r=>({row:0,column:r.column,origins:[r.origin]}))}],relationships:[],excludedRows:[{origin:{kind:'source',name:'raw',row:0},reason:'header'}]};
        const sources={raw:[['Id','Amount','Date'],['','Total,\nSolutions','-5.25','2026-10-01']]};expect(validateCandidateSemantics(c,spec,{tables:{},sources}).decision).toBe('validated');sources.raw[1][3]='10/01/2026';expect(validateCandidateSemantics(c,spec,{tables:{},sources}).decision).toBe('clarification');
    });
    it('fails closed for empty/duplicate/malformed contracts and preserves the numeric precision bound',()=>{
        const spec=scopedContract();spec.tables=[];expect(validate(candidate(),spec).decision).toBe('blocked');
        const precision=scopedContract();precision.tables[0].metrics[0].scale=9;expect(validate(candidate(),precision).reasonCodes).toContain('validation_contract_invalid');
        const c=candidate();c.tables[0].rows[1].Amount=315.001;expect(validate(c).reasonCodes).toContain('validation_decimal_precision');
        const protectedContract=scopedContract(),protectedCandidate=candidate();protectedContract.tables[0].metrics[0].toleranceMinor=1;protectedCandidate.tables[0].rows[1].Amount=315.01;
        expect(validate(protectedCandidate,protectedContract).reasonCodes).toContain('validation_unchanged_region_mismatch');
        protectedContract.tables[0].mutableColumns=['Amount'];expect(validate(protectedCandidate,protectedContract).reasonCodes).toContain('validation_unchanged_region_mismatch');
        const repair=protectedContract.tables[0].rows[1].cells.find(c=>c.column==='Amount')!;repair.conversion='decimal';repair.scale=2;
        expect(validate(protectedCandidate,protectedContract).decision).toBe('validated');
    });
});
