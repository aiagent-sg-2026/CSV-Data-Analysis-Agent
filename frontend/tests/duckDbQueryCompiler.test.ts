// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { compileQueryPlanToDuckDbSql } from '../services/duckdb/queryCompiler';
import { normalizeDataQueryPayload } from '../services/agent/execution/dataQueryContract';
import { executeDataQuery } from '../services/agent/execution/dataQueryExecutor';

describe('compileQueryPlanToDuckDbSql', () => {
    it('keeps accepted DECIMAL sums typed while ordinary CSV retains numeric coercion',()=>{
        const plan={aggregates:[{function:'sum' as const,column:'value',as:'total'}]};
        const options={allowedColumns:['value','other'],tableName:'session_clean_dataset'};
        expect(compileQueryPlanToDuckDbSql(plan,{...options,exactDecimalColumns:['value']}).sql).toContain('SUM("value") AS "total"');
        expect(compileQueryPlanToDuckDbSql(plan,options).sql).toContain('TRY_CAST');
        expect(compileQueryPlanToDuckDbSql({aggregates:[{function:'sum',column:'OCT 2010 + NOV 2010 + DEC 2010',as:'total'}]},
            {tableName:options.tableName,allowedColumns:['OCT 2010','NOV 2010','DEC 2010'],exactDecimalColumns:['OCT 2010','NOV 2010','DEC 2010']}).sql)
            .toContain('SUM("OCT 2010" + "NOV 2010" + "DEC 2010")');
    });
    it('compares accepted DECIMAL filters as exact base-10 values, including groups and aggregate filters',()=>{
        const options={allowedColumns:['value'],tableName:'session_clean_dataset',exactDecimalColumns:['value']};
        const eq={column:'value',operator:'eq' as const,value:-90071992547409.9};
        const sql=compileQueryPlanToDuckDbSql({where:{predicates:[eq],groups:[{predicates:[{column:'value',operator:'in',value:['-90071992547409.90','0.00']}]}]},
            aggregates:[{function:'sum',column:'value',as:'total',where:{predicates:[eq]}}]},options).sql;
        expect(sql).toContain('"value" = CAST(\'-90071992547409.9\' AS DECIMAL(38,1))');
        expect(sql).toContain('"value" IN (CAST(\'-90071992547409.90\' AS DECIMAL(38,2)), CAST(\'0.00\' AS DECIMAL(38,2)))');
        expect(sql).toContain('FILTER (WHERE ("value" = CAST(');
        expect(sql).not.toContain('AS DOUBLE');
        expect(compileQueryPlanToDuckDbSql({aggregates:[{function:'sum',column:'value',as:'total'}],
            postAggregateFilter:{predicates:[{column:'total',operator:'eq',value:'-180143985094819.80'}]}},options).sql)
            .toContain('"total" = CAST(\'-180143985094819.80\' AS DECIMAL(38,2))');
        for(const operator of ['neq','gt','gte','lt','lte','not_in','between'] as const){
            const value=operator==='between'?['-0.01','0.01']:operator==='not_in'?['0.00']:'0.00';
            expect(compileQueryPlanToDuckDbSql({where:{predicates:[{column:'value',operator,value}]}},options).sql).toContain('CAST(\'0.0');
        }
        expect(()=>compileQueryPlanToDuckDbSql({where:{predicates:[{...eq,value:"0'); SELECT 1 --"}]}},options)).toThrow('exact decimal');
    });

    it('compiles projection, filter, order, and limit into generated SQL', () => {
        const compiled = compileQueryPlanToDuckDbSql({
            select: ['Region', 'Revenue'],
            where: {
                predicates: [{ column: 'Region', operator: 'eq', value: 'East' }],
            },
            orderBy: [{ column: 'Revenue', direction: 'desc' }],
            limit: 10,
        }, {
            allowedColumns: ['Region', 'Revenue', 'Rep'],
            tableName: 'session_clean_dataset',
        });

        expect(compiled.sql).toContain('SELECT "Region", "Revenue"');
        expect(compiled.sql).toContain('FROM "session_clean_dataset"');
        expect(compiled.sql).toContain('ORDER BY "Revenue" DESC');
        expect(compiled.sql).toContain('LIMIT 10');
        expect(compiled.countSql).toContain('COUNT(*) AS total');
    });

    it('expands a normalized select ["*"] to every allowed column within the row cap', () => {
        const { plan } = normalizeDataQueryPayload({
            explanation: 'Preview the top rows.',
            plan: { select: ['*'], orderBy: [{ column: 'Revenue', direction: 'desc' }], limit: 2 },
        });
        const options = { allowedColumns: ['Region', 'Revenue', 'Rep'], tableName: 'session_clean_dataset' };
        const compiled = compileQueryPlanToDuckDbSql(plan, options);

        expect(compiled.selectedColumns).toEqual(['Region', 'Revenue', 'Rep']);
        expect(compiled.sql).toContain('SELECT "Region", "Revenue", "Rep"');
        expect(compiled.sql).toContain('ORDER BY "Revenue" DESC');
        expect(compiled.sql).toContain('LIMIT 2');
        expect(compileQueryPlanToDuckDbSql({ ...plan, limit: 100_000 }, { ...options, maxRows: 500 }).appliedLimit).toBe(500);

        // The in-memory fallback engine receives the same normalized plan.
        const fallback = executeDataQuery([
            { Region: 'East', Revenue: 10, Rep: 'A' },
            { Region: 'West', Revenue: 30, Rep: 'B' },
            { Region: 'North', Revenue: 20, Rep: 'C' },
        ], plan, { allowedColumns: options.allowedColumns });
        expect(fallback.selectedColumns).toEqual(['Region', 'Revenue', 'Rep']);
        expect(fallback.rows.map(row => row.Region)).toEqual(['West', 'North']);
    });

    it('explains how to recover when "*" would exceed the column cap', () => {
        const allowedColumns = Array.from({ length: 60 }, (_, index) => `col_${index}`);
        const { plan } = normalizeDataQueryPayload({ explanation: 'Preview.', plan: { select: ['*'], limit: 5 } });

        expect(() => compileQueryPlanToDuckDbSql(plan, { allowedColumns, tableName: 'session_clean_dataset', maxColumns: 50 }))
            .toThrow('Query select exceeds the maximum allowed column count (50). The table has 60 columns, so list at most 50 explicit column names in plan.select instead of "*" or an omitted select.');
    });

    it('fails closed on invalid columns', () => {
        expect(() => compileQueryPlanToDuckDbSql({
            select: ['MissingColumn'],
        }, {
            allowedColumns: ['Region'],
            tableName: 'session_clean_dataset',
        })).toThrow(/missing column/i);
    });

    it('does not permit ordering by a non-selected column in explicit projection mode', () => {
        expect(() => compileQueryPlanToDuckDbSql({
            select: ['Region'],
            orderBy: [{ column: 'Revenue', direction: 'desc' }],
        }, {
            allowedColumns: ['Region', 'Revenue'],
            tableName: 'session_clean_dataset',
        })).toThrow(/must also appear in select/i);
    });

    it('compiles grouped aggregate plans into a derived aggregate query', () => {
        const compiled = compileQueryPlanToDuckDbSql({
            groupBy: ['Region'],
            aggregates: [
                { function: 'sum', column: 'Revenue', as: 'TotalRevenue' },
                { function: 'count', as: 'RowCount' },
            ],
            orderBy: [{ column: 'TotalRevenue', direction: 'desc' }],
            limit: 5,
        }, {
            allowedColumns: ['Region', 'Revenue'],
            tableName: 'session_clean_dataset',
        });

        // Missing markers stay NULL instead of being coalesced to 0.
        expect(compiled.sql).toContain('SUM(CASE WHEN (TRIM(COALESCE(CAST("Revenue" AS VARCHAR), \'\')) = \'\' OR LOWER(');
        expect(compiled.sql).toContain('TRY_CAST(NULLIF(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(');
        expect(compiled.sql).not.toContain('SUM(COALESCE(');
        expect(compiled.sql).toContain('CAST("Revenue" AS VARCHAR)');
        expect(compiled.sql).toContain('COUNT(*) AS "RowCount"');
        expect(compiled.sql).toContain('GROUP BY "Region"');
        expect(compiled.sql).toContain('FROM (SELECT');
        expect(compiled.sql).toContain('ORDER BY "TotalRevenue" DESC');
        expect(compiled.countSql).toContain('FROM (SELECT');
    });

    it('preserves aggregate aliases when an explicit projection only lists the group column', () => {
        const compiled = compileQueryPlanToDuckDbSql({
            select: ['Ad name'],
            groupBy: ['Ad name'],
            aggregates: [
                { function: 'sum', column: 'Spend', as: 'total_spend' },
                { function: 'sum', column: 'Results', as: 'total_results' },
            ],
        }, {
            allowedColumns: ['Ad name', 'Spend', 'Results'],
            tableName: 'session_clean_dataset',
        });

        expect(compiled.selectedColumns).toEqual(['Ad name', 'total_spend', 'total_results']);
        expect(compiled.sql).toContain('SELECT "Ad name", "total_spend", "total_results" FROM');
    });

    it('compiles aggregate-scoped filters into conditional aggregation SQL', () => {
        const compiled = compileQueryPlanToDuckDbSql({
            groupBy: ['Project'],
            aggregates: [
                {
                    function: 'sum',
                    column: 'Value',
                    as: 'total_revenue',
                    where: {
                        predicates: [{ column: 'Description', operator: 'in', value: ['Revenue'] }],
                    },
                },
                {
                    function: 'sum',
                    column: 'Value',
                    as: 'total_cost',
                    where: {
                        predicates: [{ column: 'Description', operator: 'in', value: ['Cost of Sales'] }],
                    },
                },
            ],
            select: ['Project', 'total_revenue', 'total_cost'],
        }, {
            allowedColumns: ['Project', 'Description', 'Value'],
            tableName: 'session_clean_dataset',
        });

        expect(compiled.sql).toContain('THEN NULL ELSE TRY_CAST(NULLIF(');
        expect(compiled.sql).not.toContain('SUM(COALESCE(');
        expect(compiled.sql).toContain('FILTER (WHERE');
        expect(compiled.sql).toContain(`LOWER(COALESCE(CAST("Description" AS VARCHAR), '')) IN ('revenue')`);
        expect(compiled.sql).toContain(`LOWER(COALESCE(CAST("Description" AS VARCHAR), '')) IN ('cost of sales')`);
        expect(compiled.sql).not.toContain('WHERE (LOWER(COALESCE(CAST("Description" AS VARCHAR), \'\')) IN (\'revenue\')) OR (LOWER(COALESCE(CAST("Description" AS VARCHAR), \'\')) IN (\'cost of sales\')) GROUP BY');
    });

    it('ANDs shared predicates with the OR-group envelope', () => {
        const compiled = compileQueryPlanToDuckDbSql({
            where: {
                predicates: [{ column: 'RowRole', operator: 'eq', value: 'detail' }],
                groups: [
                    { predicates: [{ column: 'Month', operator: 'eq', value: '2020-01' }] },
                    { predicates: [{ column: 'Month', operator: 'eq', value: '2025-01' }] },
                ],
            },
            groupBy: ['Month'],
            aggregates: [{ function: 'avg', column: 'Revenue', as: 'AverageRevenue' }],
        }, {
            allowedColumns: ['RowRole', 'Month', 'Revenue'],
            tableName: 'session_clean_dataset',
        });

        expect(compiled.sql).toContain(`LOWER(COALESCE(CAST("RowRole" AS VARCHAR), '')) = 'detail')`);
        expect(compiled.sql).toContain(' AND (');
        expect(compiled.sql).toContain(`LOWER(COALESCE(CAST("Month" AS VARCHAR), '')) = '2020-01'`);
        expect(compiled.sql).toContain(' OR ');
        expect(compiled.sql).toContain(`LOWER(COALESCE(CAST("Month" AS VARCHAR), '')) = '2025-01'`);
    });

    it('lowers quarter expressions into real period columns for wide-pivot aggregates', () => {
        const compiled = compileQueryPlanToDuckDbSql({
            groupBy: ['STAFF NAME'],
            aggregates: [
                {
                    function: 'sum',
                    column: 'OCT 2010 + NOV 2010 + DEC 2010',
                    as: 'Q4_2010_TOTAL',
                },
            ],
            select: ['STAFF NAME', 'Q4_2010_TOTAL'],
            orderBy: [{ column: 'Q4_2010_TOTAL', direction: 'desc' }],
            limit: 5,
        }, {
            allowedColumns: ['STAFF NAME', 'OCT 2010', 'NOV 2010', 'DEC 2010', 'TOTAL'],
            tableName: 'session_clean_dataset',
        });

        expect(compiled.sql).toContain('COALESCE(');
        expect(compiled.sql).toContain('CAST("OCT 2010" AS VARCHAR)');
        expect(compiled.sql).toContain('CAST("NOV 2010" AS VARCHAR)');
        expect(compiled.sql).toContain('CAST("DEC 2010" AS VARCHAR)');
        expect(compiled.sql).toContain('AS "Q4_2010_TOTAL"');
        expect(compiled.sql).not.toContain('"OCT 2010 + NOV 2010 + DEC 2010"');
    });

    it('sanitizes formatted numeric strings before numeric comparisons and aggregates', () => {
        const compiled = compileQueryPlanToDuckDbSql({
            where: {
                predicates: [{ column: 'Value', operator: 'gt', value: 1000 }],
            },
            aggregates: [{ function: 'sum', column: 'Value', as: 'total_value' }],
        }, {
            allowedColumns: ['Value'],
            tableName: 'session_clean_dataset',
        });

        expect(compiled.sql).toContain("REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(");
        expect(compiled.sql).toContain("',', '')");
        expect(compiled.sql).toContain("'$', '')");
        expect(compiled.sql).toContain("'%', '')");
        expect(compiled.sql).toContain("LIKE '(%'");
        expect(compiled.sql).toContain('TRY_CAST(NULLIF(');
    });

    it('compiles ISO month and date ranges as ordered text comparisons', () => {
        const compiled = compileQueryPlanToDuckDbSql({
            select: ['month', 'resale_price'],
            where: {
                predicates: [
                    { column: 'month', operator: 'gte', value: '2024-01' },
                    { column: 'month', operator: 'lt', value: '2025-01' },
                ],
            },
        }, {
            allowedColumns: ['month', 'resale_price'],
            tableName: 'session_clean_dataset',
        });

        expect(compiled.sql).toContain(`TRIM(COALESCE(CAST("month" AS VARCHAR), '')) >= '2024-01'`);
        expect(compiled.sql).toContain(`TRIM(COALESCE(CAST("month" AS VARCHAR), '')) < '2025-01'`);
        expect(compiled.sql).not.toContain(`TRY_CAST(NULLIF(TRIM(COALESCE(CAST("month" AS VARCHAR), ''))`);
    });

    it('compiles ISO date between filters without weakening numeric range validation', () => {
        const compiled = compileQueryPlanToDuckDbSql({
            select: ['Date'],
            where: {
                predicates: [{ column: 'Date', operator: 'between', value: ['2024-01-01', '2024-12-31'] }],
            },
        }, {
            allowedColumns: ['Date'],
            tableName: 'session_clean_dataset',
        });

        expect(compiled.sql).toContain(`TRIM(COALESCE(CAST("Date" AS VARCHAR), '')) BETWEEN '2024-01-01' AND '2024-12-31'`);

        expect(() => compileQueryPlanToDuckDbSql({
            select: ['Value'],
            where: {
                predicates: [{ column: 'Value', operator: 'between', value: ['low', 'high'] }],
            },
        }, {
            allowedColumns: ['Value'],
            tableName: 'session_clean_dataset',
        })).toThrow(/requires a numeric value/i);
    });

    it('fails with an explicit contract error for malformed orderBy clauses', () => {
        expect(() => compileQueryPlanToDuckDbSql({
            select: ['Region'],
            orderBy: [{ direction: 'desc' } as never],
        }, {
            allowedColumns: ['Region', 'Revenue'],
            tableName: 'session_clean_dataset',
        })).toThrow(/requires a non-empty column name|must be an object/i);
    });
});
