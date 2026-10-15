// @vitest-environment node
import {describe,expect,it} from 'vitest';
import {buildFixtureSuite} from '../scripts/coding-agent-evaluation/fixtureKit.mjs';
import {referenceWeightedMean,type WeightedMeanScope} from '../services/agent/execution/weightedMean';
import {computationMismatchFields} from '../services/agent/execution/computationEvidence';
import {resolveAnswerScope} from '../services/agent/runtime/pi/queryEvidence';
import type {StoreApi} from '../services/agent/types';
const scope:WeightedMeanScope={method:'weighted_mean',value:'Amount',weight:'Quantity',missingPolicy:'pairwise_complete',weightPolicy:'nonnegative_integer_frequency',seed:'none'};
describe('exact integer-frequency weighted mean',()=>{
    it('preserves unreduced numerator/denominator, zeros, losses and missing/zero counts',()=>{
        expect(referenceWeightedMean([{Amount:-5,Quantity:2},{Amount:0,Quantity:2},{Amount:42,Quantity:0},{Amount:null,Quantity:1},{Amount:9,Quantity:null}],scope))
            .toEqual({method:'weighted_mean',methodVersion:1,seed:'none',scopedRows:5,n:2,excluded:2,zeroWeightRows:1,numerator:'-10',denominator:'4',mean:-2.5,unit:null});
        expect(referenceWeightedMean([],scope)).toMatchObject({numerator:'0',denominator:'0',mean:null,n:0});
        expect(referenceWeightedMean([{Amount:0,Quantity:2}],scope)).toMatchObject({numerator:'0',denominator:'2',mean:0});
    });
    it('retains cancellation and sums beyond Number safe integers in either input order',()=>{
        const rows=[{Amount:Number.MAX_SAFE_INTEGER,Quantity:Number.MAX_SAFE_INTEGER},{Amount:1,Quantity:1},{Amount:-Number.MAX_SAFE_INTEGER,Quantity:Number.MAX_SAFE_INTEGER}];
        for(const input of [rows,[...rows].reverse()])expect(referenceWeightedMean(input,scope)).toMatchObject({numerator:'1',denominator:'18014398509481983'});
        expect(referenceWeightedMean(rows.slice(0,1),scope)).toMatchObject({numerator:'81129638414606663681390495662081',denominator:'9007199254740991'});
    });
    it.each([-1,0.5,Infinity,NaN,'2',true,Number.MAX_SAFE_INTEGER+1])('rejects invalid weights even for a missing value: %s',Quantity=>{
        expect(()=>referenceWeightedMean([{Amount:null,Quantity}],scope)).toThrow('nonnegative_safe_integer_weight_required');
    });
    it.each([0.1,Infinity,NaN,'3',true,Number.MAX_SAFE_INTEGER+1])('rejects inexact/untyped source values: %s',Amount=>{
        expect(()=>referenceWeightedMean([{Amount,Quantity:1}],scope)).toThrow('typed_safe_integer_value_required');
    });
    it('refuses mixed/missing contributing units and ignores noncontributing units',()=>{
        const unitScope={...scope,unitColumn:'Unit'};
        expect(()=>referenceWeightedMean([{Amount:1,Quantity:1,Unit:'SGD'},{Amount:2,Quantity:1,Unit:'USD'}],unitScope)).toThrow('mixed_or_missing_units');
        expect(()=>referenceWeightedMean([{Amount:1,Quantity:1}],unitScope)).toThrow('mixed_or_missing_units');
        expect(referenceWeightedMean([{Amount:1,Quantity:1,Unit:'SGD'},{Amount:2,Quantity:0,Unit:'USD'}],unitScope).unit).toBe('SGD');
    });
    it('rejects numeric, rounded, reduced or noncanonical exact sums without leaking reference values',()=>{
        const expected=referenceWeightedMean([{Amount:3,Quantity:2}],scope);
        for(const patch of [{numerator:6},{numerator:'06'},{numerator:'3',denominator:'1'},{denominator:'2.0'},{mean:4}]){
            const fields=computationMismatchFields({...expected,...patch},expected,0);
            expect(fields.length).toBeGreaterThan(0);expect(JSON.stringify(fields)).not.toContain('6');
        }
    });
    it('normalizes one typed scope while refusing ambiguous columns or unsupported policies',()=>{
        const resolve=(patch:object)=>resolveAnswerScope('Calculate the weighted mean in this dataset.',{taskSignal:'statistical',expectedOutput:'scalar_answer',
            requestedComputationScope:{...scope,...patch},timeScope:{kind:'none'},unresolvedReferences:[]} as never,undefined,
        {getState:()=>({datasetBundle:{primaryTableId:'facts'},csvData:{data:[{Amount:1,Quantity:2}]},columnProfiles:[{name:'Amount',type:'number'},{name:'Quantity',type:'number'}]})} as unknown as StoreApi);
        expect(resolve({where:{predicates:[],groups:[]}})).toMatchObject({complete:true,unresolved:[]});
        for(const where of [{predicates:null},{predicates:[],other:true},{groups:[{predicates:[]}]},{predicates:'all'}])expect(resolve({where}).computation).toBeUndefined();
        expect(resolve({where:{predicates:[]}})).toMatchObject({complete:true,unresolved:[],computation:{method:'weighted_mean',tableId:'facts'}});
        expect(resolve({})).toMatchObject({complete:true,unresolved:[],computation:{method:'weighted_mean',tableId:'facts'}});
        for(const patch of [{weight:'Amount'},{weightPolicy:'fractional'},{method:'arbitrary'},{seed:1},{numerator:'6'}])expect(resolve(patch).computation).toBeUndefined();
    });
    it('matches the generated evaluator-only S8-4 oracle using all 13 facts',()=>{
        const oracle=JSON.parse(buildFixtureSuite().files.get('evaluator/S8-4/oracle.json'));
        expect(referenceWeightedMean(oracle.expectedFacts,{...scope,value:'amount_minor',weight:'quantity',unitColumn:'unit'}))
            .toMatchObject({numerator:String(oracle.answer.numerator),denominator:String(oracle.answer.denominator),mean:1187+1/3,unit:oracle.answer.unit,n:13,scopedRows:13});
    });
});
