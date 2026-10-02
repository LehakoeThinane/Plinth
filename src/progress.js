/** Completion is monotonic; resume position can move backwards deliberately.
 * Revision is a server-managed compare-and-swap value, checked atomically by the
 * persistence adapter. Clients retain rejected offline events for reconciliation.
 */
export function mergeProgress(current, incoming) {
  if (!Number.isInteger(incoming.baseRevision) || incoming.baseRevision < 0 ||
      !Number.isFinite(incoming.furthestPosition) || incoming.furthestPosition < 0 ||
      !Number.isFinite(incoming.resumePosition) || incoming.resumePosition < 0 ||
      typeof incoming.completed !== 'boolean') throw new Error('Invalid progress');
  const furthestPosition = Math.max(current.furthestPosition, incoming.furthestPosition);
  const completed = current.completed || incoming.completed;
  const stale = incoming.baseRevision !== current.revision;
  return {
    state: {
      revision: current.revision + 1,
      furthestPosition,
      completed,
      resumePosition: stale ? current.resumePosition : incoming.resumePosition
    },
    resumeConflict: stale
  };
}
