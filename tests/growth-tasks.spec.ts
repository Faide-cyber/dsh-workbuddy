import { describe, expect, it } from 'vitest'
import {
  GROWTH_TASK_SPECS,
  buildGrowthEvent,
  growthTaskSpec,
  inGrowthNightWindow,
  isSkippedGrowthTask,
} from '../src/growth-tasks.ts'

describe('isSkippedGrowthTask', () => {
  it('skips unknown codes rather than guessing an event for them', () => {
    // The failure this guards: reporting `heartbeat` for a code we do not know
    // is accepted by the upstream and lights nothing, which reads as success.
    expect(isSkippedGrowthTask('some_task_the_upstream_added_later')).toBe(true)
    expect(growthTaskSpec('some_task_the_upstream_added_later')).toBeUndefined()
  })

  it('skips exactly the kinds the orchestrator must not report', () => {
    for (const code of ['Buddy_App', 'Buddy_App_QQ', 'RichMeow_Chat', 'Library_read', 'first_buddy', 'Expert_Philanthropy']) {
      expect(isSkippedGrowthTask(code), code).toBe(true)
    }
  })

  it('runs the tasks that do have a reportable event', () => {
    for (const code of ['create_canvas', 'template_5', 'chat_5', 'black_cat', 'skill_1', 'automation_1']) {
      expect(isSkippedGrowthTask(code), code).toBe(false)
    }
  })

  it('inherits Object.prototype keys, not just own ones', () => {
    // `GROWTH_TASK_SPECS['toString']` is a function via the prototype chain; a
    // plain `in` check would call that "known" and then read `.kind` off it.
    expect(growthTaskSpec('toString')).toBeUndefined()
    expect(isSkippedGrowthTask('constructor')).toBe(true)
    expect(Object.keys(GROWTH_TASK_SPECS)).not.toContain('toString')
  })
})

describe('inGrowthNightWindow', () => {
  const Beijing = (hour: number, minute = 0): number => Date.UTC(2026, 5, 15, hour - 8, minute)

  it('opens at 23:00 Beijing and closes at 08:00 Beijing', () => {
    expect(inGrowthNightWindow(Beijing(22, 59))).toBe(false)
    expect(inGrowthNightWindow(Beijing(23, 0))).toBe(true)
    expect(inGrowthNightWindow(Beijing(0, 0))).toBe(true)
    expect(inGrowthNightWindow(Beijing(7, 59))).toBe(true)
    expect(inGrowthNightWindow(Beijing(8, 0))).toBe(false)
    expect(inGrowthNightWindow(Beijing(12, 0))).toBe(false)
  })

  it('reads Beijing wall time regardless of the host zone', () => {
    // The window is the upstream's own Beijing clock; a host-zone read would
    // shift the whole window by the machine's offset.
    const original = process.env['TZ']
    try {
      const at2330 = Beijing(23, 30)
      process.env['TZ'] = 'UTC'
      const utc = inGrowthNightWindow(at2330)
      process.env['TZ'] = 'America/New_York'
      expect(inGrowthNightWindow(at2330)).toBe(utc)
    } finally {
      process.env['TZ'] = original
    }
  })
})

describe('buildGrowthEvent', () => {
  it('always carries the account uid, without which the report counts nothing', () => {
    const uid = '38e34a71-3e51-4709-a88a-28e282bd242b'
    for (const code of Object.keys(GROWTH_TASK_SPECS)) {
      const spec = growthTaskSpec(code)!
      const event = buildGrowthEvent(uid, spec.kind, 0)
      expect(event['userId'], `${code}/${spec.kind}`).toBe(uid)
      expect(typeof event['eventCode'], `${code}/${spec.kind}`).toBe('string')
      expect(typeof event['timestamp'], `${code}/${spec.kind}`).toBe('number')
    }
  })

  it('keeps the generated ids distinct within one task', () => {
    const first = buildGrowthEvent('u', 'chat', 0)
    const second = buildGrowthEvent('u', 'chat', 1)
    expect(first['conversationId']).not.toBe(second['conversationId'])
    expect(first['requestId']).not.toBe(second['requestId'])
  })

  it('sends the nightly model for the night task and the chat model otherwise', () => {
    expect(buildGrowthEvent('u', 'cat', 0)['requestModelId']).toBe('glm-5.2')
    expect(buildGrowthEvent('u', 'glmchat', 0)['requestModelId']).toBe('glm-5.2')
    expect(buildGrowthEvent('u', 'chat', 0)['requestModelId']).toBe('deepseek-v4-flash')
  })

  it('falls back to a heartbeat for an unmapped kind instead of throwing', () => {
    // Only reachable if a spec is added without a matching branch above; a
    // throw here would take the whole sweep down.
    expect(buildGrowthEvent('u', 'not-a-kind')['eventCode']).toBe('heartbeat')
  })

  it('describes a real use for the expert tasks, not an empty event', () => {
    const team = buildGrowthEvent('u', 'team', 0)
    expect(team['eventCode']).toBe('expert_actual_use')
    expect(team['expertType']).toBe('team')
    expect(team['id']).toBe('CloudOpsTeam')
    expect(buildGrowthEvent('u', 'lighthouse', 0)['id']).toBe('ex_2cvvUZQhDyeJ')
    expect(buildGrowthEvent('u', 'expert', 0)['id']).toBe('ContentCreator')
  })

  it('gives each report a distinct id so the upstream counts more than the first', () => {
    // The upstream dedups reports by the event `id`: a repeated id counts once
    // per day. expert_5 needs 5 reports and Expert_team_use_3 needs 3, so a
    // fixed id silently caps them at one and the task can never complete.
    for (const kind of ['expert', 'team', 'lighthouse']) {
      const ids = [0, 1, 2, 3, 4].map((i) => buildGrowthEvent('u', kind, i)['id'])
      expect(new Set(ids).size).toBe(5)
    }
    expect(buildGrowthEvent('u', 'expert', 1)['id']).toBe('ContentCreator-1')
    expect(buildGrowthEvent('u', 'team', 2)['id']).toBe('CloudOpsTeam-2')
  })
})
