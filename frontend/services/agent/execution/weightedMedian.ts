import type {QueryPlan} from '../../../types';

export interface WeightedMedianScope {
    method:'lower_weighted_median'; value:string; weight:string; unitColumn?:string; where?:QueryPlan['where'];
    missingPolicy:'pairwise_complete'; weightPolicy:'nonnegative_integer_frequency'; seed:'none'; tableId?:string;
}
export interface WeightedMedianResult {
    method:'lower_weighted_median'; methodVersion:1; seed:'none'; scopedRows:number; n:number; excluded:number;
    zeroWeightRows:number; totalWeight:number; median:number|null; unit:string|null;
}
const missing=(v:unknown)=>v===null||v===undefined||v==='';

/** Host frequency reference, independent of guest source. Integer cumulative comparisons use BigInt
 * so an exact half selects the lower observation without rounding or midpoint interpolation. */
export const referenceWeightedMedian=(rows:Record<string,unknown>[],scope:WeightedMedianScope):WeightedMedianResult=>{
    const observations:Array<{value:number;weight:bigint}>=[];
    let excluded=0,zeroWeightRows=0,total=0n,unit:string|null=null;
    for(const row of rows){
        const value=row[scope.value],weight=row[scope.weight];
        if(!missing(weight)&&(typeof weight!=='number'||!Number.isSafeInteger(weight)||weight<0))throw new Error('nonnegative_safe_integer_weight_required');
        if(missing(value)||missing(weight)){excluded++;continue;}
        if(typeof value!=='number'||!Number.isFinite(value))throw new Error('typed_numeric_input_required');
        if(weight===0){zeroWeightRows++;continue;}
        if(scope.unitColumn){
            const actual=row[scope.unitColumn];
            if(typeof actual!=='string'||!actual.trim()||unit!==null&&unit!==actual)throw new Error('mixed_or_missing_units');
            unit=actual;
        }
        const frequency=BigInt(weight as number);total+=frequency;
        if(total>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('weight_total_out_of_range');
        observations.push({value,weight:frequency});
    }
    observations.sort((a,b)=>a.value<b.value?-1:a.value>b.value?1:0);
    let cumulative=0n,median:number|null=null;
    for(const observation of observations){cumulative+=observation.weight;if(2n*cumulative>=total){median=observation.value;break;}}
    return {method:'lower_weighted_median',methodVersion:1,seed:'none',scopedRows:rows.length,n:observations.length,excluded,
        zeroWeightRows,totalWeight:Number(total),median,unit};
};
