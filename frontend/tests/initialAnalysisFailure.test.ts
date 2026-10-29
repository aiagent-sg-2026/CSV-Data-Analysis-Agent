import { describe, expect, it } from 'vitest';
import { isInitialAnalysisProviderFailure } from '../services/agent/runtime/pi/initialAnalysisFailure';

describe('initial analysis failure classification', () => {
    it('recognizes provider transport, authentication, and timeout failures', () => {
        expect(isInitialAnalysisProviderFailure({ status: 503, message: 'Service unavailable' })).toBe(true);
        expect(isInitialAnalysisProviderFailure(new Error('Invalid API key'))).toBe(true);
        expect(isInitialAnalysisProviderFailure(new Error('Failed to fetch'))).toBe(true);
        expect(isInitialAnalysisProviderFailure(new Error('Provider request timed out'))).toBe(true);
    });

    it.each([
        new Error('OpenAI Responses stream ended before a terminal response event'),
        { message: 'OpenAI Responses stream ended before a terminal response event' },
        'OpenAI Responses stream ended before a terminal response event',
    ])('classifies the provider premature-stream error for explicit recovery', error => {
        expect(isInitialAnalysisProviderFailure(error)).toBe(true);
    });

    it.each([
        'CSV stream ended before a terminal response event',
        'Dataset contains text: OpenAI Responses stream ended before a terminal response event',
        'Structure review cancelled',
    ])('does not broaden stream recovery to local analysis errors: %s', message => {
        expect(isInitialAnalysisProviderFailure(new Error(message))).toBe(false);
    });

    it('does not label analysis evidence or Pi budget failures as provider outages', () => {
        expect(isInitialAnalysisProviderFailure(new Error('No verified analysis cards'))).toBe(false);
        expect(isInitialAnalysisProviderFailure(new Error('The Pi initial-analysis time budget expired.'))).toBe(false);
        expect(isInitialAnalysisProviderFailure(new Error('Structure review is required.'))).toBe(false);
    });
});
