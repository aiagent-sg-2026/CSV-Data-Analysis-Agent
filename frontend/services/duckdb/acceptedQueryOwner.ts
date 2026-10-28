import type { CsvData } from '../../types';
import type { StoreApi } from '../agent/types';
import type { DatasetCommitMarker } from '../../types/datasetCommit';
import { captureSessionScope, ownsSessionScope, rootStore } from '../session/sessionOwnership';

let retireInactiveRoute = () => {};
export const configureAcceptedQueryRetirement = (retire: () => void) => { retireInactiveRoute = retire; };
export const retireInactiveAcceptedQuery = () => retireInactiveRoute();

/** Host-created liveness check, never a query-plan/provider claim. The complete bundle
 * includes every table's storage/schema/version and the relationship generation, not rows.
 * Reload must reconstruct/verify the journal and explicitly install a fresh owner.
 */
export const acceptedQueryOwner = (store: StoreApi, marker: DatasetCommitMarker, data: CsvData): (() => boolean) => {
    const root = rootStore(store), scope = captureSessionScope(root);
    const signature = JSON.stringify(marker.bundle);
    // History intentionally creates a new tab session. Verified restore rebinds the
    // journal's original accepted commit into this captured session/epoch, not vice versa.
    return () => ownsSessionScope(root, scope) && root.getState().sessionId === scope.sessionId && root.getState().csvData === data
        && JSON.stringify(root.getState().datasetBundle) === signature;
};
