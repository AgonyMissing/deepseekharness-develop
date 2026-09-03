/**
 * Harness-extras panels: the commands / hooks / git settings sections and
 * the file + terminal shell overlays, all over the desktop shell's local
 * bridge API. Sections ride the `settings.section` slot (kernel chrome);
 * overlays ride `shell.overlay` (additive floating layer).
 */
import { type ReactNode } from 'react';
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client';
/** Bind the kernel workspace service for the Git and Archive panels. */
export declare function bindWorkspaces(service: IWorkspaces): void;
export declare function bindSessions(service: {
    list: {
        getSnapshot: () => {
            byId: Record<string, {
                displayTitle?: string;
            }>;
        };
    };
}): void;
export declare function CommandsSection(): ReactNode;
export declare function HooksSection(): ReactNode;
export declare function GitSection(): ReactNode;
export declare function FilesOverlay(): ReactNode;
export declare function TerminalOverlay(): ReactNode;
/**
 * Code-index settings: the codegraph MCP server carries the repository
 * index. The master switch toggles the server itself (restart to apply);
 * the two granular toggles ride its env contract.
 */
export declare function IndexSection(): ReactNode;
export declare function ArchiveSection(): ReactNode;
//# sourceMappingURL=Panels.d.ts.map