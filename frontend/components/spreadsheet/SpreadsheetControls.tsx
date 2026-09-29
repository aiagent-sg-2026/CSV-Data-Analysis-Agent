import React from 'react';
import { IconAi } from '../../icons/IconAi';
import { IconLoadingSpinner } from '../../icons/IconLoadingSpinner';
import { IconSearch } from '../../icons/IconSearch';
import { useAppStore } from '../../store/useAppStore';
import { getTranslation } from '../../utils/localization';

interface SpreadsheetControlsProps {
    filterText: string;
    onFilterTextChange: (text: string) => void;
    onQuerySubmit: () => void;
    isAiFiltering: boolean;
    aiEnabled: boolean;
}

export const SpreadsheetControls: React.FC<SpreadsheetControlsProps> = ({
    filterText,
    onFilterTextChange,
    onQuerySubmit,
    isAiFiltering,
    aiEnabled
}) => {
    const language = useAppStore(state => state.settings.language);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' && aiEnabled && !isAiFiltering && filterText.trim()) {
            onQuerySubmit();
        }
    };

    return (
        <div className="flex min-w-0 flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-grow">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    <IconSearch />
                </div>
                <input
                    type="text"
                    aria-label={getTranslation('spreadsheet_search_placeholder', language)}
                    placeholder={getTranslation('spreadsheet_search_placeholder', language)}
                    value={filterText}
                    onChange={(e) => onFilterTextChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    className="min-h-[44px] w-full rounded-md border border-slate-300 bg-white py-2 pl-10 pr-4 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
            </div>
            <button
                type="button"
                onClick={onQuerySubmit}
                disabled={!aiEnabled || isAiFiltering || !filterText.trim()}
                className="flex min-h-[44px] shrink-0 items-center self-end gap-2 rounded-md bg-blue-600 px-3 py-2 text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300 sm:self-auto"
                title={getTranslation('spreadsheet_ask_ai', language)}
            >
                {isAiFiltering ? <IconLoadingSpinner /> : <IconAi />}
                <span>{getTranslation('spreadsheet_ask_ai', language)}</span>
            </button>
        </div>
    );
};
