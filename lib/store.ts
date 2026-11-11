// ============================================================
// AMA — Zustand Global Store (Architecture DB + Assembly)
//
// Layout of the state:
//   - four flat entity lists (library/units/equipmentModules/controlModules)
//   - one assembly project (instance tree + SBOM + network)
//   - UI state (selection, tabs, user…)
//
// All entity mutations go through two generic helpers (patchEntity /
// the sub-list factories) so adding a new sub-collection or a new
// entity level touches ONE place, not fifteen.
// ============================================================
import { create } from 'zustand';
import type {
    FunctionBlock, Unit, EquipmentModule, ControlModule,
    Variable, Alarm, IOSignal, DFMEAEntry, BlockBase, Revision,
    AssemblyProject, AssemblyNode, EntityLevel, EntityPatch,
    DevTimes, HardwareItem, HardwareOverrides, WorkspaceKind, CodebaseInfo
} from '../types/machine';
import {
    defaultLibraryFBs, defaultUnits, defaultEMs, defaultCMs, defaultAssembly
} from './defaults';
import { generateId, createEmptyBlock } from './helpers';
import { bumpVersion, META_KEYS } from './releaseCheck';
import { isAssemblable } from './deviation';
import { normalizeProjectData, normalizeEntityListsOnly, emptyAssembly } from './normalize';

type TabId = 'info' | 'variables' | 'alarms' | 'io' | 'dfmea' | 'code' | 'revisions' | 'devtimes' | 'bom';

// The four flat entity lists, addressable by key
const LIST_KEYS = ['library', 'units', 'equipmentModules', 'controlModules'] as const;
type ListKey = typeof LIST_KEYS[number];

const listKeyOfLevel = (level: EntityLevel): ListKey =>
    level === 'FB' ? 'library'
    : level === 'UN' ? 'units'
    : level === 'EM' ? 'equipmentModules'
    : 'controlModules';

// Sub-collections every entity carries (rows all have an `id`)
type SubListKey = 'variables' | 'alarms' | 'io' | 'dfmea' | 'revisions';

interface AMAState {
    // --- Architecture Database ---
    library: FunctionBlock[];
    units: Unit[];
    equipmentModules: EquipmentModule[];
    controlModules: ControlModule[];

    // --- Assembly ---
    assembly: AssemblyProject;

    // --- UI State ---
    selectedNodeId: string | null;
    /** A row inside the open editor tab to highlight (set when jumping from a release check). */
    focusItem: string | null;
    selectedTab: TabId;
    sidebarCollapsed: boolean;
    searchQuery: string;
    categoryFilter: string | null;
    activeUser: string;
    archTab: EntityLevel;   // which tab is active in Architecture

    // --- Library ---
    addFB: (fb: FunctionBlock) => void;
    updateFB: (id: string, updates: Partial<FunctionBlock>) => void;
    deleteFB: (id: string) => void;

    // --- Architecture CRUD ---
    addUnit: (name: string) => void;
    addEM: (name: string) => void;
    addCM: (name: string) => void;
    updateEntity: (id: string, level: EntityLevel, updates: EntityPatch) => void;
    deleteEntity: (id: string, level: EntityLevel) => void;
    assignFBToEntity: (entityId: string, level: EntityLevel, fbId: string) => void;
    unassignFBFromEntity: (entityId: string, level: EntityLevel, fbId: string) => void;

    // --- Sub-entity CRUD ---
    addVariable: (nodeId: string, variable: Variable) => void;
    updateVariable: (nodeId: string, varId: string, updates: Partial<Variable>) => void;
    deleteVariable: (nodeId: string, varId: string) => void;
    addAlarm: (nodeId: string, alarm: Alarm) => void;
    updateAlarm: (nodeId: string, alarmId: string, updates: Partial<Alarm>) => void;
    deleteAlarm: (nodeId: string, alarmId: string) => void;
    addIO: (nodeId: string, io: IOSignal) => void;
    updateIO: (nodeId: string, ioId: string, updates: Partial<IOSignal>) => void;
    deleteIO: (nodeId: string, ioId: string) => void;
    addDFMEA: (nodeId: string, entry: DFMEAEntry) => void;
    updateDFMEA: (nodeId: string, entryId: string, updates: Partial<DFMEAEntry>) => void;
    deleteDFMEA: (nodeId: string, entryId: string) => void;
    addRevision: (nodeId: string, revision: Revision) => void;

