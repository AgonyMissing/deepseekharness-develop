/**
 * Harness-extras settings sections: three management lists over the desktop
 * shell's local bridge API (`window.__DSH_MCP_API__`, injected by the
 * Electron main process). Each section renders inside the stock settings
 * panel through the `settings.section` slot, so nav identity, selection
 * animation, and content chrome are the kernel's own.
 *
 * - MCP servers: full CRUD over mcp-servers.json (a save restarts the host
 *   server so the regenerated patch rows load).
 * - Skills: list/install/remove over the app-managed dsh-home/skills root.
 * - Subagents: read-only projection of the delegation tool rows declared
 *   across the agent presets.
 */
import { type ReactNode } from 'react';
export declare function McpSection(): ReactNode;
export declare function SkillsSection(): ReactNode;
export declare function SubagentsSection(): ReactNode;
