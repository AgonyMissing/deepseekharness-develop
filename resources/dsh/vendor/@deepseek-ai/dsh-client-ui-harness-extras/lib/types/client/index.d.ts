/**
 * Harness-extras surface plugin, browser half: registers the desktop-shell
 * settings sections (MCP servers / skills / subagents / commands / hooks /
 * git) that render management lists over the local bridge API, plus the
 * file-explorer and terminal overlays. Sections ride the standard
 * `settings.section` slot — the kernel's settings shell owns the nav rows,
 * the selection animation, and the content chrome — and the overlays ride
 * `shell.overlay`, so this package contributes bodies only, never chrome.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
/** Required services: slots for registration, workspaces for Git/Archive pages. */
export declare const inject: string[];
/**
 * Client plugin body: register the management sections and the two overlays
 * once per slot generation.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map