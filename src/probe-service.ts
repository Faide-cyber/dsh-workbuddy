/**
 * Probe orchestration: the serial queue, the consent gate, and the bridge from
 * an observation to what the adapter may expose.
 *
 * Kept separate from {@link module:dsh-workbuddy/probe} so the protocol
 * stays a pure function of one model's responses, while queueing, persistence,
 * and policy live here. Two rules are structural rather than advisory:
 *
 * - one probe at a time (a user's real chat must not contend with a sweep),
 * - nothing at all happens without explicit consent.
 *
 * @module dsh-workbuddy/probe-service
 */

import type { WorkBuddyCredentialStoreLike } from './auth.ts'
import type { WorkBuddyCatalog } from './catalog.ts'
import { probeModel, type ProbeSender, type SentinelFactory } from './probe.ts'
import { fingerprintModel, type WorkBuddyProbeRecord, type WorkBuddyProbeStore } from './probe-store.ts'
import type { WorkBuddyUpstreamClient } from './upstream.ts'

/** What the caller learns about a completed probe. */
export type WorkBuddyProbeStatus =
  | { state: 'ok'; validation: WorkBuddyProbeRecord['validation']; efforts: readonly string[]; requests: number }
  | { state: 'unavailable'; reason: string }

/** Options for {@link WorkBuddyProbeService}. */
export interface WorkBuddyProbeServiceOptions {
  store: WorkBuddyProbeStore
  catalog: WorkBuddyCatalog
  credentials: WorkBuddyCredentialStoreLike
  client: WorkBuddyUpstreamClient
  /** Whether probing is permitted at all; consulted before every sweep. */
  consent: () => boolean
  sentinel?: SentinelFactory
  /** Injectable for tests; defaults to the live upstream sender. */
  send?: (modelId: string) => ProbeSender
}

/**
 * Serial probe runner. One instance is shared by the manual API and any
 * future automatic trigger, so the two can never overlap.
 */
export class WorkBuddyProbeService {
  private readonly options: WorkBuddyProbeServiceOptions
  private queue: Promise<unknown> = Promise.resolve()
  private readonly pending = new Map<string, Promise<WorkBuddyProbeStatus>>()
  private running = false

  constructor(options: WorkBuddyProbeServiceOptions) {
    this.options = options
  }

  /** Whether a sweep is in flight right now. */
  isRunning(): boolean {
    return this.running
  }

  /**
   * The record the adapter may use for this model, or `undefined`.
   *
   * A declared set always wins, so a model that declares `supportedEfforts` is
   * never answered from an observation.
   */
  recordFor(modelId: string): WorkBuddyProbeRecord | undefined {
    const info = this.options.catalog.current().find(model => model.id === modelId)
    if (info === undefined) return undefined
    if (info.reasoning?.supportedEfforts !== undefined && info.reasoning.supportedEfforts.length > 0) {
      return undefined
    }
    return this.options.store.get(modelId, fingerprintModel(info))
  }

  /**
   * Probe one model, serially.
   *
   * The authenticated manual route supplies one-request consent after UI
   * confirmation. Other callers must pass the configured consent gate.
   * Manual consent never changes the automatic-probing configuration.
   * Explicit requests bypass historical results, but share an ongoing run.
   */
  async probe(modelId: string, manualConsent = false): Promise<WorkBuddyProbeStatus> {
    if (!manualConsent && !this.options.consent()) {
      return { state: 'unavailable', reason: 'probing is not authorized' }
    }
    const info = this.options.catalog.current().find(model => model.id === modelId)
    if (info === undefined) return { state: 'unavailable', reason: `unknown model: ${modelId}` }
    const pending = this.pending.get(modelId)
    if (pending !== undefined) return pending

    const run = this.queue.then(async (): Promise<WorkBuddyProbeStatus> => {
      // Re-read inside the queue: an earlier sweep may have changed the catalog
      // or already answered this model.
      const current = this.options.catalog.current().find(model => model.id === modelId)
      if (current === undefined) return { state: 'unavailable', reason: `unknown model: ${modelId}` }
      if (!manualConsent && !this.options.consent()) {
        return { state: 'unavailable', reason: 'probing is not authorized' }
      }
      if (current.reasoning?.supports !== true || (current.reasoning.supportedEfforts?.length ?? 0) > 0) {
        return { state: 'unavailable', reason: 'model does not need detection' }
      }
      const cached = this.recordFor(modelId)
      if (!manualConsent && cached !== undefined && cached.validation !== 'unknown') {
        return { state: 'ok', validation: cached.validation, efforts: cached.efforts, requests: 0 }
      }

      const credential = await this.options.credentials.current()
      if (credential === undefined) return { state: 'unavailable', reason: 'no WorkBuddy credential' }

      const send = this.options.send === undefined
        ? (effort: string | undefined, signal: AbortSignal) =>
            this.options.client.probeEffort(credential, modelId, effort, signal)
        : this.options.send(modelId)

      this.running = true
      try {
        const outcome = await probeModel({
          send,
          ...this.options.sentinel === undefined ? {} : { sentinel: this.options.sentinel },
        })
        const record = this.options.store.record(fingerprintModel(current), outcome.validation, outcome.efforts)
        this.options.store.set(modelId, record)
        if (outcome.validation === 'unknown') {
          return { state: 'unavailable', reason: outcome.reason }
        }
        return { state: 'ok', validation: outcome.validation, efforts: record.efforts, requests: outcome.requests }
      } finally {
        this.running = false
      }
    })

    // Keep the chain alive regardless of this run's outcome, so one failure does
    // not poison every later probe.
    this.queue = run.catch(() => undefined)
    this.pending.set(modelId, run)
    try {
      return await run
    } finally {
      this.pending.delete(modelId)
    }
  }
}
