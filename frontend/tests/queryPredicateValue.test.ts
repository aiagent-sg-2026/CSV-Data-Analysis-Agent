import {describe,expect,it} from 'vitest';
import {executeDataQuery} from '../services/agent/execution/dataQueryExecutor';
import {executeArqueroQuery} from '../services/data/arqueroEngine';
import {orderedPredicateValue} from '../services/agent/execution/queryPredicateValue';
import type {QueryPlan} from '../types';

const rows=[{Date:'2026-09-30',Amount:999},{Date:'2026-10-01',Amount:10},{Date:'2026-10-31',Amount:20},{Date:'2026-11-01',Amount:888}];
describe('ordered ISO query predicates',()=>{
    it.each(['native','arquero'])('executes the exact October interval in %s',engine=>{
        const plan:QueryPlan={select:['Amount'],where:{predicates:[{column:'Date',operator:'gte',value:'2026-10-01'},{column:'Date',operator:'lt',value:'2026-11-01'}]}};
        const result=engine==='native'?executeDataQuery(rows,plan):executeArqueroQuery(rows,plan).result;
        expect(result.rows.map(r=>r.Amount)).toEqual([10,20]);expect(result.totalMatchedRows).toBe(2);
    });
    it.each(['native','arquero'])('preserves inclusive between and OR branch semantics in %s',engine=>{
        const plan:QueryPlan={select:['Amount'],where:{groups:[{predicates:[{column:'Date',operator:'between',value:['2026-10-01','2026-10-31']}]},{predicates:[{column:'Amount',operator:'eq',value:888}]}]}};
        const result=engine==='native'?executeDataQuery(rows,plan):executeArqueroQuery(rows,plan).result;
        expect(result.rows.map(r=>r.Amount)).toEqual([10,20,888]);
    });
    it('keeps finite numeric/formatted comparisons and rejects invalid dates',()=>{
        expect(orderedPredicateValue('2026-02-30')).toBeNull();expect(orderedPredicateValue('2026-10-01T12:00')).toBeNull();
        expect(orderedPredicateValue('2026-10-01T12:00:00+08:00')).toBe(Date.parse('2026-10-01T04:00:00Z'));
        expect(orderedPredicateValue('1,234.00')).toBe(1234);
    });
});
