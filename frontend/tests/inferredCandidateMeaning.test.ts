import {describe,expect,it} from 'vitest';
import {compileInferredCandidateMeaning,isCandidateMeaningProposal,type CandidateMeaningProposal} from '../services/data/inferredCandidateMeaning';
import {validateCandidateSemantics} from '../services/data/candidateValidation';

const raw=[['Id','Region','Amount SGD'],['Total Solutions','East','0.00'],['detail-2','East','-5.25'],['Subtotal','East','-5.25'],['detail-3','West','10.00'],['Subtotal','West','10.00'],['Grand Total','','4.75']];
const proposal=():CandidateMeaningProposal=>({input:{kind:'source',name:'original'},table:{name:'facts',grain:['Id'],groupBy:['Region'],columns:[
    {name:'Id',sourceColumn:0,dataType:'string',nullable:false,conversion:'trim'},
    {name:'Region',sourceColumn:1,dataType:'string',nullable:false,conversion:'identity'},
    {name:'Amount SGD',sourceColumn:2,dataType:'number',nullable:false,conversion:'decimal',scale:2,unit:'SGD'},
],detailRanges:[{start:1,end:2},{start:4,end:4}]},exclusions:[{row:0,role:'header'},{row:3,role:'subtotal'},{row:5,role:'subtotal'},{row:6,role:'grand_total'}],assumptions:['Id identifies a detail fact; regional summary rows aggregate all regional details.']});
const compile=(p=proposal(),source=raw)=>compileInferredCandidateMeaning(p,{tables:{},sources:{original:source}});
describe('automatic inferred meaning uses complete source reference',()=>{
    it('keeps legitimate names, zero and negative facts; verifies each group and whole-source accounting',()=>{
        const r=compile();expect(r.reference.tables[0].rows).toEqual([{Id:'Total Solutions',Region:'East','Amount SGD':0},{Id:'detail-2',Region:'East','Amount SGD':-5.25},{Id:'detail-3',Region:'West','Amount SGD':10}]);
        expect(r.contract.exclusions[1].checks[0].detailRows).toEqual([0,1]);expect(r.contract.exclusions[2].checks[0].detailRows).toEqual([2]);
        expect(r.assumptions.join(' ')).toContain('AI-inferred');
    });
    it('rejects equal grand totals with the wrong regional subtotal scope',()=>{
        const source=structuredClone(raw);source[3][2]='10.00';source[5][2]='-5.25';expect(()=>compile(proposal(),source)).toThrow('validation_summary_reconciliation_failed');
    });
    it('does not use any candidate result as the reference',()=>{
        const r=compile();r.reference.tables[0].rows[0]['Amount SGD']=999;
        const result=validateCandidateSemantics(r.reference,r.contract,{tables:{},sources:{original:raw}});
        expect(result.decision).toBe('blocked');expect(result.reasonCodes).toContain('validation_transformed_value_mismatch');
    });
    it('rejects missing physical rows, overlapping ranges and invalid column mappings',()=>{
        const p=proposal();p.table.detailRanges=[{start:1,end:1},{start:4,end:4}];expect(()=>compile(p)).toThrow('validation_input_coverage_incomplete');
        const q=proposal();q.table.detailRanges.push({start:1,end:1});expect(()=>compile(q)).toThrow('meaning_row_scope_invalid');
        const s=proposal();s.table.columns[0].sourceColumn=8;expect(()=>compile(s)).toThrow('meaning_mapping_invalid');
    });
    it('does not authorize dropping an undeclared populated source column',()=>{
        const source=structuredClone(raw);source[1].push('important original descriptor');expect(()=>compile(proposal(),source)).toThrow('meaning_input_columns_incomplete');
    });
    it('refuses invented units; unspecified units preserve source values and remain explicit',()=>{
        const p=proposal();p.table.columns[2].unit='USD';expect(()=>compile(p)).toThrow('meaning_unit_not_in_source');
        delete p.table.columns[2].unit;const r=compile(p);expect(r.contract.tables[0].metrics[0].unit).toBe('source-value-preserved');expect(r.assumptions.join(' ')).toContain('unspecified');
    });
    it('refuses metric-as-grain, duplicate and empty inferred keys',()=>{
        const p=proposal();p.table.grain=['Amount SGD'];expect(()=>compile(p)).toThrow('meaning_grain_unresolved');
        const source=structuredClone(raw);source[2][0]=source[1][0];expect(()=>compile(proposal(),source)).toThrow('validation_grain_ambiguous');
        source[2][0]='';expect(()=>compile(proposal(),source)).toThrow('validation_grain_ambiguous');
    });
    it('does not admit note exclusions for populated keys or zero/negative facts',()=>{
        const p=proposal();p.table.detailRanges=[{start:2,end:2},{start:4,end:4}];p.exclusions.push({row:1,role:'note'});expect(()=>compile(p)).toThrow('meaning_note_contains_facts');
    });
    it('does not permit model-supplied authority, tolerance, confidence or output values',()=>{
        expect(isCandidateMeaningProposal({...proposal(),runId:'forged'})).toBe(false);
        const p=proposal();expect(isCandidateMeaningProposal({...p,table:{...p.table,rows:[{Id:'fake'}]}})).toBe(false);
        expect(isCandidateMeaningProposal({...p,confidence:1})).toBe(false);
        expect(isCandidateMeaningProposal({...p,input:{kind:'source',name:'constructor'}})).toBe(false);
    });
    it('bounds overlapping expansion before allocating an unbounded reference',()=>{
        const p=proposal();p.table.detailRanges=[{start:0,end:49999},{start:0,end:49999}];expect(()=>compile(p)).toThrow('meaning_resource_limit');
    });
    it('rejects locale/date guessing and decimal precision loss',()=>{
        const source=structuredClone(raw);source[1][2]='0.001';expect(()=>compile(proposal(),source)).toThrow('meaning_conversion_unresolved');
        source[1][2]='1,234';expect(()=>compile(proposal(),source)).toThrow('meaning_conversion_unresolved');
    });
    it('checks a retained exact duplicate and refuses a nonidentical deletion',()=>{
        const p=proposal(),source=structuredClone(raw);source.push([...source[1]]);p.exclusions.push({row:7,role:'duplicate',duplicateOf:1});expect(compile(p,source).reference.tables[0].rowCount).toBe(3);
        source[7][0]='other';expect(()=>compile(p,source)).toThrow('validation_duplicate_exclusion_invalid');
    });
});
