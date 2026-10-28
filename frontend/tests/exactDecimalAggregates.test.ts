// @vitest-environment node
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueryPlan } from '../types';
import { compileQueryPlanToDuckDbSql, type CompileDuckDbQueryOptions } from '../services/duckdb/queryCompiler';
import { tableToRows } from '../services/workers/duckDbRows';

const duckdb = createRequire(import.meta.url)('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
const wasm = fileURLToPath(new URL('../node_modules/@duckdb/duckdb-wasm/dist/', import.meta.url));
let db: any, conn: any;
const columns = ['OCT 2010', 'NOV 2010', 'DEC 2010'];
const period = columns.join(' + ');
const options: CompileDuckDbQueryOptions = {
    tableName: 'accepted', allowedColumns: columns, exactDecimalColumns: columns,
    exactDecimalUnits: Object.fromEntries(columns.map(column => [column, 'SGD'])),
};
const compile = (plan: QueryPlan, opts = options) => compileQueryPlanToDuckDbSql(plan, opts);
const execute = (plan: QueryPlan, opts = options) => {
    const compiled = compile(plan, opts);
    console.log('SQL', compiled.sql);
    let rows;
    try { rows = tableToRows(conn.query(compiled.sql)); }
    catch (error) { console.log('NATIVE ERROR', String(error)); throw error; }
    console.log('RESULT', JSON.stringify(rows));
    expect(tableToRows(conn.query(compiled.countSql))).toEqual([{ total: 1 }]);
    return rows[0];
};
const aggregate = (fn: NonNullable<QueryPlan['aggregates']>[number]['function'], as = 'n'): QueryPlan => ({ aggregates: [{ function: fn, column: period, as }] });

beforeAll(async () => {
    db = await duckdb.createDuckDB({ mvp: { mainModule: `${wasm}duckdb-mvp.wasm` }, eh: { mainModule: `${wasm}duckdb-eh.wasm` } }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
    await db.instantiate(); db.open({ path: ':memory:', maximumThreads: 1 }); conn = db.connect();
}, 30_000);
afterAll(() => conn?.close());

const load = async (csv: string, types = ['DECIMAL(24,2)', 'DECIMAL(24,2)', 'DECIMAL(24,2)']) => {
    await db.registerFileText('accepted.csv', columns.join(',') + '\n' + csv);
    conn.query('DROP TABLE IF EXISTS accepted');
    // Same explicit typed CSV ingestion as the accepted-file worker, not JS numbers.
    conn.query(`CREATE TABLE accepted AS SELECT * FROM read_csv('accepted.csv', header=true, auto_detect=false, columns={${columns.map((c, i) => `'${c}':'${types[i]}'`).join(',')}}, nullstr='')`);
};

describe('native DuckDB WASM exact decimal period aggregates', () => {
    it.each([1, -1])('keeps distinct cent totals at sign %s near the supported safe-minor ceiling', async sign => {
        const prefix = sign < 0 ? '-' : '';
        await load(`${prefix}90071992547409.90,${prefix}0.01,0\n${prefix}90071992547409.90,${prefix}0.02,0\n`);
        expect(execute(aggregate('count_distinct'))).toEqual({ n: 2 });
        expect(execute(aggregate('sum'))).toEqual({ n: `${prefix}180143985094819.83` });
        expect(execute(aggregate('min'))).toEqual({ n: `${prefix}90071992547409.${sign < 0 ? '92' : '91'}` });
        expect(execute(aggregate('max'))).toEqual({ n: `${prefix}90071992547409.${sign < 0 ? '91' : '92'}` });
        const raw = tableToRows(conn.query('SELECT * FROM accepted'));
        expect(raw[0][columns[0]]).toBe(`${prefix}90071992547409.90`);
        expect(compile(aggregate('count_distinct')).sql).not.toContain('AS DOUBLE');
    });

    it('preserves scale-zero totals beyond safe JS integers as exact integer strings', async () => {
        await load('9007199254740990,1,0\n9007199254740990,0,0\n', columns.map(() => 'DECIMAL(24,0)'));
        expect(execute(aggregate('sum'))).toEqual({ n: '18014398509481981' });
        expect(execute(aggregate('count_distinct'))).toEqual({ n: 2 });
    });

    it('preserves partial NULL, all-NULL and reported zero row semantics', async () => {
        // Synthetic typed table: this does not expand accepted CSV validation to allow missing decimals.
        await load('10,,1\n,2,\n,,\n0,,\n');
        expect(execute({ aggregates: [
            { function: 'count', column: period, as: 'present' },
            { function: 'count_distinct', column: period, as: 'distinct' },
            { function: 'sum', column: period, as: 'sum' },
            { function: 'min', column: period, as: 'min' },
            { function: 'max', column: period, as: 'max' },
        ] })).toEqual({ present: 3, distinct: 3, sum: '13.00', min: '0.00', max: '11.00' });
        await load(',,\n');
        expect(execute(aggregate('sum'))).toEqual({ n: null });
        expect(execute(aggregate('count_distinct'))).toEqual({ n: 0 });
    });

    it('adds compatible decimal scales exactly, applies filters and preserves exact result strings', async () => {
        await load('90071992547409.90,0.000001,1\n90071992547409.90,0.000002,1\n', ['DECIMAL(24,2)', 'DECIMAL(24,6)', 'DECIMAL(24,0)']);
        expect(execute(aggregate('sum'))).toEqual({ n: '180143985094821.800003' });
        expect(execute(aggregate('count_distinct'))).toEqual({ n: 2 });
        expect(execute({ ...aggregate('sum'), where: { predicates: [{ column: columns[1], operator: 'eq', value: '0.000001' }] } })).toEqual({ n: '90071992547410.900001' });
        const filtered = { aggregates: [{ function: 'sum' as const, column: period, as: 'n', where: { predicates: [{ column: columns[1], operator: 'gt' as const, value: '0.000001' }] } }],
            postAggregateFilter: { predicates: [{ column: 'n', operator: 'eq' as const, value: '90071992547410.900002' }] } };
        expect(execute(filtered)).toEqual({ n: '90071992547410.900002' });
    });

    it.each(['VARCHAR', 'DOUBLE', 'BIGINT'])('rejects unproven mixed exact/%s arithmetic before executing approximated SQL', async type => {
        for (let mask = 1; mask < 7; mask++) {
            await load('1,2,3\n', columns.map((_, i) => mask & (1 << i) ? 'DECIMAL(24,2)' : type));
            const mixed = { ...options, exactDecimalColumns: columns.filter((_, i) => mask & (1 << i)) };
            try { console.log('MIXED NATIVE', type, mask, execute(aggregate('sum'), mixed)); }
            catch (error) { console.log('MIXED REJECTED', type, mask, String(error)); }
            for (const fn of ['sum', 'count_distinct', 'min', 'max', 'avg', 'median', 'percentile'] as const) {
                expect(() => compile(aggregate(fn), mixed)).toThrow(/exact_decimal_period_mixed_types_unsupported/);
            }
            expect(execute(aggregate('count'), mixed)).toEqual({ n: 1 });
        }
    });

    it('requires resolved compatible units without guessing a conversion', async () => {
        await load('1,2,3\n');
        for (const units of [undefined, {}, { ...options.exactDecimalUnits, [columns[2]]: 'USD' }]) {
            const opts = { ...options, exactDecimalUnits: units };
            for (const fn of ['sum', 'count_distinct', 'min', 'max', 'avg', 'median', 'percentile'] as const) {
                expect(() => compile(aggregate(fn), opts)).toThrow(/exact_decimal_period_units_require_meaning/);
            }
            expect(execute(aggregate('count'), opts)).toEqual({ n: 1 });
        }
    });

    it('quotes hostile table/alias identifiers without interpolating unit text into SQL', async () => {
        await load('1,2,3\n');
        const alias = 'n"; DROP TABLE accepted; --';
        expect(execute(aggregate('sum', alias), { ...options, exactDecimalUnits: Object.fromEntries(columns.map(c => [c, "SGD'); DROP TABLE accepted; --"])) })).toEqual({ [alias]: '6.00' });
        const sql = compile(aggregate('sum'), { ...options, tableName: 'accepted"; DROP TABLE accepted; --' }).sql;
        expect(sql).toContain('FROM "accepted""; DROP TABLE accepted; --"');
        expect(sql).not.toContain('SGD');
    });

    it('fails closed on native decimal row-total and SUM overflow rather than rounding or NULL', async () => {
        // Deliberately outside accepted safe-minor/product caps to exercise native overflow handling.
        const huge = '999999999999999999999999999999999999.99';
        await load(`${huge},0.01,0\n`, ['DECIMAL(38,2)', 'DECIMAL(38,2)', 'DECIMAL(38,2)']);
        for (const fn of ['sum', 'count_distinct'] as const) {
            expect(() => execute(aggregate(fn))).toThrow(/overflow|out of range/i);
        }
        expect(execute(aggregate('count'))).toEqual({ n: 1 });
        await load(`${huge},0,0\n${huge},0,0\n`, ['DECIMAL(38,2)', 'DECIMAL(38,2)', 'DECIMAL(38,2)']);
        expect(() => execute(aggregate('sum'))).toThrow(/overflow|out of range/i);
    });

    it('leaves ordinary nonexact numeric coercion unchanged in actual DuckDB', async () => {
        await load('1,2,3\n4,,5\n', ['VARCHAR', 'VARCHAR', 'VARCHAR']);
        const ordinary = { tableName: 'accepted', allowedColumns: columns };
        expect(execute(aggregate('sum'), ordinary)).toEqual({ n: 15 });
        expect(execute(aggregate('count_distinct'), ordinary)).toEqual({ n: 2 });
        expect(compile(aggregate('sum'), ordinary).sql).toContain('AS DOUBLE');
    });
});
