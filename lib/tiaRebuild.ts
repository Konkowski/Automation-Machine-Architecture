// ============================================================
// AMA — Export to TIA Portal of blocks that were imported from TIA Portal
//
// Imported blocks carry their original TIA objects (SimaticML). Nothing is
// regenerated: the package holds those objects, the PLC tags and the stations,
// and tools/tia-rebuilder puts them back into a new TIA project.
//
// Only the blocks in the machine tree are exported. What they use but is not
// in the tree (a DB of another unit, a library FB, a data type, a tag) is
// added automatically, otherwise the project would not compile; the report
// says what was added.
// ============================================================
import type { AssemblyNode, AssemblyProject, BlockBase, TiaObject, TiaTag } from '../types/machine';
import type { EntityDB } from './helpers';
import PROGRAM_CS from '../tools/tia-rebuilder/Program.cs?raw';
import CSPROJ from '../tools/tia-rebuilder/TiaRebuilder.csproj?raw';
import RUN_ME from '../tools/tia-rebuilder/RUN_ME.bat?raw';

type FileMap = Record<string, string>;

const allEntities = (db: EntityDB): BlockBase[] => [...db.units, ...db.equipmentModules, ...db.controlModules, ...db.library];

/** Entities placed in the machine tree, plus the function blocks assigned to them. */
function entitiesInTree(assembly: AssemblyProject, db: EntityDB): BlockBase[] {
    const byId = new Map(allEntities(db).map(e => [e.id, e]));
    const ids = new Set<string>();
    const walk = (nodes: AssemblyNode[]) => {
        for (const n of nodes) {
            ids.add(n.refId);
            for (const fb of ((byId.get(n.refId) as any)?.assignedFBs || []) as string[]) ids.add(fb);
            walk(n.children);
        }
    };
    walk(assembly.tree);
    return [...ids].map(id => byId.get(id)).filter(Boolean) as BlockBase[];
}

/** True when the machine is made of blocks imported from TIA Portal. */
export function hasTiaOrigin(assembly: AssemblyProject, db: EntityDB): boolean {
    return entitiesInTree(assembly, db).some(e => (e.tia?.objects.length || 0) > 0);
}

/** Names an object refers to: block calls, DBs, data types, tags (a superset is fine). */
function referencedNames(xml: string): Set<string> {
    const out = new Set<string>();
    for (const m of xml.matchAll(/\bName="([^"]+)"/g)) out.add(m[1]);
    for (const m of xml.matchAll(/&quot;([^&]+)&quot;/g)) out.add(m[1]);
    for (const m of xml.matchAll(/<InstanceOfName>([^<]+)</g)) out.add(m[1]);
    return out;
}

const KIND_ORDER: Record<string, number> = { GlobalDB: 1, ArrayDB: 1, FB: 2, FC: 3, InstanceDB: 4, OB: 5 };
const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]+/g, '_');

