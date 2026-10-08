import { createRequire } from 'node:module'
const req = createRequire(import.meta.url)
const z = req('@deepseek-ai/schemastery')
const Config = z.object({
  authFile: z.string().description('a'),
  cnAuthFile: z.string(),
  refreshActiveMinutes: z.number().min(1).default(15),
  refreshInactiveMinutes: z.number().min(1).default(60),
  autoCheckin: z.boolean().default(false),
  probeConsent: z.boolean().default(false),
  modelScope: z.union([z.const('free'), z.const('all')]).default('free'),
  cnModelScope: z.union([z.const('free'), z.const('all')]).default('free'),
  disabledModels: z.array(z.string()).default([]),
  cnDisabledModels: z.array(z.string()).default([]),
  productConfigFile: z.string(),
  allowedHosts: z.array(z.string()).default([]),
})
const base = { authFile: 'x', cnAuthFile: 'y', productConfigFile: 'z' }
for (const [label, input] of [['undefined', undefined], ['null', null], ['{}', {}], ['base', base]]) {
  try {
    const out = Config(input)
    console.log(`OK   ${label} -> ${JSON.stringify(out)}`)
  } catch (e) {
    console.log(`THROW ${label} -> ${e && e.constructor && e.constructor.name}: ${e && e.message}`)
  }
}