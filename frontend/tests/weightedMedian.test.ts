// @vitest-environment node
import {describe,expect,it} from 'vitest';
import {referenceWeightedMedian,type WeightedMedianScope} from '../services/agent/execution/weightedMedian';
import {resolveAnswerScope} from '../services/agent/runtime/pi/queryEvidence';
import type {StoreApi} from '../services/agent/types';
import {buildFixtureSuite} from '../scripts/coding-agent-evaluation/fixtureKit.mjs';

const scope:WeightedMedianScope={method:'lower_weighted_median',value:'Amount',weight:'Quantity',missingPolicy:'pairwise_complete',weightPolicy:'nonnegative_integer_frequency',seed:'none'};
describe('independent lower weighted median reference',()=>{
    const resolve=(computation:unknown)=>resolveAnswerScope('Calculate the lower weighted median in this dataset.',{
        taskSignal:'statistical',expectedOutput:'scalar_answer',requestedComputationScope:computation,timeScope:{kind:'none'},unresolvedReferences:[]
    } as never,undefined,{getState:()=>({datasetBundle:{primaryTableId:'facts'},csvData:{data:[{Amount:1,Quantity:2,Unit:'SGD'}]},columnProfiles:[
        {name:'Amount',type:'number'},{name:'Quantity',type:'number'},{name:'Unit',type:'string'}]})} as unknown as StoreApi);
    it('fixes the canonical full computation scope in the current primary table',()=>{
        expect(resolve({...scope,unitColumn:'Unit'})).toMatchObject({complete:true,unresolved:[],computation:{tableId:'facts',value:'Amount',weight:'Quantity',unitColumn:'Unit'}});
    });
    it.each([{weightPolicy:'fractional'}, {weight:'Amount'}, {unitColumn:''}, {unitColumn:'Amount'}, {tableId:'foreign'}, {seed:17}, {modelEvidenceId:'invented'}])
        ('refuses invalid policies, aliases and model-provided extra authority: %j',patch=>{
        const result=resolve({...scope,...patch});expect(result.computation).toBeUndefined();expect(result.unresolved.length).toBeGreaterThan(0);
    });
    it('selects the lower observed value at an exact half; never averages the two middle values',()=>{
        expect(referenceWeightedMedian([{Amount:10,Quantity:1},{Amount:30,Quantity:1}],scope)).toMatchObject({median:10,totalWeight:2,n:2});
    });
    it('preserves negative and zero values, duplicates and zero frequency rows',()=>{
        expect(referenceWeightedMedian([{Amount:0,Quantity:2},{Amount:-5,Quantity:2},{Amount:-5,Quantity:1},{Amount:-999,Quantity:0}],scope))
            .toMatchObject({median:-5,totalWeight:5,n:3,zeroWeightRows:1,excluded:0,scopedRows:4});
    });
    it('checks the result against independently expanded observations across weights and input permutations',()=>{
        for(let a=0;a<=4;a++)for(let b=0;b<=4;b++)for(let c=0;c<=4;c++){
            const rows=[{Amount:-3,Quantity:a},{Amount:0,Quantity:b},{Amount:7,Quantity:c}];
            const expanded=[...Array(a).fill(-3),...Array(b).fill(0),...Array(c).fill(7)];
            const expected=expanded.length?expanded[Math.ceil(expanded.length/2)-1]:null;
            for(const data of [rows,[...rows].reverse()])expect(referenceWeightedMedian(data,scope).median).toBe(expected);
        }
    });
    it('counts missing pairs separately and reports no weighted population explicitly',()=>{
        expect(referenceWeightedMedian([{Amount:null,Quantity:2},{Amount:10,Quantity:null},{Amount:20,Quantity:0}],scope))
            .toMatchObject({median:null,totalWeight:0,n:0,excluded:2,zeroWeightRows:1});
        expect(referenceWeightedMedian([],scope)).toMatchObject({median:null,totalWeight:0,scopedRows:0});
    });
    it.each([-1,0.5,Infinity,NaN,'2',true,Number.MAX_SAFE_INTEGER+1])('refuses invalid frequency weights, even alongside a missing value: %s',Quantity=>{
        expect(()=>referenceWeightedMedian([{Amount:null,Quantity}],scope)).toThrow('nonnegative_safe_integer_weight_required');
    });
    it.each([Infinity,NaN,'3',true])('refuses untyped or nonfinite values: %s',Amount=>{
        expect(()=>referenceWeightedMedian([{Amount,Quantity:1}],scope)).toThrow('typed_numeric_input_required');
    });
    it('compares near-safe-integer half boundaries exactly and refuses unsafe totals',()=>{
        expect(referenceWeightedMedian([{Amount:10,Quantity:4503599627370495},{Amount:20,Quantity:4503599627370496}],scope).median).toBe(20);
        expect(()=>referenceWeightedMedian([{Amount:10,Quantity:Number.MAX_SAFE_INTEGER},{Amount:20,Quantity:1}],scope)).toThrow('weight_total_out_of_range');
    });
    it('refuses mixed or missing units when a unit column is part of the fixed scope',()=>{
        const fixed={...scope,unitColumn:'Unit'};
        expect(referenceWeightedMedian([{Amount:10,Quantity:1,Unit:'SGD'}],fixed).unit).toBe('SGD');
        expect(()=>referenceWeightedMedian([{Amount:10,Quantity:1,Unit:'SGD'},{Amount:20,Quantity:1,Unit:'USD'}],fixed)).toThrow('mixed_or_missing_units');
        expect(()=>referenceWeightedMedian([{Amount:10,Quantity:1}],fixed)).toThrow('mixed_or_missing_units');
    });
    it('computes over all 5,001 records; the final heavy observation changes the median',()=>{
        const rows=[...Array.from({length:5000},()=>({Amount:0,Quantity:1})),{Amount:99,Quantity:5001}];
        expect(referenceWeightedMedian(rows,scope)).toMatchObject({median:99,totalWeight:10001,n:5001,scopedRows:5001});
    });
    it('matches the unchanged evaluator-only S8-2 October oracle without exposing it to the agent',()=>{
        const oracle=JSON.parse(buildFixtureSuite().files.get('evaluator/S8-2/oracle.json'));
        const rows=oracle.expectedFacts.filter((r:Record<string,unknown>)=>String(r.date)>='2026-10-01'&&String(r.date)<'2026-11-01');
        const result=referenceWeightedMedian(rows,{...scope,value:'amount_minor',weight:'quantity',unitColumn:'unit'});
        expect(result).toMatchObject({median:oracle.answer.amount_minor,totalWeight:oracle.answer.total_weight,unit:oracle.answer.unit});
    });
});
