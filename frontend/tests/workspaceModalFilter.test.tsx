import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceModal } from '../components/modals/WorkspaceModal';

const { useAppStoreMock, buildWorkspaceBundleMock } = vi.hoisted(() => ({
    useAppStoreMock: vi.fn(),
    buildWorkspaceBundleMock: vi.fn(),
}));

vi.mock('../store/useAppStore', () => ({ useAppStore: useAppStoreMock }));
vi.mock('../services/agent/buildWorkspaceBundle', () => ({ buildWorkspaceBundle: buildWorkspaceBundleMock }));
vi.mock('../components/modals/WorkspaceModalEditor', () => ({
    WorkspaceModalEditor: ({ path }: { path: string }) => <div data-testid="workspace-editor">{path}</div>,
}));

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('WorkspaceModal file filter', () => {
    it('previews a visible match and clears stale preview when no files match', async () => {
        const files = [
            { path: '/workspace/report_context.json', label: 'report_context.json', content: '{}', language: 'json', group: 'workspace' },
            { path: '/dataset/cleaned.csv', label: 'cleaned.csv', content: 'town,price\nBEDOK,100', language: 'csv', group: 'dataset' },
        ];
        buildWorkspaceBundleMock.mockReturnValue({ files, primaryFiles: files, debugFiles: [], editableFiles: files });
        const state = {
            isWorkspaceModalOpen: true,
            setIsWorkspaceModalOpen: vi.fn(),
            logAgentToolUsage: vi.fn(),
            workspaceFiles: {},
        };
        useAppStoreMock.mockImplementation((selector: (value: typeof state) => unknown) => selector(state));

        render(<WorkspaceModal />);
        expect(await screen.findByTestId('workspace-editor')).toHaveTextContent('/workspace/report_context.json');

        fireEvent.change(screen.getByRole('textbox', { name: 'File filter' }), { target: { value: 'cleaned' } });
        expect(await screen.findByTestId('workspace-editor')).toHaveTextContent('/dataset/cleaned.csv');
        expect(screen.getByRole('button', { name: /cleaned.csv/ })).toBeInTheDocument();

        fireEvent.change(screen.getByRole('textbox', { name: 'File filter' }), { target: { value: 'missing' } });
        expect(screen.getAllByText('No files match the current filter.')).toHaveLength(2);
        expect(screen.getByText('No file selected')).toBeInTheDocument();
        expect(screen.queryByText('untitled')).not.toBeInTheDocument();
        expect(screen.queryByTestId('workspace-editor')).not.toBeInTheDocument();
    });
});
