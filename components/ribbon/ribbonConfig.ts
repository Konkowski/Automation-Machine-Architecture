// ============================================================
// AMA — Ribbon definition: the workflow of each workspace
//
// Two workspaces, two workflows:
//
//   Code base (product owner):  1 Code base → 2 Architecture → 3 Risk → 4 Release
//   Machine (assembler):        1 Machine → 2 Assembly → 3 Analysis → 4 Verify and export
//
// Rule: the ribbon holds the ACTIONS of a step, the page holds the
// content. Nothing is offered twice. Every tab starts with a short
// "what to do here" hint and ends with the button for the next step.
// Pure data: Ribbon.tsx renders it, lib/commands.ts runs it.
// ============================================================
import type { LucideIcon } from 'lucide-react';
import {
    FilePlus, FolderOpen, Save, SaveAll, Download, Search, Users, CheckSquare, GitCompare,
    Eraser, Keyboard, Info, Link2, RefreshCw, GitBranch, Network, HardDrive, Settings2,
} from 'lucide-react';
import type { WorkspaceKind } from '../../types/machine';

export interface RibbonCmd {
    id: string;
    label: string;
    icon: LucideIcon;
    /** Page that owns the handler: navigate there first when elsewhere. */
    route?: string;
    /** Small buttons stack three-high inside a group. Default: large. */
    small?: boolean;
    tip?: string;
}

export interface RibbonGroup { label: string; cmds: RibbonCmd[] }

export interface RibbonTab {
    id: string;
    /** Step number shown before the label. */
    step?: number;
    label: string;
    /** Selecting the tab opens this page. */
    route: string;
    /** One or two sentences: what to do in this step. */
    hint: string;
    groups: RibbonGroup[];
    /** Id of the tab that comes next in the workflow. */
    next?: string;
}

const FIND: RibbonGroup = {
    label: 'Find',
    cmds: [{ id: 'view:search', label: 'Search', icon: Search, tip: 'Search entities and commands (Ctrl+K)' }],
};

// ─── Machine workspace ─────────────────────────────────────
export const MACHINE_TABS: RibbonTab[] = [
    {
        id: 'project', step: 1, label: 'Machine', route: '/project', next: 'asm',
        hint: 'Name the machine and link the code base it is built from. Then assemble it.',
        groups: [
            {
                label: 'Machine project',
                cmds: [
                    { id: 'file:new', label: 'New', icon: FilePlus, tip: 'New empty machine project' },
                    { id: 'file:open', label: 'Open', icon: FolderOpen, tip: 'Open a saved machine (JSON or Git ZIP)' },
                    { id: 'file:save', label: 'Save', icon: Save, tip: 'Save (Ctrl+S)' },
                    { id: 'file:saveAs', label: 'Save as', icon: SaveAll, small: true },
                ],
            },
            {
                label: 'Code base',
                cmds: [
                    { id: 'machine:link-codebase', label: 'Link code base', icon: Link2, tip: 'Take the library from a code base folder' },
                    { id: 'machine:refresh-codebase', label: 'Refresh', icon: RefreshCw, tip: 'Update the library snapshot from the linked code base' },
                ],
            },
            {
                label: 'Import from the PLC',
                cmds: [
                    { id: 'data:import-l5x', label: 'Studio 5000 (.L5X)', icon: Download, tip: 'Create a machine project from an .L5X file' },
                    { id: 'data:import-tia', label: 'TIA Portal', icon: Download, tip: 'Create a machine project from a TIA Portal project: blocks, tags, I/O, alarms and hardware' },
                ],
            },
        ],
    },
    {
        id: 'asm', step: 2, label: 'Assembly', route: '/assembly', next: 'analysis',
        hint: "Drag Released blocks from the code base into the tree. Then adjust this machine's SBOM and network topology: they can differ from the code base for customer requests.",
        groups: [
            {
                label: 'View',
                cmds: [
                    { id: 'asm:view:tree', label: 'Tree', icon: GitBranch, route: '/assembly', tip: 'Assemble the machine from blocks' },
                    { id: 'asm:view:topology', label: 'Topology', icon: Network, route: '/assembly', tip: 'Network topology of this machine' },
                    { id: 'asm:view:sbom', label: 'SBOM', icon: HardDrive, route: '/assembly', tip: 'Bill of materials of this machine' },
                ],
            },
            {
                label: 'Blocks',
                cmds: [{ id: 'nav:/', label: 'Adjust blocks', icon: Settings2, tip: 'Edit the code, alarms and components of this machine\'s blocks (kept as adjustments to the code base)' }],
            },
            FIND,
        ],
    },
    {
        id: 'analysis', step: 3, label: 'Analysis', route: '/dashboard', next: 'export',
        hint: 'See the machine as a whole: size, development time, risks and reuse.',
        groups: [],
    },
    {
        id: 'export', step: 4, label: 'Verify and export', route: '/export',
        hint: 'First verify the project, then generate the PLC code and documents with the cards below.',
        groups: [
            {
                label: 'Checks',
                cmds: [
                    { id: 'data:verify', label: 'Verify project', icon: CheckSquare, route: '/export', tip: 'Preliminary checks before generating the code' },
                ],
            },
        ],
    },
];

