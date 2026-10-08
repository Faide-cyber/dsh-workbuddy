/**
 * The model-switch write path.
 *
 * The load-bearing case is the notification: toggling a model persists to the
 * plugin's own settings file, which fires none of the DSH events the browser's
 * cached model catalog listens for. Without `notify()` the picker keeps offering
 * the model the user just switched off — the bug this ordering exists to fix —
 * and the card still looks correct, so nothing else would catch a regression.
 */

import { describe, expect, it } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { applyModelSwitchWrite } from '../src/model-switches.ts'

function fixture(ids: readonly string[] = []): WorkBuddyCatalog {
  const catalog = new WorkBuddyCatalog({ scope: 'all' })
  catalog.setDisabled(ids)
  return catalog
}

describe('applyModelSwitchWrite', () => {
  it('persists the new id set and then tells the picker its catalog is stale', async () => {
    const catalog = fixture()
    const order: string[] = []
    await applyModelSwitchWrite(
      catalog,
      ['hy3'],
      false,
      ids => { order.push(`persist:${ids.join(',')}`) },
      () => { order.push('notify') },
    )
    expect(catalog.disabledIds()).toEqual(['hy3'])
    expect(order).toEqual(['persist:hy3', 'notify'])
  })

  it('re-enables one id without disturbing the other disabled ones', async () => {
    const catalog = fixture(['hy3', 'space-bunny', 'glm-5.3'])
    await applyModelSwitchWrite(catalog, ['space-bunny'], true, () => {}, () => {})
    expect(catalog.disabledIds()).toEqual(['hy3', 'glm-5.3'])
  })

  it('applies a whole selection in one write', async () => {
    const catalog = fixture(['hy3'])
    const writes: string[] = []
    await applyModelSwitchWrite(
      catalog,
      ['space-bunny', 'glm-5.3', 'hy3'],
      false,
      ids => { writes.push(ids.join(',')) },
      () => {},
    )
    expect(writes).toEqual(['hy3,space-bunny,glm-5.3'])
    expect(catalog.isDisabled('glm-5.3')).toBe(true)
  })

  it('still tells the picker about a rejected write, because memory already changed', async () => {
    const catalog = fixture()
    const notified: string[] = []
    await expect(applyModelSwitchWrite(
      catalog,
      ['hy3'],
      false,
      () => { throw new Error('settings write failed') },
      () => { notified.push('notify') },
    )).rejects.toThrow('settings write failed')
    // The switch moved in memory before the store refused it. A picker left on a
    // stale cache would keep offering `hy3` while the card reports an error, so
    // the notification must outlive the failure.
    expect(catalog.isDisabled('hy3')).toBe(true)
    expect(notified).toEqual(['notify'])
  })

  // Negative proof: both the real path and the pre-fix path run through the
  // same contract -- "persist the new set, then notify". The real one satisfies
  // it; the pre-fix one, replicated below, must fail it. If the production
  // implementation ever loses its notify step, this test fails with it.
  it('the pre-fix notify-less write fails the contract the real path satisfies', async () => {
    /** What the picker requires: the write landed, and the cache was told. */
    const satisfiesContract = (order: readonly string[], catalog: WorkBuddyCatalog): boolean =>
      order.join('|') === 'persist:hy3|notify' && catalog.isDisabled('hy3')

    const realOrder: string[] = []
    const realCatalog = fixture()
    await applyModelSwitchWrite(
      realCatalog,
      ['hy3'],
      false,
      ids => { realOrder.push(`persist:${ids.join(',')}`) },
      () => { realOrder.push('notify') },
    )
    expect(satisfiesContract(realOrder, realCatalog)).toBe(true)

    // The write path exactly as it was before this fix: memory and store only.
    const preFix = async (target: WorkBuddyCatalog, persist: (ids: readonly string[]) => void): Promise<void> => {
      const next = new Set(target.disabledIds())
      next.add('hy3')
      target.setDisabled([...next])
      persist([...next])
    }
    const brokenOrder: string[] = []
    const brokenCatalog = fixture()
    await preFix(brokenCatalog, ids => { brokenOrder.push(`persist:${ids.join(',')}`) })
    expect(satisfiesContract(brokenOrder, brokenCatalog)).toBe(false)
  })
})
