// @vitest-environment node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    STRUCTURE_REVIEW_REASON_CODES,
    describePipelineOutcomeBlock,
    getTranslation,
    getTranslationEntries,
    replaceInternalCodesWithPlainText,
} from '../utils/localization';
import { describeInitialAnalysisFailure } from '../services/agent/runtime/pi/initialAnalysisFailure';

const LANGUAGES = ['English', 'Mandarin', 'Japanese', 'Malay'] as const;
const SNAKE_CASE_CODE = /\b[a-z]+(?:_[a-z]+)+\b/;
const BLOCKED_STATUSES = [
    'needs_structure_review',
    'blocked_by_intake',
    'blocked_by_shape_verification',
    'blocked_by_sql_precheck',
    'cleaning_failed',
];
const STAGE_NAMES = [
    'dataset.profileStructure', 'dataset.detectNoiseRows', 'dataset.suggestCleaningPlan',
    'dataset.applyTransform', 'dataset.validatePreparedData',
];

describe('user-facing text never carries an internal check code', () => {
    it('keeps every blocked pipeline outcome free of codes in all four languages', () => {
        for (const language of LANGUAGES) {
            for (const status of BLOCKED_STATUSES) {
                for (const reasonCode of [...STRUCTURE_REVIEW_REASON_CODES, 'some_future_signal']) {
                    const text = describePipelineOutcomeBlock(
                        { status, reasonCode },
                        (key, params) => getTranslation(key, language, params),
                    );
                    expect(text, `${language} ${status} ${reasonCode}`).not.toBeNull();
                    expect(text, `${language} ${status} ${reasonCode}`).not.toMatch(SNAKE_CASE_CODE);
                }
            }
        }
    });

    it('keeps the stage failure text free of codes for every blocked outcome', () => {
        for (const language of LANGUAGES) {
            const translate = (key: string, params?: Record<string, string | number>) => getTranslation(key, language, params);
            for (const status of BLOCKED_STATUSES) {
                for (const reasonCode of STRUCTURE_REVIEW_REASON_CODES) {
                    const text = describeInitialAnalysisFailure({
                        results: [{
                            decision: 'fail',
                            toolName: 'dataset.validatePreparedData',
                            summary: 'Technical summary.',
                            warningCodes: [reasonCode],
                            artifactRefs: [`pipeline-outcome:${status}`],
                        }],
                        errorText: '',
                        stageNames: STAGE_NAMES,
                        translate,
                    });
                    expect(text, `${language} ${status} ${reasonCode}`).not.toMatch(SNAKE_CASE_CODE);
                }
            }
        }
    });

    it('has no snake_case token in the localized block, next-step and failure copy', () => {
        const prefixes = ['pipeline_outcome_', 'analysis_failure_', 'analysis_results_next_step_', 'structure_review_', 'internal_code_'];
        for (const [key, entry] of getTranslationEntries()) {
            if (!prefixes.some(prefix => key.startsWith(prefix))) continue;
            for (const language of LANGUAGES) {
                // Placeholders like {reason} are filled in at runtime and are not codes.
                const text = (entry[language] ?? '').replace(/\{\w+\}/g, '');
                expect(text, `${key} ${language}`).not.toMatch(SNAKE_CASE_CODE);
            }
        }
    });
});

describe('replaceInternalCodesWithPlainText', () => {
    it('turns verification detail and known codes into plain words and keeps column names', () => {
        const text = replaceInternalCodesWithPlainText(
            'Multi-header label layers were not preserved during reshaping. signal=label_layer_retention_complete; expected_label_layers=2; actual_label_layers=1',
            'English',
        );
        expect(text).toContain('Some header label levels would be lost when the table is reshaped.');
        expect(text).not.toMatch(SNAKE_CASE_CODE);
        expect(text).not.toContain('expected_label_layers');

        expect(replaceInternalCodesWithPlainText('deterministic_recovery_failed: Column order_date is missing.', 'English'))
            .toBe('Column order_date is missing.');
        expect(replaceInternalCodesWithPlainText('Stopped at noise_leakage_rate.', 'English'))
            .not.toMatch(/noise_leakage_rate/);
    });
});

describe('user-facing messages built in the cleaning and import pipelines', () => {
    const read = (relativePath: string) => readFileSync(path.resolve(relativePath), 'utf8');

    it('does not put the failing signal key into the cleaning-loop error text', () => {
        const source = read('services/agent/orchestration/autonomousCleaningPipeline.ts');
        // The signal stays in the iteration artifact (failureSignalKey); error text reaches progress messages and chat.
        expect(source).not.toMatch(/new Error\(`[^`]*\$\{verification\.signalKey/);
        expect(source).toContain('Cleaning loop stalled without reducing residual noise or changing the verification outcome.');
    });

    it('runs every error text that reaches a progress message through the plain-text helper', () => {
        const source = read('services/agent/orchestration/autonomousCleaningPipeline.ts');
        for (const key of ['autonomous_cleaning_rollback_progress', 'autonomous_cleaning_attempt_failed', 'autonomous_cleaning_failed_rollback']) {
            const uses = [...source.matchAll(new RegExp(`'${key}', \\{ message: ([^}]+) \\}`, 'g'))].map(match => match[1]!);
            expect(uses.length, key).toBeGreaterThan(0);
            for (const expression of uses) expect(expression, key).toContain('replaceInternalCodesWithPlainText');
        }
    });

    it('keeps replay reason codes out of the import progress message', () => {
        const source = read('services/agent/orchestration/fileOrchestrator.ts');
        expect(source).not.toMatch(/could not be reproduced \(\$\{/);
    });
});
