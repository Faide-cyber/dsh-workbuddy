/**
 * Growth-task specs and activity-event builders (pure data + pure functions).
 *
 * Ported from workbuddy2api's `admin/tasks/event_specs.py`, which is the
 * reverse-engineered record of what each growth-center task needs to light up.
 * The upstream tracks progress by counting *reported events*, not by watching
 * what the user actually did, so "completing" a task means posting the right
 * event N times.
 *
 * Two rules learned the hard way and kept here:
 *
 * - **Copy the event fields in full.** The upstream drops events it cannot
 *   attribute: `userId` is mandatory (omit it and the report answers `200` while
 *   progress does not move), and trimming the "obvious" zero/false fields is how
 *   a report silently stops counting.
 * - **Do not invent events for unknown tasks.** A code with no spec here gets no
 *   report at all rather than a heartbeat that lights nothing.
 *
 * @module dsh-workbuddy/growth-tasks
 */

/** What one task code needs: which event to send, and how many of them. */
export interface GrowthTaskSpec {
  /** Event template key, see {@link buildGrowthEvent}. */
  kind: string
  /** Reports needed to fill the progress bar. */
  target: number
}

/**
 * Task code to spec. Covers the whole domestic growth center; codes the
 * upstream adds later are simply absent, which {@link isSkippedGrowthTask}
 * treats as "do not touch".
 */
export const GROWTH_TASK_SPECS: Readonly<Record<string, GrowthTaskSpec>> = {
  create_canvas: { kind: 'canvas', target: 1 },
  template_5: { kind: 'template', target: 5 },
  expert_5: { kind: 'expert', target: 5 },
  Expert_team_use_3: { kind: 'team', target: 3 },
  skill_1: { kind: 'skill', target: 1 },
  automation_1: { kind: 'automation', target: 1 },
  playbook_prompt: { kind: 'playbook', target: 1 },
  Expert_lighthouse: { kind: 'lighthouse', target: 1 },
  Hp_Appearance: { kind: 'skin', target: 1 },
  chat_5: { kind: 'chat', target: 5 },
  'Model_chat_GLM5.2': { kind: 'glmchat', target: 1 },
  black_cat: { kind: 'cat', target: 3 },
  // No known event branch (a heartbeat report lights nothing), or owned by
  // another flow. Listed so the intent is explicit rather than an omission.
  Buddy_App: { kind: 'buddy5', target: 1 },
  Buddy_App_QQ: { kind: 'buddy5', target: 1 },
  RichMeow_Chat: { kind: 'richmeow', target: 1 },
  Library_read: { kind: 'library', target: 1 },
  first_buddy: { kind: 'buddy_first', target: 1 },
  Expert_Philanthropy: { kind: 'unforgeable', target: 1 },
}

/**
 * Kinds the orchestrator must never report.
 *
 * `buddy5`/`richmeow`/`library` have no event branch (a report cannot light
 * them), `buddy_first` is driven by the adoption state machine instead, and
 * `unforgeable` is a real donation — reporting it would be a lie about money.
 */
export const GROWTH_SKIP_KINDS: ReadonlySet<string> = new Set([
  'buddy5', 'richmeow', 'library', 'buddy_first', 'unforgeable',
])

/** The spec for a task code, or `undefined` when the code is unknown. */
export function growthTaskSpec(code: string): GrowthTaskSpec | undefined {
  return Object.prototype.hasOwnProperty.call(GROWTH_TASK_SPECS, code) ? GROWTH_TASK_SPECS[code] : undefined
}

/**
 * Whether the orchestrator should leave this task alone.
 *
 * Unknown codes count as skipped: the alternative is reporting an event whose
 * meaning we are guessing, which is how a "helpful" pass ends up creating a
 * task state the upstream never offered.
 */
export function isSkippedGrowthTask(code: string): boolean {
  const spec = growthTaskSpec(code)
  return spec === undefined || GROWTH_SKIP_KINDS.has(spec.kind)
}

/** Kinds that only light up inside the night window. */
export const GROWTH_NIGHT_KINDS: ReadonlySet<string> = new Set(['cat'])

/**
 * Whether the night-only task may be lit now, in Beijing wall-clock time.
 *
 * The upstream judges by its own `23:00-08:00` window; reports outside it are
 * accepted and ignored, so sending them only wastes a round trip.
 */
export function inGrowthNightWindow(nowMs: number = Date.now()): boolean {
  const beijingHour = new Date(nowMs + 8 * 3_600_000).getUTCHours()
  return beijingHour >= 23 || beijingHour < 8
}

