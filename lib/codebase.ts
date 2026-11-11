// ============================================================
// AMA — Code base
//
// The code base is the reusable library: ISA-88 blocks (UN, EM, CM, FB)
// with code, variables, alarms, I/O, DFMEA and components. It lives in
// its own folder, meant to be a Git repository on the company server or
// the customer PC, wherever the user points to:
//
//   codebase.json                  name, version, description
//   units/<name>.json              one entity per file (stable key order:
//   equipment-modules/<name>.json  clean diffs)
//   control-modules/<name>.json
//   function-blocks/<name>.json
//
// A machine project takes a SNAPSHOT of the code base (so it keeps
// working offline and exports deterministically) and can later be
// refreshed from it.
// ============================================================
import type { BlockBase, CodebaseInfo, EntityLevel, FunctionBlock, Unit, EquipmentModule, ControlModule } from '../types/machine';
import { safeFileName } from './helpers';
import { normalizeEntityListsOnly } from './normalize';

export const CODEBASE_FORMAT = 1;

export const CODEBASE_DIRS: Record<EntityLevel, string> = {
    UN: 'units',
    EM: 'equipment-modules',
    CM: 'control-modules',
    FB: 'function-blocks',
};

/** Older layout (the Git tab's export): still readable, so existing repositories open too. */
export const LEGACY_DIRS: Record<string, string> = {
    'software_library/function_blocks': 'library',
    'physical_hierarchy/units': 'units',
    'physical_hierarchy/equipment_modules': 'equipmentModules',
    'physical_hierarchy/control_modules': 'controlModules',
};

export interface EntityLists {
    library: FunctionBlock[];
    units: Unit[];
    equipmentModules: EquipmentModule[];
    controlModules: ControlModule[];
}

const ipc = (): any => (window as any).amaIpc ?? null;

/** JSON with sorted object keys (arrays keep their order): stable, diff-friendly files. */
export function stableStringify(v: any): string {
    const sort = (x: any): any => {
        if (Array.isArray(x)) return x.map(sort);
        if (x && typeof x === 'object') {
            const o: Record<string, any> = {};
            for (const k of Object.keys(x).sort()) if (x[k] !== undefined) o[k] = sort(x[k]);
            return o;
        }
        return x;
    };
    return JSON.stringify(sort(v), null, 2) + '\n';
}

const allEntities = (l: EntityLists): BlockBase[] =>
    [...l.units, ...l.equipmentModules, ...l.controlModules, ...l.library];

/** The files of a code base, plus the folders whose stale files must be cleaned first. */
export function buildCodebaseFiles(info: CodebaseInfo, lists: EntityLists): { files: Record<string, string>; cleanDirs: string[] } {
    const files: Record<string, string> = {};
    files['codebase.json'] = stableStringify({
        kind: 'codebase', format: CODEBASE_FORMAT,
        name: info.name, version: info.version, description: info.description,
    });
    const used = new Set<string>();
    for (const e of allEntities(lists)) {
        const dir = CODEBASE_DIRS[e.level];
        let base = safeFileName(e.name) || e.id;
        if (used.has(`${dir}/${base}`)) base = `${base}_${e.id.slice(0, 6)}`;
        used.add(`${dir}/${base}`);
        files[`${dir}/${base}.json`] = stableStringify(e);
    }
    return { files, cleanDirs: Object.values(CODEBASE_DIRS) };
}

export interface ParsedCodebase {
    info: Omit<CodebaseInfo, 'path'>;
    lists: EntityLists;
    errors: string[];
    /** How many block files were found (0 = the folder has no code base in it). */
    recognized: number;
}

export function parseCodebaseFiles(files: Record<string, string>): ParsedCodebase {
    const errors: string[] = [];
    let meta: any = {};
    try { meta = JSON.parse(files['codebase.json'] || '{}'); } catch { errors.push('codebase.json is not valid JSON.'); }
    const raw: Record<string, any[]> = { library: [], units: [], equipmentModules: [], controlModules: [] };
    const target: Record<string, string> = {
        'function-blocks': 'library', 'units': 'units',
        'equipment-modules': 'equipmentModules', 'control-modules': 'controlModules',
        ...LEGACY_DIRS,
    };
    let recognized = 0;
    for (const [rel, text] of Object.entries(files)) {
        const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        if (!target[dir] || !rel.endsWith('.json')) continue;
        try { raw[target[dir]].push(JSON.parse(text)); recognized++; } catch { errors.push(`${rel} is not valid JSON.`); }
    }
    for (const k of Object.keys(raw)) raw[k].sort((a, b) => String(a?.name).localeCompare(String(b?.name)));
    return {
        info: {
            name: String(meta.name || 'Code base'),
            version: String(meta.version || '1.0.0'),
            description: String(meta.description || ''),
        },
        lists: normalizeEntityListsOnly(raw) as EntityLists,
        errors,
        recognized,
    };
}

/** Pick a folder and read the code base in it. Null when canceled. */
export async function openCodebaseFolder(): Promise<{ path: string; parsed: ParsedCodebase } | null> {
    const r = ipc();
    if (!r) throw new Error('Opening a code base is only available in the desktop app.');
    const picked = await r.invoke('ama:pick-folder');
    if (!picked?.dir) return null;
    return { path: picked.dir, parsed: await readCodebaseFolder(picked.dir) };
}

export async function readCodebaseFolder(dir: string): Promise<ParsedCodebase> {
    const r = ipc();
    if (!r) throw new Error('Only available in the desktop app.');
    const res = await r.invoke('ama:read-folder', { dir, subdirs: [...Object.values(CODEBASE_DIRS), ...Object.keys(LEGACY_DIRS)] });
    if (!res?.ok) throw new Error(res?.error || 'Unable to read the folder.');
    return parseCodebaseFiles(res.files);
}

export async function writeCodebaseFolder(dir: string, info: CodebaseInfo, lists: EntityLists): Promise<number> {
    const r = ipc();
    if (!r) throw new Error('Only available in the desktop app.');
    const { files, cleanDirs } = buildCodebaseFiles(info, lists);
    const res = await r.invoke('ama:write-folder', { dir, files, cleanDirs });
    if (!res?.ok) throw new Error(res?.error || 'Unable to write the folder.');
    return res.count;
}

export async function pickCodebaseFolderForSave(): Promise<string | null> {
    const r = ipc();
    if (!r) throw new Error('Only available in the desktop app.');
    const picked = await r.invoke('ama:pick-folder');
    return picked?.dir || null;
}

export interface ListsDiff { added: string[]; removed: string[]; changed: string[] }

/** What a refresh from the code base would change, by entity name. */
export function diffLists(prev: EntityLists, next: EntityLists): ListsDiff {
    const index = (l: EntityLists) => new Map(allEntities(l).map(e => [e.id, e] as const));
    const a = index(prev), b = index(next);
    const out: ListsDiff = { added: [], removed: [], changed: [] };
    for (const [id, e] of b) {
        const old = a.get(id);
        if (!old) out.added.push(e.name);
        else if (stableStringify(old) !== stableStringify(e)) out.changed.push(e.name);
    }
    for (const [id, e] of a) if (!b.has(id)) out.removed.push(e.name);
    return out;
}

/** Entities a machine may use: Released ones. */
export const isReleased = (e: BlockBase): boolean => e.status === 'Released';

export function statusCounts(lists: EntityLists): Record<string, number> {
    const out: Record<string, number> = { Draft: 0, 'In Review': 0, Released: 0, Deprecated: 0 };
    for (const e of allEntities(lists)) out[e.status || 'Draft'] = (out[e.status || 'Draft'] || 0) + 1;
    return out;
}