    // --- Dev Times (UN/EM/CM only) ---
    updateDevTimes: (entityId: string, level: EntityLevel, times: Partial<DevTimes>) => void;

    // --- Assembly Actions ---
    addToAssembly: (parentAsmId: string | null, refId: string, level: EntityLevel) => void;
    removeFromAssembly: (asmNodeId: string) => void;
    refreshAssemblyNode: (asmNodeId: string) => void;
    /** Instance data of one assembled node: name, parameters, chosen alternatives. */
    updateAssemblyNode: (asmNodeId: string, patch: Partial<Pick<AssemblyNode, 'label' | 'params' | 'componentChoice'>>) => void;
    /** Adds `count` copies of a node (with its subtree) right after it, named "<name> 2", "<name> 3"... */
    duplicateAssemblyNode: (asmNodeId: string, count: number) => void;
    updateAssemblyMeta: (updates: Partial<Pick<AssemblyProject, 'name' | 'description' | 'secondaryDescription' | 'version'>>) => void;
    updateAssemblySBOM: (sbom: HardwareItem[]) => void;
    /** Machine-specific change of a derived SBOM row; null returns it to the code base values. */
    overrideSbomRow: (rowId: string, overrides: HardwareOverrides | null) => void;
    /** Takes a derived part off this machine (customer request); it stays off on re-sync. */
    removeSbomPart: (rowId: string) => void;
    restoreSbomPart: (partId: string) => void;
    updateNetworkTopology: (nodes: any[], edges: any[]) => void;

    // --- Navigation & UI ---
    selectNode: (id: string | null) => void;
    setTab: (tab: TabId) => void;
    toggleSidebar: () => void;
    setSearchQuery: (q: string) => void;
    setCategoryFilter: (c: string | null) => void;
    setActiveUser: (name: string) => void;
    setArchTab: (tab: EntityLevel) => void;

    // --- Persistence ---
    loadProject: (data: any) => void;
    loadArchitecture: (data: any) => void;
    resetToDefaults: () => void;
    clearWorkspace: () => void;

    // --- Workspace State ---
    /** Editing the reusable code base (product owner) or assembling a machine. */
    workspaceKind: WorkspaceKind;
    /** Code base mode: the opened code base. Machine mode: the code base the library comes from. */
    codebase: CodebaseInfo | null;
    /** The workspace of the OTHER kind, parked while this one is being edited. */
    parked: Partial<Record<WorkspaceKind, any>>;
    setCodebase: (info: CodebaseInfo | null) => void;
    switchWorkspaceKind: (kind: WorkspaceKind) => void;
    workspaceLoaded: boolean;
    projectFilePath: string | null;   // native file path when opened/saved via Electron

    // --- Helpers ---
    findEntityById: (id: string) => BlockBase | null;
}

/**
 * The SBOM hardware comes from the Architecture: every BOM part of every
 * assembled entity flows into the machine SBOM, with quantities multiplied
 * by the number of assembled instances. Rows derived this way carry
 * sourcePartId; the user only refines firmware / IP / zone / notes on them.
 * Manually added rows (no sourcePartId) are left untouched.
 */
