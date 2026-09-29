
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getTranslation } from '../../utils/localization';

const MoreDotsIcon: React.FC = () => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
        <path d="M10 3a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM10 8.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM11.5 15.5a1.5 1.5 0 10-3 0 1.5 1.5 0 003 0z" />
    </svg>
);

// Three actions and their divider need about 150px; leave a small dialog edge gap.
const MENU_CLEARANCE_PX = 160;
const MENU_WIDTH_PX = 176;
const MENU_GAP_PX = 4;

interface HistoryOverflowMenuProps {
    reportId: string;
    reportFilename: string;
    isOpen: boolean;
    isProtected: boolean;
    language: string;
    overflowRef: React.RefObject<HTMLDivElement | null>;
    onToggle: (id: string | null) => void;
    onOpenReport: (id: string) => void;
    onExportPdf: (id: string) => void;
    onDelete: (id: string, filename: string) => void;
}

export const HistoryOverflowMenu: React.FC<HistoryOverflowMenuProps> = ({
    reportId, reportFilename, isOpen, isProtected, language,
    overflowRef, onToggle, onOpenReport, onExportPdf, onDelete,
}) => {
    const [menuHost, setMenuHost] = useState<HTMLElement | null>(null);
    const [menuPlacement, setMenuPlacement] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

    useEffect(() => {
        if (!isOpen || !menuHost) return;
        const scrollRegion = menuHost.querySelector('[data-history-scroll-region]');
        const closeMenu = () => onToggle(null);
        scrollRegion?.addEventListener('scroll', closeMenu);
        window.addEventListener('resize', closeMenu);
        return () => {
            scrollRegion?.removeEventListener('scroll', closeMenu);
            window.removeEventListener('resize', closeMenu);
        };
    }, [isOpen, menuHost, onToggle]);

    return <div className="relative" ref={isOpen ? overflowRef : undefined}>
        <button
            data-history-more-id={reportId}
            onClick={(e) => {
                e.stopPropagation();
                if (!isOpen) {
                    const host = (e.currentTarget.closest('[role="dialog"]') as HTMLElement | null) ?? document.body;
                    const buttonRect = e.currentTarget.getBoundingClientRect();
                    const hostRect = host.getBoundingClientRect();
                    const maxHeight = Math.max(44, hostRect.height - 2 * MENU_GAP_PX);
                    const menuHeight = Math.min(MENU_CLEARANCE_PX, maxHeight);
                    const below = hostRect.bottom - buttonRect.bottom >= menuHeight + MENU_GAP_PX;
                    const top = below
                        ? buttonRect.bottom - hostRect.top + MENU_GAP_PX
                        : Math.max(MENU_GAP_PX, buttonRect.top - hostRect.top - menuHeight - MENU_GAP_PX);
                    const left = Math.max(MENU_GAP_PX, Math.min(
                        buttonRect.right - hostRect.left - MENU_WIDTH_PX,
                        hostRect.width - MENU_WIDTH_PX - MENU_GAP_PX,
                    ));
                    setMenuHost(host);
                    setMenuPlacement({ top, left, maxHeight });
                }
                onToggle(isOpen ? null : reportId);
            }}
            aria-label={getTranslation('history_more_actions', language)}
            aria-expanded={isOpen}
            className="inline-flex h-[44px] w-[44px] items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-700"
            title={getTranslation('history_more_actions', language)}
        >
            <MoreDotsIcon />
        </button>
        {isOpen && menuHost && menuPlacement && createPortal(
            <div data-history-menu className="absolute z-20 w-44 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-xl" style={menuPlacement}>
                <button
                    onClick={() => { onOpenReport(reportId); onToggle(null); }}
                    className="flex min-h-[44px] w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                >
                    {getTranslation('history_open_report', language)}
                </button>
                <button
                    onClick={() => { onExportPdf(reportId); onToggle(null); }}
                    className="flex min-h-[44px] w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                >
                    {getTranslation('history_export_pdf', language)}
                </button>
                {!isProtected && (
                    <>
                        <div className="my-1 border-t border-slate-100" />
                        <button
                            onClick={() => onDelete(reportId, reportFilename)}
                            className="flex min-h-[44px] w-full items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                        >
                            {getTranslation('history_delete', language)}
                        </button>
                    </>
                )}
            </div>,
            menuHost,
        )}
    </div>;
};
