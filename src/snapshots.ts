import { MIN_SNAPSHOT_FIRMWARE } from './protocol/constants.js'
import type { SnapshotInfo } from './protocol/types.js'

/**
 * Single source of truth for "does this uuid still exist on the device",
 * shared by the snapshot actions and the label feedback so they can never
 * disagree on whether a snapshot is applicable.
 */
export function findSnapshot(snapshotList: SnapshotInfo[], uuid: string): SnapshotInfo | undefined {
	return snapshotList.find((snapshot) => snapshot.uuid === uuid)
}

/**
 * Placeholder for the snapshot dropdowns (actions and feedbacks share the
 * same wording): explains WHY the list is empty instead of guessing.
 */
export function snapshotPlaceholderLabel(count: number, unsupported: boolean, loaded: boolean): string {
	if (count > 0) return 'Select a snapshot…'
	if (unsupported) return `Snapshots require firmware ${MIN_SNAPSHOT_FIRMWARE} or later`
	if (loaded) return 'No snapshots on device'
	return 'Snapshot database not read yet (run "Refresh Snapshot Database")'
}