function syncSbomFromAssembly(s: {
    units: Unit[]; equipmentModules: EquipmentModule[]; controlModules: ControlModule[];
    assembly: AssemblyProject;
}): HardwareItem[] {
    // Per instance: a node may pick an alternative for a BOM part (componentChoice).
    // Alternatives get their own row, keyed "<partId>::<alternativeId>".
    const byId = new Map<string, any>([...s.units, ...s.equipmentModules, ...s.controlModules].map(e => [e.id, e]));
    interface Expected { part: any; qty: number; uses: Map<string, number> }
    const expected = new Map<string, Expected>();
    const walk = (nodes: AssemblyNode[]) => {
        for (const n of nodes) {
            const e = byId.get(n.refId);
            if (e) {
                for (const base of e.bom || []) {
                    const alt = (base.alternatives || []).find((a: any) => a.id === n.componentChoice?.[base.id]);
                    const key = alt ? `${base.id}::${alt.id}` : base.id;
                    const part = alt
                        ? { ...base, id: key, code: alt.code, manufacturer: alt.manufacturer || base.manufacturer, description: alt.description || base.description, internalCode: '' }
                        : base;
                    const ex = expected.get(key) || { part, qty: 0, uses: new Map<string, number>() };
                    ex.qty += base.quantity || 0;
                    ex.uses.set(e.name, (ex.uses.get(e.name) || 0) + 1);
                    expected.set(key, ex);
                }
            }
            walk(n.children);
        }
    };
    walk(s.assembly.tree);
    const labelOf = (ex: Expected) => [...ex.uses].map(([name, k]) => (k > 1 ? `${k}x ${name}` : name)).join(', ');

    const removed = new Set((s.assembly.sbomRemoved || []).map(r => r.partId));
    for (const key of removed) expected.delete(key);
    const out: HardwareItem[] = [];
    for (const row of s.assembly.sbom || []) {
        if (!row.sourcePartId) { out.push(row); continue; }   // manual row
        const ex = expected.get(row.sourcePartId);
        if (!ex) continue;                                     // no longer assembled
        const ov = row.overrides || {};   // machine-specific changes win over the code base
        out.push({
            ...row,   // preserves firmware / ip / mac / zone / vlan / notes edits
            type: ex.part.type || 'Hardware',
            hardware: ov.hardware ?? (ex.part.description || ex.part.code || ''),
            quantity: ov.quantity ?? ex.qty,
            internalCode: ov.internalCode ?? (ex.part.internalCode || ''),
            supplierCode: ov.supplierCode ?? (ex.part.code || ''),
            manufacturer: ov.manufacturer ?? (ex.part.manufacturer || ''),
            unit: ex.part.unit || 'pz',
            sourceEntity: labelOf(ex),
        });
        expected.delete(row.sourcePartId);
    }
    for (const ex of expected.values()) {
        out.push({
            id: generateId(),
            type: ex.part.type || 'Hardware',
            hardware: ex.part.description || ex.part.code || '',
            firmware: '',
            quantity: ex.qty,
            notes: ex.part.notes || '',
            internalCode: ex.part.internalCode || '',
            supplierCode: ex.part.code || '',
            manufacturer: ex.part.manufacturer || '',
            unit: ex.part.unit || 'pz',
            sourcePartId: ex.part.id,
            sourceEntity: labelOf(ex),
        });
    }
    return out;
}

