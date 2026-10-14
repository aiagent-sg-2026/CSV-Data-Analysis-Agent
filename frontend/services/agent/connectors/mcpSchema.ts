import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker';

export const mcpSchemaValidator = new CfWorkerJsonSchemaValidator();
const keywords = new Set(['$schema', 'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
    'description', 'title', 'default', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'anyOf', 'oneOf', 'allOf']);
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const reserved = new Set(['__proto__', 'constructor', 'prototype', '_meta', 'sessionId', 'runId', 'turnId', 'toolCallId', 'capabilityGrants']);

/** A bounded schema subset avoids remote references, executable regexes and SDK header passthrough. */
export const validateMcpSchema = (input: unknown): Record<string, unknown> => {
    let nodes = 0;
    const visit = (schema: unknown, depth: number): void => {
        if (++nodes > 200 || depth > 8 || !schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('mcp_unsupported_schema');
        const s = schema as Record<string, unknown>;
        if (s.$schema !== undefined && !['https://json-schema.org/draft/2020-12/schema', 'http://json-schema.org/draft-07/schema#'].includes(String(s.$schema))) throw new Error('mcp_unsupported_schema_dialect');
        if (Object.keys(s).some(key => !keywords.has(key))) throw new Error('mcp_unsupported_schema_keyword');
        if (s.type !== undefined && !(typeof s.type === 'string' ? types.has(s.type) : Array.isArray(s.type) && s.type.length <= 7 && s.type.every(t => types.has(t)))) throw new Error('mcp_invalid_schema_type');
        if (s.properties !== undefined) {
            if (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties)) throw new Error('mcp_invalid_schema_properties');
            for (const [name, child] of Object.entries(s.properties)) {
                if (reserved.has(name) || name.length > 100) throw new Error('mcp_reserved_schema_property');
                visit(child, depth + 1);
            }
        }
        if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some(k => typeof k !== 'string' || !Object.hasOwn((s.properties ?? {}) as object, k)))) throw new Error('mcp_invalid_schema_required');
        if (s.items !== undefined) visit(s.items, depth + 1);
        if (s.additionalProperties !== undefined && typeof s.additionalProperties !== 'boolean') visit(s.additionalProperties, depth + 1);
        for (const key of ['anyOf', 'oneOf', 'allOf']) if (s[key] !== undefined) {
            if (!Array.isArray(s[key]) || s[key].length < 1 || s[key].length > 10) throw new Error('mcp_invalid_schema_composition');
            s[key].forEach(child => visit(child, depth + 1));
        }
        for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) if (s[key] !== undefined && (typeof s[key] !== 'number' || !Number.isFinite(s[key]) || Math.abs(s[key]) > 1e9)) throw new Error('mcp_invalid_schema_bound');
        for (const key of ['enum', 'const', 'default']) if (s[key] !== undefined && JSON.stringify(s[key]).length > 4096) throw new Error('mcp_schema_value_too_large');
    };
    visit(input, 0);
    if ((input as Record<string, unknown>).type !== 'object') throw new Error('mcp_schema_requires_object');
    const schema = structuredClone(input) as Record<string, unknown>;
    mcpSchemaValidator.getValidator(schema);
    return schema;
};

export const validateMcpArguments = (schema: Record<string, unknown>, args: unknown): string[] => {
    if (!args || typeof args !== 'object' || Array.isArray(args) || JSON.stringify(args).length > 16_384) return ['mcp_invalid_arguments'];
    const walk = (value: unknown, depth = 0): boolean => depth <= 16 && (!value || typeof value !== 'object' || Object.entries(value).every(([key, child]) => !reserved.has(key) && walk(child, depth + 1)));
    if (!walk(args)) return ['mcp_reserved_argument'];
    const result = mcpSchemaValidator.getValidator(schema)(args);
    return result.valid ? [] : ['mcp_arguments_do_not_match_pinned_schema'];
};
