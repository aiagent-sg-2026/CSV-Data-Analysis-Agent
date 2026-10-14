// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { safeJsonStringify, toJsonCompatible, toSerializable } from '../utils/serializable';

describe('serializable utilities', () => {
    it('preserves a shared committed operation in both the plan and replay lineage', () => {
        const operation = { id: 'cast-amount', type: 'cast_column', column: 'Amount', targetType: 'number' };
        const report = { plan: { operations: [operation] }, lineage: { steps: [{ operation }] } };
        expect(toSerializable(report)).toEqual(report);
        expect(toJsonCompatible(report)).toEqual(report);
        expect(JSON.parse(safeJsonStringify(report))).toEqual(report);
    });

    it('still drops actual cycles while retaining repeated non-cyclic objects', () => {
        const shared: Record<string, unknown> = { value: 1 };
        const input: Record<string, unknown> = { left: shared, right: shared };
        shared.parent = input;
        const expected = { left: { value: 1 }, right: { value: 1 } };
        expect(toSerializable(input)).toEqual(expected);
        expect(toJsonCompatible(input)).toEqual(expected);
    });

    it('removes functions from nested objects and arrays', () => {
        const input = {
            ok: true,
            nested: {
                keep: 'value',
                drop: () => 'x',
            },
            items: [
                { a: 1, fn: () => 'x' },
                () => 'y',
                'done',
            ],
        };

        expect(toSerializable(input)).toEqual({
            ok: true,
            nested: {
                keep: 'value',
            },
            items: [
                { a: 1 },
                'done',
            ],
        });
    });

    it('preserves Date instances for storage serialization', () => {
        const timestamp = new Date('2026-03-11T10:36:13.000Z');
        const result = toSerializable({ timestamp });

        expect(result.timestamp).toBeInstanceOf(Date);
        expect(result.timestamp.toISOString()).toBe('2026-03-11T10:36:13.000Z');
    });

    it('converts bigint values into JSON-safe numbers when they are within the safe range', () => {
        expect(toSerializable({ total: 12n })).toEqual({ total: 12 });
        expect(toJsonCompatible({ total: 12n })).toEqual({ total: 12 });
        expect(safeJsonStringify({ total: 12n })).toBe('{"total":12}');
    });

    it('converts large bigint values into strings to avoid precision loss', () => {
        const veryLarge = BigInt(Number.MAX_SAFE_INTEGER) + 10n;

        expect(toSerializable({ total: veryLarge })).toEqual({ total: veryLarge.toString() });
        expect(safeJsonStringify({ total: veryLarge })).toBe(`{"total":"${veryLarge.toString()}"}`);
    });
});
