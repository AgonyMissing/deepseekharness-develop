/**
 * Harness-extras surface plugin, browser half: registers the desktop-shell
 * settings sections (MCP servers / skills / subagents / commands / hooks /
 * git) that render management lists over the local bridge API, plus the
 * file-explorer and terminal overlays. Sections ride the standard
 * `settings.section` slot — the kernel's settings shell owns the nav rows,
 * the selection animation, and the content chrome — and the overlays ride
 * `shell.overlay`, so this package contributes bodies only, never chrome.
 */

// Type-only: the cordis Context face and the SlotRegistry service merge.
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the AppFrame SlotMap merge (the 'shell.overlay' entry).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the Session Controller service merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the Workspace Controller service merge (ctx.workspaces).
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { McpSection, SkillsSection, SubagentsSection } from './HarnessSection.tsx'
import { bindSessions, bindWorkspaces, CommandsSection, GitSection, HooksSection, IndexSection,  } from './Panels.tsx'

/** Required services: slots for registration, workspaces for Git/Archive pages. */
export const inject = ['slots', 'workspaces', 'sessions']

/** Nav order: after the kernel's own sections (general 0 / models 10 / presets 20). */
const ORDER_MCP = 30
const ORDER_SKILLS = 40
const ORDER_SUBAGENTS = 50
const ORDER_COMMANDS = 60
const ORDER_HOOKS = 70
const ORDER_GIT = 80
const ORDER_INDEX = 90

/**
 * Client plugin body: register the management sections and the two overlays
 * once per slot generation.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  bindWorkspaces(ctx.workspaces)
  bindSessions(ctx.sessions)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mcp-servers',
    order: ORDER_MCP,
    label: () => 'MCP 服务器',
  }, McpSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'skills',
    order: ORDER_SKILLS,
    label: () => '技能',
  }, SkillsSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'subagents',
    order: ORDER_SUBAGENTS,
    label: () => '子智能体',
  }, SubagentsSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'commands',
    order: ORDER_COMMANDS,
    label: () => '命令',
  }, CommandsSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'hooks',
    order: ORDER_HOOKS,
    label: () => '钩子',
  }, HooksSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'git',
    order: ORDER_GIT,
    label: () => 'Git',
  }, GitSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'index',
    order: ORDER_INDEX,
    label: () => '索引库',
  }, IndexSection))


}

