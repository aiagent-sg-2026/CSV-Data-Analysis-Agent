import type {WeightedMedianScope} from './weightedMedian';

export interface WeightedMeanScope extends Omit<WeightedMedianScope,'method'> { method:'weighted_mean' }
export interface WeightedMeanResult {
    method:'weighted_mean'; methodVersion:1; seed:'none'; scopedRows:number; n:number; excluded:number;
    zeroWeightRows:number; numerator:string; denominator:string; mean:number|null; unit:string|null;
}
const missing=(value:unknown)=>value===null||value===undefined||value==='';

/** Integer source values and frequency weights keep the unreduced sums exact across JSON boundaries.
 * The numeric quotient is a display derivative; it never replaces either integer sum. */
export const referenceWeightedMean=(rows:Record<string,unknown>[],scope:WeightedMeanScope):WeightedMeanResult=>{
    let numerator=0n,denominator=0n,n=0,excluded=0,zeroWeightRows=0,unit:string|null=null;
    for(const row of rows){
        const value=row[scope.value],weight=row[scope.weight];
        if(!missing(weight)&&(typeof weight!=='number'||!Number.isSafeInteger(weight)||weight<0))throw new Error('nonnegative_safe_integer_weight_required');
        if(missing(value)||missing(weight)){excluded++;continue;}
        if(typeof value!=='number'||!Number.isSafeInteger(value))throw new Error('typed_safe_integer_value_required');
        if(weight===0){zeroWeightRows++;continue;}
        if(scope.unitColumn){
            const actual=row[scope.unitColumn];
            if(typeof actual!=='string'||!actual.trim()||unit!==null&&unit!==actual)throw new Error('mixed_or_missing_units');
            unit=actual;
        }
        const frequency=BigInt(weight as number);
        numerator+=BigInt(value)*frequency;denominator+=frequency;n++;
    }
    return {method:'weighted_mean',methodVersion:1,seed:'none',scopedRows:rows.length,n,excluded,zeroWeightRows,
        numerator:numerator.toString(),denominator:denominator.toString(),mean:denominator===0n?null:Number(numerator)/Number(denominator),unit};
};
