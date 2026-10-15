// @vitest-environment node
import {describe,expect,it} from 'vitest';
import {resolveComputationScopeRepair,canRepairComputationScope,type ScopeRepairContext} from '../services/agent/runtime/pi/piScopeRepair';
import {resolveAnswerScope} from '../services/agent/runtime/pi/queryEvidence';
import type {StoreApi} from '../services/agent/types';
const context:ScopeRepairContext={message:'Calculate the quantity-weighted mean Amount over the entire input, preserving exact sums.',artifact:{
    taskSignal:'statistical',expectedOutput:'scalar_answer',referencedColumns:['Amount','Quantity'],groupingColumns:[],aggregationFunctions:[],
    subjectRefs:[],timeScope:{kind:'none'},comparisonScope:{kind:'none'},unresolvedReferences:[],
    filterDescription:'Entire input after repair; preserve facts, units, zeros and excluded-record accounting.',requestedDataPreparation:'canonical_fact_table',
    requestedComputationScope:{method:'weighted_mean',value:'Amount',weight:'Quantity',unitColumn:'Unit',where:{predicates:[]},
        missingPolicy:'pairwise_complete',weightPolicy:'nonnegative_integer_frequency',seed:'none'},
} as ScopeRepairContext['artifact']};
const store={getState:()=>({datasetBundle:{primaryTableId:'facts'},csvData:{data:[{Amount:1,Quantity:2,Unit:'SGD',Team:'North'}]},
    columnProfiles:[{name:'Amount',type:'number'},{name:'Quantity',type:'number'},{name:'Unit',type:'string'},{name:'Team',type:'string'}]})} as unknown as StoreApi;
const proposal={population:'entire_input',goalQuote:'over the entire input'};
describe('bounded typed computation scope repair',()=>{
    it('repairs classifier workflow text without changing goal, method, columns, policies or repair output',()=>{
        const original=structuredClone(context),before=resolveAnswerScope(context.message,context.artifact,undefined,store);
        expect(canRepairComputationScope(before)).toBe(true);
        const after=resolveComputationScopeRepair(context,proposal,store);
        expect(after).toMatchObject({requiresEvidence:true,unresolved:[],dataPreparation:'canonical_fact_table',computation:{
            method:'weighted_mean',value:'Amount',weight:'Quantity',unitColumn:'Unit',missingPolicy:'pairwise_complete',weightPolicy:'nonnegative_integer_frequency',seed:'none',tableId:'facts'}});
        expect(after.computation!.where).toBeUndefined();expect(context).toEqual(original);
    });
    it('leaves actual business filters unresolved rather than inventing or erasing predicates',()=>{
        const filtered={...context,message:'Calculate the weighted mean for Team North.',artifact:{...context.artifact,filterDescription:'Team North'}};
        expect(()=>resolveComputationScopeRepair(filtered,{population:'entire_input',goalQuote:'Team North'},store)).toThrow('scope_repair_explicit_unrestricted_population_required');
        expect(()=>resolveComputationScopeRepair(filtered,{population:'filtered',goalQuote:'Team North',where:{predicates:[{column:'Team',operator:'eq',value:'North'}]}},store)).toThrow('scope_repair_proposal_invalid');
    });
    it.each([null,[],{...proposal,goalQuote:'invented'}, {...proposal,method:'pearson_correlation'}, {...proposal,numerator:'20'},
        {...proposal,where:{}},{...proposal,population:'all'},{...proposal,goalQuote:''}])('rejects malformed or authority-expanding proposals: %j',p=>{
        expect(()=>resolveComputationScopeRepair(context,p,store)).toThrow();
    });
    it.each(['Do not calculate over the entire input.','Calculate over the entire input excluding North.',
        'Calculate only North over the entire input.','Calculate over the entire input where Amount is positive.','Calculate over the entire input for North.','Calculate over the entire input in October.'])('refuses negated or restricted full-population quotes: %s',message=>{
        expect(()=>resolveComputationScopeRepair({...context,message},proposal,store)).toThrow('scope_repair_explicit_unrestricted_population_required');
    });
    it('cannot erase known entities, time scope, predicates, unresolved references or a resolved scope',()=>{
        const base=context.artifact;
        const variants=[{...base,subjectRefs:['North']},{...base,timeScope:{kind:'explicit',value:'October 2026'}},
            {...base,unresolvedReferences:['which year']},{...base,requestedComputationScope:{...base.requestedComputationScope!,where:{predicates:[{column:'Team',operator:'eq',value:'North'}]}}},
            {...base,filterDescription:null}];
        for(const artifact of variants)expect(()=>resolveComputationScopeRepair({...context,artifact} as ScopeRepairContext,proposal,store)).toThrow();
    });
});
