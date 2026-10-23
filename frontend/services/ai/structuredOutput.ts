import { Output, jsonSchema } from 'ai';
import type { Settings } from '../../types';
import { prepareGatewayStructuredOutputSchema, prepareSchemaForProvider } from './googleSchemaAdapter';

type JsonSchemaInput = Parameters<typeof jsonSchema>[0];

/**
 * The `output` option for a structured-output call. Every `Output.object` call
 * site goes through here so the Default demo gateway always receives a schema
 * it accepts (see prepareGatewayStructuredOutputSchema), and so
 * tests/structuredOutputGatewaySchemas.test.ts can enumerate every schema.
 */
export const createStructuredOutput = (
    schema: Record<string, unknown>,
    provider: Settings['provider'] | undefined,
) => {
    if (provider !== 'default') {
        return Output.object({ schema: jsonSchema(prepareSchemaForProvider(schema, provider) as JsonSchemaInput) });
    }
    const prepared = prepareGatewayStructuredOutputSchema(schema);
    // The SDK passes the parsed JSON through `validate`, which restores the
    // canonical property names before any caller sees the output.
    return Output.object({
        schema: jsonSchema(prepared.schema as JsonSchemaInput, {
            validate: value => ({ success: true, value: prepared.restore(value) }),
        }),
    });
};
