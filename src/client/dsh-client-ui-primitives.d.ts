/**
 * Shape of the one DSH browser primitive this card borrows.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` is not a package dependency: the
 * client bundle is wrapped in `window.__ModuleLoader__.load({id, factory})`, so
 * the specifier is resolved at runtime by DSH's own loader against its own
 * `node_modules`, exactly as `dsh-codex-subscription` uses it without declaring
 * it. Only the type side needs help here, so this declares the `Switch` props
 * copied from the shipped implementation
 * (`lib/index.js` → `function Switch({ checked, onChange, label, disabled, title, className })`).
 * Nothing but `Switch` is declared: a wider surface would be a promise this file
 * cannot keep in sync with the host.
 *
 * @module dsh-workbuddy/client/dsh-client-ui-primitives
 */

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactElement } from 'react'

  /** A fully controlled toggle: the owner keeps `checked`, the click asks for the flip. */
  export interface WorkBuddySwitchProps {
    /** Current state; the control never holds state itself. */
    checked: boolean
    /** Called with the state the click asks for, i.e. `!checked`. */
    onChange: (enabled: boolean) => void
    /** Localized accessible name, owned by the render site. */
    label: string
    /** Whether the control refuses input. Owners also set this while a write is in flight. */
    disabled?: boolean
    /** Localized hover text, typically why the toggle is locked. */
    title?: string
    /** Extra class for layout placement. */
    className?: string
  }

  /** Render a toggle switch. */
  export function Switch(props: WorkBuddySwitchProps): ReactElement
}
