
import React from 'react';
import { shallow } from 'zustand/shallow';
import { useAppStore, AppStore } from '../store/useAppStore';
import { IconWarning } from '../icons/IconWarning';
import { summarizeDataQualityForEndUser } from '../services/data/dataProfiler';
import { getTranslation } from '../utils/localization';

const DataQualityWarningsComponent: React.FC = () => {
    const { dataWarnings, intakeWarnings, intakeStrategy, numericParseCheck, language } = useAppStore((state: AppStore) => ({
        dataWarnings: state.agentMemoryRun?.findings.warnings.map(w => w.message) ?? state.dataQualityIssues ?? [],
        intakeWarnings: state.csvData?.intakeDetection?.warnings ?? [],
        intakeStrategy: state.csvData?.intakeDetection?.strategy ?? null,
        numericParseCheck: state.numericParseCheck ?? null,
        language: state.settings.language,
    }), shallow);

    const warningMessages = Array.isArray(dataWarnings) ? dataWarnings : [];
    // Warning messages are English diagnostics; the not-delimited note is shown
    // in the user's language because it explains why the columns may be wrong.
    const intakeWarningMessages = intakeWarnings.map(warning => warning.code === 'not_delimited_text'
        ? getTranslation(intakeStrategy === 'fixed_width_layout' ? 'data_warnings_intake_not_delimited_split' : 'data_warnings_intake_not_delimited_unsplit', language)
        : warning.message);
    // Columns whose loaded numbers did not match the original text: say it plainly, with the
    // measured totals under the technical details.
    const numericParseFindings = numericParseCheck?.status === 'mismatch' ? numericParseCheck.findings : [];
    const numericParseColumns = Array.from(new Set(numericParseFindings.map(finding => finding.column)));
    const numericParseMessage = numericParseColumns.length > 0
        ? getTranslation('data_warnings_numeric_parse_mismatch', language, { columns: numericParseColumns.join(', ') })
        : null;
    const numericParseDetail = numericParseFindings
        .map(finding => `${finding.column}: original text ${finding.sourceSum ?? 'n/a'}, loaded ${finding.loadedSum ?? 'n/a'}${finding.ratio === null ? '' : `, ratio ${finding.ratio.toPrecision(4)}`} (${finding.kind})`)
        .join(' | ');
    const hasWarnings = warningMessages.length > 0 || intakeWarningMessages.length > 0 || numericParseMessage !== null;
    if (!hasWarnings) return null;

    const endUserResult = warningMessages.length > 0
        ? summarizeDataQualityForEndUser(warningMessages)
        : null;
    const userSummary = endUserResult?.userSummary
        ?? getTranslation('data_warnings_intake_reported', language, { count: intakeWarningMessages.length });
    const technicalDetail = endUserResult?.technicalDetail ?? null;

    const noteCount = (warningMessages.length > 0 ? warningMessages.length : intakeWarningMessages.length) + (numericParseMessage ? 1 : 0);

    // Quality notes are handled by the analysis agent and need no action, so they
    // stay as one quiet, collapsed line instead of a large warning block.
    return (
        <details className="group rounded-card border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
            <summary className="flex cursor-pointer list-none items-center gap-2">
                <IconWarning className="h-4 w-4 shrink-0 text-amber-500" />
                <span className="min-w-0 flex-1">
                    {getTranslation('data_warnings_compact_summary', language, { count: noteCount })}
                </span>
                <span className="shrink-0 text-xs font-medium text-slate-500 underline-offset-2 group-open:hidden group-hover:underline">
                    {getTranslation('data_warnings_view_notes', language)}
                </span>
            </summary>
            <div className="mt-2 space-y-2 border-t border-slate-200 pt-2 text-xs text-slate-600">
                {numericParseMessage && <p className="font-semibold text-red-700">{numericParseMessage}</p>}
                {(warningMessages.length > 0 || intakeWarningMessages.length > 0) && <p>{userSummary}</p>}
                {intakeWarningMessages.length > 0 && (
                    <div>
                        <p className="font-semibold text-slate-700">{getTranslation('data_warnings_intake_label', language)}</p>
                        <ul className="mt-1 space-y-1">
                            {intakeWarningMessages.slice(0, 3).map(message => (
                                <li key={message}>- {message}</li>
                            ))}
                        </ul>
                    </div>
                )}
                {(technicalDetail || numericParseDetail) && (
                    <p className="rounded-md bg-white p-2 font-mono text-slate-500">{[technicalDetail, numericParseDetail].filter(Boolean).join(' | ')}</p>
                )}
                <p className="text-slate-500">{getTranslation('data_warnings_footer', language)}</p>
            </div>
        </details>
    );
};

export const DataQualityWarnings = React.memo(DataQualityWarningsComponent);
