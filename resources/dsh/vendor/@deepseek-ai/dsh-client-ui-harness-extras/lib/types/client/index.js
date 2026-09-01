/**
 * Harness-extras surface plugin, browser half: registers the desktop-shell
 * settings sections (MCP servers / skills / subagents / commands / hooks /
 * git) that render management lists over the local bridge API, plus the
 * file-explorer and terminal overlays. Sections ride the standard
 * `settings.section` slot — the kernel's settings shell owns the nav rows,
 * the selection animation, and the content chrome — and the overlays ride
 * `shell.overlay`, so this package contributes bodies only, never chrome.
 */
import { McpSection, SkillsSection, SubagentsSection } from "./HarnessSection.js";
import { bindSessions, bindWorkspaces, CommandsSection, GitSection, HooksSection, IndexSection, } from "./Panels.js";
/** Required services: slots for registration, workspaces for Git/Archive pages. */
export const inject = ['slots', 'workspaces', 'sessions'];
/** Nav order: after the kernel's own sections (general 0 / models 10 / presets 20). */
const ORDER_MCP = 30;
const ORDER_SKILLS = 40;
const ORDER_SUBAGENTS = 50;
const ORDER_COMMANDS = 60;
const ORDER_HOOKS = 70;
const ORDER_GIT = 80;
const ORDER_INDEX = 90;
/**
 * Client plugin body: register the management sections and the two overlays
 * once per slot generation.
 * @param ctx - client root context.
 */
export function apply(ctx) {
    bindWorkspaces(ctx.workspaces);
    bindSessions(ctx.sessions);
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'mcp-servers',
        order: ORDER_MCP,
        label: () => 'MCP 服务器',
    }, McpSection));
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'skills',
        order: ORDER_SKILLS,
        label: () => '技能',
    }, SkillsSection));
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'subagents',
        order: ORDER_SUBAGENTS,
        label: () => '子智能体',
    }, SubagentsSection));
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'commands',
        order: ORDER_COMMANDS,
        label: () => '命令',
    }, CommandsSection));
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'hooks',
        order: ORDER_HOOKS,
        label: () => '钩子',
    }, HooksSection));
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'git',
        order: ORDER_GIT,
        label: () => 'Git',
    }, GitSection));
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'index',
        order: ORDER_INDEX,
        label: () => '索引库',
    }, IndexSection));
}
//# sourceMappingURL=index.js.map