// ─── Code base workspace ───────────────────────────────────
export const CODEBASE_TABS: RibbonTab[] = [
    {
        id: 'project', step: 1, label: 'Code base', route: '/project', next: 'arch',
        hint: 'Open the code base repository (or start a new one) and name it. Machines are built from it.',
        groups: [
            {
                label: 'Code base folder',
                cmds: [
                    { id: 'codebase:open', label: 'Open', icon: FolderOpen, tip: 'Open a code base folder (a Git repository)' },
                    { id: 'codebase:save', label: 'Save', icon: Save, tip: 'Write the code base to its folder (Ctrl+S)' },
                    { id: 'codebase:save-as', label: 'Save to…', icon: SaveAll, small: true, tip: 'Write the code base to another folder' },
                ],
            },
            {
                label: 'Import from the PLC',
                cmds: [{ id: 'data:import-tia', label: 'TIA Portal', icon: Download, tip: 'Add the blocks of a TIA Portal project to the code base' }],
            },
        ],
    },
    {
        id: 'arch', step: 2, label: 'Architecture', route: '/', next: 'risk',
        hint: 'Build the reusable blocks: pick the level (UN, EM, CM, FB) on the left and press New. Then fill in the card on the right: code, variables, alarms, components and DFMEA.',
        groups: [FIND],
    },
    {
        id: 'risk', step: 3, label: 'Risk', route: '/risk', next: 'release',
        hint: 'See where the DFMEA says the code base needs attention: blocks, components, and what to do about each failure.',
        groups: [],
    },
    {
        id: 'release', step: 4, label: 'Release', route: '/release',
        hint: 'Review the blocks and release the stable ones: only Released blocks can be used by a machine. Then commit the code base.',
        groups: [],
    },
];

export const ribbonTabs = (kind: WorkspaceKind): RibbonTab[] => (kind === 'codebase' ? CODEBASE_TABS : MACHINE_TABS);

type BackstageItem = { id: string; label: string; icon: LucideIcon; desc: string; sep?: boolean; route?: string };

const ADVANCED_ITEMS: BackstageItem[] = [
    { id: 'nav:/git', label: 'Git history (advanced)', icon: GitBranch, desc: 'Full Git client: branches, remotes, tags. The Release step already commits for you.', sep: true },
];

const HELP_ITEMS: BackstageItem[] = [
    { id: 'help:shortcuts', label: 'Shortcuts', icon: Keyboard, desc: 'List of keyboard shortcuts.', sep: true },
    { id: 'help:about', label: 'About', icon: Info, desc: 'Version and credits.' },
];

/** The File tab opens a full-height menu (backstage) instead of a ribbon. */
export const backstageItems = (kind: WorkspaceKind): BackstageItem[] =>
    kind === 'codebase'
        ? [
            { id: 'codebase:open', label: 'Open code base', icon: FolderOpen, desc: 'Opens a code base folder (a Git repository).' },
            { id: 'codebase:save', label: 'Save code base', icon: Save, desc: 'Writes the code base to its folder.' },
            { id: 'codebase:save-as', label: 'Save code base to…', icon: SaveAll, desc: 'Writes the code base to another folder.' },
            { id: 'data:import-tia', label: 'Import from TIA Portal', icon: Download, desc: 'Adds the blocks of a TIA Portal project to the code base.' },
            { id: 'file:clear', label: 'Clear workspace', icon: Eraser, desc: 'Deletes all unsaved content of this workspace.', sep: true },
            { id: 'settings:users', label: 'Users', icon: Users, desc: 'Management of the users who sign the changes.' },
            ...ADVANCED_ITEMS,
            ...HELP_ITEMS,
        ]
        : [
            { id: 'file:new', label: 'New machine', icon: FilePlus, desc: 'Creates an empty machine project.' },
            { id: 'file:open', label: 'Open', icon: FolderOpen, desc: 'Opens a saved machine (JSON or Git ZIP).' },
            { id: 'file:save', label: 'Save', icon: Save, desc: 'Saves the machine to the current file.' },
            { id: 'file:saveAs', label: 'Save as', icon: SaveAll, desc: 'Saves the machine to a new file.' },
            { id: 'machine:link-codebase', label: 'Link a code base', icon: Link2, desc: 'Takes the library from a code base folder.', sep: true },
            { id: 'data:import-l5x', label: 'Import from Studio 5000', icon: Download, desc: 'Creates a new machine project from an .L5X file.' },
            { id: 'data:import-tia', label: 'Import from TIA Portal', icon: Download, desc: 'Creates a new machine project from a TIA Portal project.' },
            { id: 'data:compare', label: 'Compare projects', icon: GitCompare, route: '/export', desc: 'Compares this machine with another project or with the master library.' },
            { id: 'file:clear', label: 'Clear workspace', icon: Eraser, desc: 'Deletes all unsaved content of this workspace.', sep: true },
            { id: 'settings:users', label: 'Users', icon: Users, desc: 'Management of the users who sign the changes.' },
            ...ADVANCED_ITEMS,
            ...HELP_ITEMS,
        ];
