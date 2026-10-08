/**
 * Browser half: the WorkBuddy account and model-policy card as its own
 * section of the Settings sidebar.
 *
 * @module dsh-workbuddy/client
 */

import { WorkBuddyPluginCard } from './WorkBuddyPluginCard.tsx'
import type { WorkBuddyPluginCardInjected } from './WorkBuddyPluginCard.tsx'
import { en, zh } from './locales.ts'

/** Minimal public shape; the client services are injected by DSH at runtime. */
interface ClientContext {
  effect(effect: () => void | (() => void), name?: string): void
  locale: {
    register(namespace: string, copy: unknown): void
    bind(namespace: string): unknown
  }
  slots: {
    inject(name: string, factory: () => unknown): void
    register(spec: unknown, component: unknown): unknown
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-workbuddy-client'

/**
 * Client services required by the Plugin configuration contribution.
 *
 * The `settings.section` slot is declared by `@deepseek-ai/dsh-client-ui-settings`
 * (through its settings-shell/general parts) and rendered as one entry of the
 * Settings sidebar, and the card's copy registers through
 * `@deepseek-ai/dsh-client-locale`; both are named in the package's
 * `dsh.client.inject` list, so cordis has activated them before this plugin's
 * fiber starts.
 */
export const inject = ['slots', 'locale']

/**
 * Register the card copy and the WorkBuddy card as one Settings sidebar
 * section.
 *
 * The body is wrapped so that a slot-API breaking change degrades to a
 * `console.error` instead of throwing into the DSH loader and raising the
 * "Failed to load plugins" banner. The host provider keeps working: the
 * `workbuddy-ai` model channel is unaffected, and
 * `dsh-workbuddy status` reports host health via the heartbeat file.
 */
export function apply(ctx: ClientContext): void {
  try {
    const namespace = 'settings.workbuddy-ai'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-workbuddy: settings copy')
    const t = ctx.locale.bind(namespace) as WorkBuddyPluginCardInjected['t']
    // `settings.section` is the list slot the Settings sidebar renders as its
    // left-hand menu. `order: 16` sits just after the built-in sections
    // (account -10, general 0, models 10, plugins 15) without colliding with
    // the Codex subscription section, which also claims 15. The card is mounted
    // whole, with no region prop: it keeps its own cn/global tabs.
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'workbuddy-ai',
      order: 16,
      label: () => t('nav'),
      locale: namespace,
      inject: (): WorkBuddyPluginCardInjected => ({ t }),
    }, WorkBuddyPluginCard))
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    // Developers see the full cause in the browser console; users see no banner.
    console.error('[dsh-workbuddy] client card failed to load (host provider unaffected):', error)
  }
}
