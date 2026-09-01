/**
 * Local Context augmentation for the standalone alpha.3 port. In the source
 * workspace these merges arrive through project references; here they are
 * declared explicitly so the bundle compiles against the published packages.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: {
      inject(name: string, fn: () => unknown): void
      register(options: {
        name: string
        id: string
        order: number
        label: () => string
      }, component: unknown): unknown
    }
    workspaces: IWorkspaces
    sessions: { list: { getSnapshot: () => { byId: Record<string, { displayTitle?: string }> } } }
  }
}
