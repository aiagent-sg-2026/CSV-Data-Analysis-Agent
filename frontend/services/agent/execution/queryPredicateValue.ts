import { robustParseFloat } from '../../data/dataProfiler';

/** ISO dates must be compared as instants, never as the numeric year prefix. */
export const orderedPredicateValue = (value: unknown): number | null => {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) {
        const day=value.slice(0,10), parsed=Date.parse(value);
        const dayParsed=Date.parse(day);
        if (!Number.isFinite(parsed) || !Number.isFinite(dayParsed) || new Date(dayParsed).toISOString().slice(0,10)!==day
            || value.length>10 && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
        return parsed;
    }
    return robustParseFloat(value);
};