export function buildTiaRebuildPackage(assembly: AssemblyProject, db: EntityDB): FileMap {
    const everything = allEntities(db);
    const inTree = entitiesInTree(assembly, db);
    const manual: string[] = [];

    // every object / tag known to the project, by name
    type Def = { owner: BlockBase; obj: TiaObject };
    const defs = new Map<string, Def>();
    const tagDefs = new Map<string, { owner: BlockBase; tag: TiaTag }>();
    for (const e of everything) {
        for (const obj of e.tia?.objects || []) if (!defs.has(obj.name)) defs.set(obj.name, { owner: e, obj });
        for (const tag of e.tia?.tags || []) if (!tagDefs.has(tag.name)) tagDefs.set(tag.name, { owner: e, tag });
    }

    // start from the tree, then follow the references
    const objects = new Map<string, Def>();
    const tags = new Map<string, { owner: BlockBase; tag: TiaTag }>();
    const queue: Def[] = [];
    const treeIds = new Set(inTree.map(e => e.id));
    for (const e of inTree) {
        for (const obj of e.tia?.objects || []) if (!objects.has(obj.name)) { objects.set(obj.name, { owner: e, obj }); queue.push({ owner: e, obj }); }
        for (const tag of e.tia?.tags || []) tags.set(tag.name, { owner: e, tag });
        if (!e.tia?.objects.length && e.level !== 'FB' && (e.code || '').trim()) manual.push(`${e.level} ${e.name} was written in AMA, not imported from TIA Portal: it is not in this package. Create it in TIA Portal by hand.`);
    }
    const addedBlocks: string[] = []; const addedTags: string[] = [];
    while (queue.length) {
        const cur = queue.pop()!;
        for (const name of referencedNames(cur.obj.xml)) {
            const d = defs.get(name);
            if (d && !objects.has(name)) {
                objects.set(name, d); queue.push(d);
                if (!treeIds.has(d.owner.id)) addedBlocks.push(`${d.obj.blockKind || 'data type'} ${name} (from ${d.owner.name})`);
            }
            const t = tagDefs.get(name);
            if (t && !tags.has(name)) { tags.set(name, t); if (!treeIds.has(t.owner.id)) addedTags.push(name); }
        }
    }
    if (addedBlocks.length) manual.push(`INFO: ${addedBlocks.length} object(s) were added because the assembled blocks use them: ${addedBlocks.join(', ')}.`);
    if (addedTags.length) manual.push(`INFO: ${addedTags.length} PLC tag(s) of blocks outside the tree were added because the assembled blocks use them.`);
    manual.push('INFO: the blocks are the original TIA Portal objects. Changes made to their code or variables inside AMA are not exported.');

    // data types first (those used by other data types before them), then blocks by kind
    const types = [...objects.values()].filter(d => d.obj.kind === 'type');
    const typeNames = new Set(types.map(t => t.obj.name));
    const orderedTypes: Def[] = []; const placed = new Set<string>();
    const place = (d: Def, depth = 0) => {
        if (placed.has(d.obj.name) || depth > 20) return;
        placed.add(d.obj.name);
        for (const n of referencedNames(d.obj.xml)) if (n !== d.obj.name && typeNames.has(n)) place(objects.get(n)!, depth + 1);
        orderedTypes.push(d);
    };
    types.forEach(t => place(t));
    const tech = [...objects.values()].filter(d => d.obj.kind === 'technology').sort((a, b) => a.obj.name.localeCompare(b.obj.name, undefined, { numeric: true }));
    const blocks = [...objects.values()].filter(d => d.obj.kind === 'block')
        .sort((a, b) => (KIND_ORDER[a.obj.blockKind || ''] || 9) - (KIND_ORDER[b.obj.blockKind || ''] || 9) || a.obj.name.localeCompare(b.obj.name, undefined, { numeric: true }));

    const files: FileMap = {};
    const imports: any[] = [];
    const languages = new Set<string>();
    let minVer = 0;
    let n = 0;
    for (const d of [...orderedTypes, ...tech, ...blocks]) {
        const file = `tia_xml/${d.obj.kind === 'type' ? 'types' : d.obj.kind === 'technology' ? 'technology' : 'blocks'}/${String(++n).padStart(3, '0')}_${safe(d.obj.name)}.xml`;
        files[file] = d.obj.xml;
        for (const m of d.obj.xml.matchAll(/<Culture>([^<]+)</g)) languages.add(m[1]);
        minVer = Math.max(minVer, parseInt(String(d.owner.tia?.version || '').replace(/\D/g, ''), 10) || 0);
        imports.push({ file, kind: d.obj.kind, blockKind: d.obj.blockKind || '', name: d.obj.name, folder: d.obj.folders.join('/'), plc: d.owner.tia?.plc || '' });
    }

    // stations exactly as they were; hardware added in AMA is listed for manual work
    const stations = (assembly.sbom || []).filter(h => h.tia).map(h => h.tia);
    for (const h of assembly.sbom || []) {
        if (!h.tia && !h.sourcePartId && (h.type || 'Hardware') === 'Hardware' && !/^6ES7/.test(h.supplierCode || '') && h.hardware) {
            manual.push(`Hardware "${h.hardware}" was added in AMA: add it to the project by hand.`);
        }
    }

    const project = (assembly.name || 'AMA_Project').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'AMA_Project';
    files['rebuild.json'] = JSON.stringify({
        project, sourceVersion: minVer ? `V${minVer}` : '', languages: [...languages].sort(), stations, manual,
        tags: [...tags.values()].map(t => ({ ...t.tag, plc: t.owner.tia?.plc || '' })).sort((a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name, undefined, { numeric: true })),
        imports,
    }, null, 1) + '\n';

    const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');
    files['TiaRebuilder/Program.cs'] = PROGRAM_CS;
    files['TiaRebuilder/TiaRebuilder.csproj'] = CSPROJ;
    files['RUN_ME.bat'] = crlf(RUN_ME).split('__MINVER__').join(String(minVer || 16));
    files['README.md'] = [
        `# ${project}: TIA Portal package`, '',
        'This package rebuilds a TIA Portal project from blocks that were imported from TIA Portal.',
        'The blocks are the original objects (LAD / FBD / SCL as they were), not generated code.', '',
        '## How to use', '',
        `1. PC with TIA Portal ${minVer ? `V${minVer} or newer` : ''} (Openness option) and the .NET SDK.`,
        '2. Double-click `RUN_ME.bat`. If TIA Portal asks whether to grant access to "TiaRebuilder", answer **Yes**.',
        '3. The project is created in `_TIA_Project`. Read `BuildReport.txt`: [OK] done, [MANUAL] to do by hand, [FAIL] failed.', '',
        '## What is inside', '',
        `- ${blocks.length} block(s), ${tech.length} technology object(s), ${orderedTypes.length} PLC data type(s), ${tags.size} PLC tag(s), ${stations.length} station(s).`,
        ...manual.map(m => `- ${m}`), '',
    ].join('\n');
    return files;
}
