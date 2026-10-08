/**
 * The single write path behind both model-switch control actions.
 *
 * Toggling a model in the card has to do three things, and the third is the one
 * that is easy to leave out: the browser's shared model catalog caches a loaded
 * generation and re-reads it only on `llm/adapters-updated`,
 * `settings/document-updated`, or a credentials event. This path persists to the
 * plugin's *own* settings file rather than through the DSH settings service, so
 * none of those events fire by themselves — without the notification the picker
 * keeps offering a model the user just switched off, until some unrelated
 * refresh happens to reload the catalog. It lives in its own module so the
 * ordering is testable: `src/index.ts` pulls DSH packages that no test can load.
 *
 * @module dsh-workbuddy/model-switches
 */

import type { WorkBuddyCatalog } from './catalog.ts'

/**
 * Apply one switch write: memory, then the persistent store, then the picker.
 *
 * Memory leads so the next catalog read already reflects the change even while
 * the store write is in flight. A store rejection still propagates — a switch
 * that silently failed to persist is precisely the failure this ordering exists
 * to surface on the card — but the notification fires either way, because live
 * memory is what the picker reads: leaving it stale after a failed write would
 * reproduce the original symptom, with the user unable to tell a broken switch
 * from a stale cache.
 *
 * @param target - catalog whose disabled set is edited.
 * @param models - model ids the switch applies to (one id, or a whole selection).
 * @param enabled - `true` re-enables those ids, `false` disables them.
 * @param persist - writes the resulting id list; the card waits on it.
 * @param notify - tells the browser its cached model catalog is stale.
 */
export async function applyModelSwitchWrite(
  target: WorkBuddyCatalog,
  models: readonly string[],
  enabled: boolean,
  persist: (ids: readonly string[]) => void | Promise<void>,
  notify: () => void,
): Promise<void> {
  const next = new Set(target.disabledIds())
  for (const model of models) {
    if (enabled) next.delete(model)
    else next.add(model)
  }
  const ids = [...next]
  target.setDisabled(ids)
  try {
    await persist(ids)
  } finally {
    notify()
  }
}
