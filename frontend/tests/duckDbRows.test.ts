// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Decimal, makeData, makeVector, Table, vectorFromArray, Utf8 } from 'apache-arrow';
import { tableToRows } from '../services/workers/duckDbRows';

const decimalTable = (unscaled: bigint, scale = 0) => {
    const bits = BigInt.asUintN(128, unscaled);
    const data = new Uint32Array(Array.from({length:4}, (_, i) => Number((bits >> BigInt(i*32)) & 0xffffffffn)));
    return new Table({total: makeVector(makeData({type: new Decimal(scale, 38, 128), length:1, data}))});
};

describe('DuckDB Arrow results across the worker serialization boundary', () => {
    it.each([
        [0n, 0, 0], [999994n, 0, 999994], [-999994n, 0, -999994],
        [9007199254740991n, 0, 9007199254740991],
        [9007199254740992n, 0, '9007199254740992'],
        [-9007199254740992n, 0, '-9007199254740992'],
        [12345n, 2, '123.45'], [-5n, 2, '-0.05'],
        [12345678901234567890123456789012345678n, 8, '123456789012345678901234567890.12345678'],
        [12n, -2, 1200],
    ])('preserves unscaled %s with scale %s', (unscaled, scale, expected) => {
        const rows = tableToRows(decimalTable(unscaled as bigint, scale as number));
        expect(structuredClone(rows)).toEqual([{total:expected}]);
        expect(JSON.parse(JSON.stringify(rows))).toEqual([{total:expected}]);
    });
    it('preserves VARCHAR dates and nulls without inference', () => {
        expect(tableToRows(new Table({value:vectorFromArray(['02-12-2010', null], new Utf8())})))
            .toEqual([{value:'02-12-2010'}, {value:null}]);
    });
    it('retains safe integer, unsafe integer and Date conversion', () => {
        const table = {numRows:1,numCols:3,schema:{fields:[{name:'safe'},{name:'unsafe'},{name:'date'}]},
            getChildAt:(i:number) => ({get:() => [5n,9007199254740992n,new Date('2026-10-13T00:00:00Z')][i]})};
        expect(tableToRows(table)).toEqual([{safe:5,unsafe:'9007199254740992',date:'2026-10-13'}]);
    });
    it.each([new Uint32Array(2), 'unverified'])('refuses malformed decimal cells instead of legacy fallback', value => {
        const table = {numRows:1,numCols:1,schema:{fields:[{name:'total',type:{typeId:7,scale:0}}]},
            getChildAt:() => ({get:() => value}),toArray:() => [{toJSON:() => ({total:5})}]};
        expect(() => tableToRows(table)).toThrow('sql_decimal_invalid');
    });
});