export const useStore = create<AMAState>((set, get) => {

    // ─── Generic entity mutation helpers ─────────────────────
    // Find which flat list holds the entity, apply the updater to it.
    // Every add/update/delete of variables, alarms, IO, DFMEA, revisions
    // and entity fields funnels through here.
    // Release rule: in the code base, any real change to a Released block takes it
    // back to Draft, raises its version and logs a revision. A Released block is a
    // promise to the machines that use it; it cannot change silently.
    const demoteIfReleased = (prev: any, next: any) => {
        if (get().workspaceKind !== 'codebase') return next;
        if (prev.status !== 'Released' || next.status !== prev.status) return next;
        const changed = Object.keys(next).some(k => !META_KEYS.has(k) && next[k] !== prev[k]);
        if (!changed) return next;
        const version = bumpVersion(prev.currentVersion);
        return {
            ...next, status: 'Draft', currentVersion: version,
            revisions: [...(next.revisions || []), {
                version, date: new Date().toISOString().slice(0, 10),
                author: get().activeUser || 'AMA', notes: 'Edited after release: back to Draft',
            }],
        };
    };

    const patchEntity = (nodeId: string, updater: (e: any) => any, level?: EntityLevel) => {
        const s = get();
        const keys: readonly ListKey[] = level ? [listKeyOfLevel(level)] : LIST_KEYS;
        for (const key of keys) {
            if ((s[key] as BlockBase[]).some(e => e.id === nodeId)) {
                set(s2 => ({
                    [key]: (s2[key] as any[]).map(e => e.id === nodeId ? demoteIfReleased(e, updater(e)) : e),
                } as Partial<AMAState>));
                return true;
            }
        }
        return false;
    };

    // Factories for the repetitive sub-list CRUD
    const subAdd = <T,>(listKey: SubListKey) => (nodeId: string, item: T) =>
        patchEntity(nodeId, e => ({ ...e, [listKey]: [...(e[listKey] || []), item] }));
    const subUpdate = <T extends { id: string },>(listKey: SubListKey) => (nodeId: string, itemId: string, updates: Partial<T>) =>
        patchEntity(nodeId, e => ({
            ...e, [listKey]: (e[listKey] || []).map((x: T) => x.id === itemId ? { ...x, ...updates } : x),
        }));
    const subDelete = (listKey: SubListKey) => (nodeId: string, itemId: string) =>
        patchEntity(nodeId, e => ({
            ...e, [listKey]: (e[listKey] || []).filter((x: { id: string }) => x.id !== itemId),
        }));

    // Build an assembly subtree from the entity's architecture assignments.
    // The `path` set guards against reference cycles in (corrupted) data —
    // without it a self-referencing assignment would hang the app.
    const buildAssemblyChildren = (refId: string, path: Set<string>): AssemblyNode[] => {
        if (path.has(refId)) return [];
        path.add(refId);
        const ent = get().findEntityById(refId);
        const children: AssemblyNode[] = [];
        if (ent) {
            const pushAll = (ids: string[] | undefined, lvl: EntityLevel) => {
                for (const cid of ids || []) {
                    children.push({
                        id: generateId(), refId: cid, level: lvl,
                        children: buildAssemblyChildren(cid, path),
                    });
                }
            };
            pushAll((ent as any).assignedEMs, 'EM');
            pushAll((ent as any).assignedCMs, 'CM');
            pushAll((ent as any).assignedFBs, 'FB');
        }
        path.delete(refId);
        return children;
    };

    return {
    // --- Initial State ---
    library: [],
    units: [],
    equipmentModules: [],
    controlModules: [],
    assembly: emptyAssembly(),
    workspaceLoaded: false,
    workspaceKind: 'machine',
    codebase: null,
    parked: {},
    projectFilePath: null,
    selectedNodeId: null,
    focusItem: null,
    selectedTab: 'info',
    sidebarCollapsed: false,
    searchQuery: '',
    categoryFilter: null,
    activeUser: typeof window !== 'undefined' ? (localStorage.getItem('ama_user') || '') : '',
    archTab: 'UN',

    // ─── Library ─────────────────────────────────────────
    addFB: (fb) => set(s => ({ library: [...s.library, fb] })),
    updateFB: (id, updates) => { patchEntity(id, e => ({ ...e, ...updates }), 'FB'); },
    deleteFB: (id) => get().deleteEntity(id, 'FB'),

    // ─── Architecture CRUD ──────────────────────────────
    addUnit: (name) => set(s => ({
        units: [...s.units, createEmptyBlock('UN', name, s.activeUser) as Unit],
    })),
    addEM: (name) => set(s => ({
        equipmentModules: [...s.equipmentModules, createEmptyBlock('EM', name, s.activeUser) as EquipmentModule],
    })),
    addCM: (name) => set(s => ({
        controlModules: [...s.controlModules, createEmptyBlock('CM', name, s.activeUser) as ControlModule],
    })),

    updateEntity: (id, level, updates) => {
        const user = get().activeUser;
        patchEntity(id, e => ({ ...e, ...updates, lastModifiedBy: user }), level);
        // BOM edits and renames in Architecture must reflect on the machine SBOM
        if (level !== 'FB' && ('bom' in updates || 'name' in updates)) {
            const st = get();
            set({ assembly: { ...st.assembly, sbom: syncSbomFromAssembly(st) } });
        }
    },

    deleteEntity: (id, level) => set(s => {
        // Cascade: also remove every assignedFBs/EMs/CMs reference and every
        // assembly tree instance, so no dangling refs are left behind.
        const stripRefs = (e: any) => {
            let changed = false;
            const out = { ...e };
            for (const key of ['assignedFBs', 'assignedEMs', 'assignedCMs']) {
                if (Array.isArray(e[key]) && e[key].includes(id)) {
                    out[key] = e[key].filter((x: string) => x !== id);
                    changed = true;
                }
            }
            return changed ? out : e;
        };
        const pruneTree = (nodes: AssemblyNode[]): AssemblyNode[] =>
            nodes
                .filter(n => n.refId !== id)
                .map(n => ({ ...n, children: pruneTree(n.children) }));

        const next = {
            library: level === 'FB' ? s.library.filter(e => e.id !== id) : s.library,
            units: (level === 'UN' ? s.units.filter(e => e.id !== id) : s.units).map(stripRefs),
            equipmentModules: (level === 'EM' ? s.equipmentModules.filter(e => e.id !== id) : s.equipmentModules).map(stripRefs),
            controlModules: (level === 'CM' ? s.controlModules.filter(e => e.id !== id) : s.controlModules).map(stripRefs),
            assembly: { ...s.assembly, tree: pruneTree(s.assembly.tree) },
        };
        // hardware sourced from the deleted entity leaves the SBOM too,
        // and a selection pointing at the deleted entity is cleared
        next.assembly.sbom = syncSbomFromAssembly(next);
        return {
            ...next,
            selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
        };
    }),

    assignFBToEntity: (entityId, level, fbId) => {
        patchEntity(entityId, e => ({ ...e, assignedFBs: [...new Set([...(e.assignedFBs || []), fbId])] }), level);
    },

    unassignFBFromEntity: (entityId, level, fbId) => {
        patchEntity(entityId, e => ({
            ...e,
            assignedFBs: (e.assignedFBs || []).filter((id: string) => id !== fbId),
        }), level);
    },

    // ─── Sub-entity CRUD (works across all flat lists) ──
    addVariable: subAdd<Variable>('variables'),
    updateVariable: subUpdate<Variable>('variables'),
    deleteVariable: subDelete('variables'),
    addAlarm: subAdd<Alarm>('alarms'),
    updateAlarm: subUpdate<Alarm>('alarms'),
    deleteAlarm: subDelete('alarms'),
    addIO: subAdd<IOSignal>('io'),
    updateIO: subUpdate<IOSignal>('io'),
    deleteIO: subDelete('io'),
    addDFMEA: subAdd<DFMEAEntry>('dfmea'),
    updateDFMEA: subUpdate<DFMEAEntry>('dfmea'),
    deleteDFMEA: subDelete('dfmea'),
    addRevision: (nodeId, revision) => {
        patchEntity(nodeId, e => ({ ...e, revisions: [...(e.revisions || []), revision] }));
    },

    updateDevTimes: (entityId, level, times) => {
        patchEntity(entityId, e => ({
            ...e,
            devTimes: { ...(e.devTimes || { plcHours: 0, hmiHours: 0, commissioningHours: 0 }), ...times },
        }), level);
    },

    // ─── Assembly Actions ────────────────────────────────
    addToAssembly: (parentAsmId, refId, level) => set(s => {
        if (s.workspaceKind === 'machine' && s.codebase) {
            const ent = [...s.units, ...s.equipmentModules, ...s.controlModules, ...s.library].find(e => e.id === refId);
            if (ent && !isAssemblable(ent)) return {};   // governance: code base blocks must be Released; the machine's own are free
        }
        const newNode: AssemblyNode = {
            id: generateId(),
            refId,
            level,
            children: buildAssemblyChildren(refId, new Set()),
        };

        // add as child of a specific assembly node, or at root level
        const addChild = (nodes: AssemblyNode[]): AssemblyNode[] =>
            nodes.map(n =>
                n.id === parentAsmId
                    ? { ...n, children: [...n.children, newNode] }
                    : { ...n, children: addChild(n.children) }
            );
        const tree = !parentAsmId ? [...s.assembly.tree, newNode] : addChild(s.assembly.tree);
        const assembly = { ...s.assembly, tree };
        // hardware follows the architecture into the machine SBOM
        return { assembly: { ...assembly, sbom: syncSbomFromAssembly({ ...s, assembly }) } };
    }),

    // Rebuild a node's children from the entity's current architecture
    // assignments (the subtree is snapshotted at drop time and does not
    // track later assignment changes — this re-syncs it on demand).
    refreshAssemblyNode: (asmNodeId) => set(s => {
        const refresh = (nodes: AssemblyNode[]): AssemblyNode[] =>
            nodes.map(n => n.id === asmNodeId
                ? { ...n, children: buildAssemblyChildren(n.refId, new Set()) }
                : { ...n, children: refresh(n.children) });
        const assembly = { ...s.assembly, tree: refresh(s.assembly.tree) };
        return { assembly: { ...assembly, sbom: syncSbomFromAssembly({ ...s, assembly }) } };
    }),

    updateAssemblyNode: (asmNodeId, patch) => set(s => {
        const upd = (nodes: AssemblyNode[]): AssemblyNode[] =>
            nodes.map(n => n.id === asmNodeId ? { ...n, ...patch } : { ...n, children: upd(n.children) });
        const assembly = { ...s.assembly, tree: upd(s.assembly.tree) };
        return { assembly: { ...assembly, sbom: syncSbomFromAssembly({ ...s, assembly }) } };
    }),

    duplicateAssemblyNode: (asmNodeId, count) => set(s => {
        const n = Math.max(1, Math.min(50, Math.floor(count) || 1));
        const clone = (node: AssemblyNode): AssemblyNode => ({
            ...node, id: generateId(),
            params: (node.params || []).map(p => ({ ...p, id: generateId() })),
            children: node.children.map(clone),
        });
        const baseName = (nodes: AssemblyNode[]): string => {
            for (const x of nodes) {
                if (x.id === asmNodeId) {
                    const ent = [...s.units, ...s.equipmentModules, ...s.controlModules, ...s.library].find(e => e.id === x.refId);
                    return x.label || ent?.name || 'Instance';
                }
                const r = baseName(x.children);
                if (r) return r;
            }
            return '';
        };
        const stem = baseName(s.assembly.tree).replace(/\s+\d+$/, '');
        const dup = (nodes: AssemblyNode[]): AssemblyNode[] =>
            nodes.flatMap(x => {
                if (x.id !== asmNodeId) return [{ ...x, children: dup(x.children) }];
                const copies = Array.from({ length: n }, (_, i) => ({ ...clone(x), label: `${stem} ${i + 2}` }));
                return [{ ...x, label: x.label || `${stem} 1` }, ...copies];
            });
        const assembly = { ...s.assembly, tree: dup(s.assembly.tree) };
        return { assembly: { ...assembly, sbom: syncSbomFromAssembly({ ...s, assembly }) } };
    }),

    removeFromAssembly: (asmNodeId) => set(s => {
        const removeNode = (nodes: AssemblyNode[]): AssemblyNode[] =>
            nodes
                .filter(n => n.id !== asmNodeId)
                .map(n => ({ ...n, children: removeNode(n.children) }));
        const assembly = { ...s.assembly, tree: removeNode(s.assembly.tree) };
        return { assembly: { ...assembly, sbom: syncSbomFromAssembly({ ...s, assembly }) } };
    }),

    updateAssemblyMeta: (updates) => set(s => ({
        assembly: { ...s.assembly, ...updates },
    })),
    updateAssemblySBOM: (sbom) => set(s => ({
        assembly: { ...s.assembly, sbom }
    })),
    overrideSbomRow: (rowId, overrides) => set(s => {
        const sbom = s.assembly.sbom.map(r => {
            if (r.id !== rowId) return r;
            const { overrides: _old, ...rest } = r;
            return overrides && Object.keys(overrides).length ? { ...rest, overrides } : rest;
        });
        const assembly = { ...s.assembly, sbom };
        return { assembly: { ...assembly, sbom: syncSbomFromAssembly({ ...s, assembly }) } };
    }),
    removeSbomPart: (rowId) => set(s => {
        const row = s.assembly.sbom.find(r => r.id === rowId);
        if (!row?.sourcePartId) return {};
        const removed = [...(s.assembly.sbomRemoved || []), { partId: row.sourcePartId, label: row.hardware || row.supplierCode || 'Part' }];
        const assembly = { ...s.assembly, sbomRemoved: removed };
        return { assembly: { ...assembly, sbom: syncSbomFromAssembly({ ...s, assembly }) } };
    }),
    restoreSbomPart: (partId) => set(s => {
        const assembly = { ...s.assembly, sbomRemoved: (s.assembly.sbomRemoved || []).filter(r => r.partId !== partId) };
        return { assembly: { ...assembly, sbom: syncSbomFromAssembly({ ...s, assembly }) } };
    }),
    updateNetworkTopology: (nodes, edges) => set(s => ({
        assembly: { ...s.assembly, networkNodes: nodes, networkEdges: edges }
    })),

    // ─── Navigation & UI ────────────────────────────────
    selectNode: (id) => set({ selectedNodeId: id, selectedTab: 'info', focusItem: null }),
    setTab: (tab) => set({ selectedTab: tab }),
    toggleSidebar: () => set(s => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    setSearchQuery: (q) => set({ searchQuery: q }),
    setCategoryFilter: (c) => set({ categoryFilter: c }),
    setActiveUser: (name) => {
        if (typeof window !== 'undefined') localStorage.setItem('ama_user', name);
        set({ activeUser: name });
    },
    setArchTab: (tab) => set({ archTab: tab }),

    // ─── Persistence ────────────────────────────────────
    // Everything that enters from a file / autosave passes through
    // normalizeProjectData: shapes guaranteed, no demo data injected.
    loadProject: (data) => {
        set({
            ...normalizeProjectData(data),
            workspaceKind: data?.kind === 'codebase' ? 'codebase' : 'machine',
            codebase: data?.codebase && typeof data.codebase === 'object' ? data.codebase : null,
            selectedNodeId: null,
            selectedTab: 'info',
            workspaceLoaded: true,
        });
    },
    setCodebase: (info) => set({ codebase: info }),
    // Two workspaces live side by side: flipping the mode parks the current
    // one in memory and restores the other (or starts it empty).
    switchWorkspaceKind: (kind) => {
        const s = get();
        if (s.workspaceKind === kind) return;
        const here = {
            library: s.library, units: s.units, equipmentModules: s.equipmentModules,
            controlModules: s.controlModules, assembly: s.assembly,
            projectFilePath: s.projectFilePath, codebase: s.codebase, workspaceLoaded: s.workspaceLoaded,
        };
        const there = s.parked[kind] || {
            library: [], units: [], equipmentModules: [], controlModules: [],
            assembly: emptyAssembly(kind === 'codebase' ? 'New Code Base' : 'New Machine',
                kind === 'codebase' ? 'Reusable ISA-88 code base.' : 'Machine assembled from a code base.'),
            projectFilePath: null, codebase: null, workspaceLoaded: true,
        };
        set({
            ...there,
            workspaceKind: kind,
            parked: { ...s.parked, [s.workspaceKind]: here },
            selectedNodeId: null,
            selectedTab: 'info',
        });
    },
    loadArchitecture: (data) => {
        set({
            ...normalizeEntityListsOnly(data),
            selectedNodeId: null,
            workspaceLoaded: true,
        });
    },
    resetToDefaults: () => {
        set({
            ...normalizeProjectData({
                library: defaultLibraryFBs,
                units: defaultUnits,
                equipmentModules: defaultEMs,
                controlModules: defaultCMs,
                assembly: defaultAssembly,
            }),
            selectedNodeId: null,
            selectedTab: 'info',
            workspaceLoaded: true,
        });
    },
    clearWorkspace: () => {
        set({
            library: [],
            units: [],
            equipmentModules: [],
            controlModules: [],
            assembly: emptyAssembly(),
            selectedNodeId: null,
            selectedTab: 'info',
            workspaceLoaded: false,
            projectFilePath: null,
            codebase: null,
        });
    },

    // ─── Helper ─────────────────────────────────────────
    findEntityById: (id) => {
        const s = get();
        return s.library.find(e => e.id === id)
            || s.units.find(e => e.id === id)
            || s.equipmentModules.find(e => e.id === id)
            || s.controlModules.find(e => e.id === id)
            || null;
    },
    };
});