/**
 * Build one report event for a task kind.
 *
 * `uid` is the account uid and must be present: without it the upstream accepts
 * the batch and counts nothing. `idx` only has to keep the generated ids apart
 * within one task — the server does not cross-check them against a real session.
 */
export function buildGrowthEvent(uid: string, kind: string, idx = 0): Record<string, unknown> {
  const now = Date.now()
  const conversationId = `dsh-growth-${now}-${idx}`
  const requestId = `${conversationId}-req`
  const userId = uid

  switch (kind) {
    case 'canvas':
      return {
        eventCode: 'wbx_design_canvas_task_create', timestamp: now, reportDelay: 0,
        conversationId, requestId, source: 'summon_keyword', isCustomModel: false,
        name: '', inputLength: 12, id: `wbx-canvas-${now}`, cost: 0, isSuccessful: true, userId,
      }
    case 'template':
      return {
        eventCode: 'agent_task_created_with_template', timestamp: now, reportDelay: 0,
        isCustomModel: true, id: String(idx), name: '幻灯片', requestId, conversationId, userId,
      }
    case 'expert':
    case 'team':
    case 'lighthouse': {
      const expertType = kind === 'team' ? 'team' : 'agent'
      const expertId = kind === 'lighthouse' ? 'ex_2cvvUZQhDyeJ' : (kind === 'team' ? 'CloudOpsTeam' : 'ContentCreator')
      const name = kind === 'lighthouse' ? '腾讯轻量云专家' : (kind === 'team' ? '运维专家团队' : '内容创作专家')
      // 上游按事件的 id 去重：同一个 id 每天只计一次。多报告任务（expert_5 要 5 条、
      // Expert_team_use_3 要 3 条）必须每条换一个 id，否则连发也只计 1 条，任务永远完不成。
      // 实测 id 不被校验为真实专家，故后缀递增即可。
      const reportId = idx === 0 ? expertId : `${expertId}-${idx}`
      return {
        eventCode: 'expert_actual_use', timestamp: now, reportDelay: 0, mode: 'CLOUD',
        id: reportId, name, expertTitle: name, type: '02-Engineering', expertType,
        source: 'builtin', version: '1.0.2', cost: 0, characterCount: 12,
        conversationId, requestId, messageId: requestId,
        requestModelId: 'deepseek-v4-flash', requestModelName: 'DeepSeek V4 Flash', userId,
      }
    }
    case 'skill':
      return {
        eventCode: 'skill_info', timestamp: now, reportDelay: 0,
        skillId: 'skill_2096525080079265792', name: 'pptx', userId,
      }
    case 'automation':
      return {
        eventCode: 'automated_task_create_suc', timestamp: now, reportDelay: 0,
        name: '每周工作整理', type: 'cron', source: 'manually',
        modelId: 'deepseek-v4-flash', modelIsThinking: false,
        conversationId, requestId,
        schedule: { type: 'recurring', rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0' },
        prompt: '每周五自动整理本周工作', userId,
      }
    case 'playbook':
      return {
        eventCode: 'playbook_prompt_send', timestamp: now, reportDelay: 0,
        id: 'worker-ledger-freedom-dashboard', name: '打工人小账本', type: 'other',
        promptLength: 10, isOfficial: 1, source: 'discover',
        conversationId, requestId, userId,
      }
    case 'skin':
      return {
        eventCode: 'appearance_skin_apply', timestamp: now, reportDelay: 0,
        action: 'apply', source: 'settings_close', id: 'theme-tkmw7j',
        vipLevel: 'free', series: 'craft', type: 'unknown', name: '和平精英激战金秋', userId,
      }
    case 'chat':
    case 'glmchat':
    case 'cat': {
      const night = kind === 'cat'
      const modelId = night || kind === 'glmchat' ? 'glm-5.2' : 'deepseek-v4-flash'
      const modelName = night || kind === 'glmchat' ? 'GLM-5.2' : 'DeepSeek V4 Flash'
      return {
        eventCode: 'chat_request_send', timestamp: now, reportDelay: 0,
        mode: night ? 'night' : 'craft', conversationId, requestId, inputLength: 12,
        requestModelId: modelId, requestModelName: modelName,
        isPlan: false, agentName: 'default', agentType: 'conversation', userId,
      }
    }
    default:
      // Unknown kind: a heartbeat the upstream ignores. Reachable only if a spec
      // is added without a matching branch above, which is better than throwing.
      return { eventCode: 'heartbeat', timestamp: now, userId }
  }
}
