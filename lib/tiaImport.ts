// ============================================================
// AMA — Import from TIA Portal
//
// Input: the files of a TIA export folder (path -> text). The folder is
// written by tools/tia-extractor (TIA Openness), but any folder of
// SimaticML exports works (blocks, PLC tag tables, PLC data types).
//
//   program folders  -> Units / Equipment Modules / Control Modules
//                       (Unit_*, EM_*, CM_* names decide the level)
//   OB / FC          -> the code of the entity that owns the folder; their interface
//                       (inputs, outputs, temporaries) -> variables "<block>.<name>"
//   FB               -> Function Block in the library (interface + code)
//   global DB        -> variables of its entity (every member, structs flattened)
//   instance DB      -> one variable typed with its FB
//   PLC tags         -> I/O signals (%I / %Q) and variables (%M), given to the
//                       entity whose code uses them most
//   Bool Alm_/Err_/Wrn_/Flt_ members and tags -> alarms
//   PLC data types   -> library entries marked [UDT]
//   hardware.json    -> SBOM and network topology
//
// Nothing is dropped silently: what cannot be read is listed in `warnings`.
// ============================================================
import type {
    FunctionBlock, Unit, EquipmentModule, ControlModule, AssemblyProject, AssemblyNode,
    Variable, Alarm, IOSignal, HardwareItem, BlockBase, DataType, AlarmLevel, VariableScope,
} from '../types/machine';
import { createEmptyBlock, generateId } from './helpers';
import { parseXml, kid, kids, find, findAll, mlText, renderScl, renderFlgNet, type XNode } from './tiaXml';

export interface TiaImportResult {
    project: {
        library: FunctionBlock[];
        units: Unit[];
        equipmentModules: EquipmentModule[];
        controlModules: ControlModule[];
        assembly: AssemblyProject;
    };
    stats: {
        plcs: number; blocks: number; codeBlocks: number; fbs: number; dbs: number; udts: number;
        variables: number; tags: number; io: number; alarms: number; networks: number; devices: number;
    };
    warnings: string[];
}

// ─── data types ────────────────────────────────────────────
const SIMPLE: Record<string, DataType> = {
    bool: 'BOOL', int: 'INT', sint: 'INT', usint: 'INT', uint: 'UINT', dint: 'DINT', udint: 'DINT', lint: 'DINT', ulint: 'DINT',
    real: 'REAL', lreal: 'LREAL', string: 'STRING', wstring: 'STRING', char: 'STRING', wchar: 'STRING',
    time: 'TIME', ltime: 'TIME', s5time: 'TIME', word: 'WORD', dword: 'DWORD', lword: 'DWORD',
};
function mapType(raw: string): { dataType: DataType; customDataType?: string } {
    const t = (raw || '').trim();
    const bare = t.replace(/^"|"$/g, '');
    const simple = SIMPLE[bare.toLowerCase().replace(/\[.*$/, '')];
    if (/^array\s*\[/i.test(bare)) return { dataType: 'ARRAY OF', customDataType: bare };
    if (simple) return /\[/.test(bare) ? { dataType: simple, customDataType: bare } : { dataType: simple };
    return { dataType: 'Other', customDataType: bare || 'Unknown' };
}

// ─── interface (block / DB / UDT members) ──────────────────
interface Member { name: string; type: string; comment: string; start: string; children: Member[] }
interface Section { name: string; members: Member[] }

function memberOf(m: XNode): Member {
    const comment = (findAll(kid(m, 'Comment'), 'MultiLanguageText').map(x => x.text.trim()).filter(Boolean)[0]) || '';
    const nested = [...kids(m, 'Member'), ...kids(kid(m, 'Sections'), 'Section').flatMap(s => kids(s, 'Member'))];
    return {
        name: m.attrs.Name || '', type: m.attrs.Datatype || '', comment,
        start: kid(m, 'StartValue')?.text.trim() || '', children: nested.map(memberOf),
    };
}
function sectionsOf(owner: XNode | undefined): Section[] {
    const sec = find(kid(kid(owner, 'AttributeList'), 'Interface'), 'Sections');
    return kids(sec, 'Section').map(s => ({ name: s.attrs.Name || '', members: kids(s, 'Member').map(memberOf) }));
}
/** Struct members become "parent.child" rows; the struct itself is kept only when it is a UDT / FB instance. */
function flatten(members: Member[], prefix = ''): Member[] {
    const out: Member[] = [];
    for (const m of members) {
        const name = prefix + m.name;
        if (/^struct$/i.test(m.type) && m.children.length) out.push(...flatten(m.children, name + '.'));
        else out.push({ ...m, name, children: [] });
    }
    return out;
}
const SCOPE: Record<string, VariableScope> = { Input: 'Input', Output: 'Output', InOut: 'InOut' };
const declare = (sections: Section[]): string => {
    const KW: Record<string, string> = { Input: 'VAR_INPUT', Output: 'VAR_OUTPUT', InOut: 'VAR_IN_OUT', Static: 'VAR', Temp: 'VAR_TEMP', Constant: 'VAR CONSTANT' };
    const out: string[] = [];
    for (const s of sections) {
        if (!KW[s.name] || !s.members.length) continue;
        out.push(KW[s.name]);
        for (const m of flatten(s.members)) out.push(`    ${m.name} : ${m.type}${m.start ? ` := ${m.start}` : ''};${m.comment ? `   // ${m.comment}` : ''}`);
        out.push('END_VAR');
    }
    return out.join('\n');
};

// ─── alarms ────────────────────────────────────────────────
const ALARM_RE = /^(alm|alarm|al|wrn|warn|warning|flt|fault|err|error)[_\d A-Z]/;
const isAlarmName = (n: string): boolean => ALARM_RE.test(n.replace(/^.*\./, '')) || /^(alm|alarm|wrn|warn|warning|flt|fault|err|error)[_\d]/i.test(n.replace(/^.*\./, ''));
const levelOf = (n: string): AlarmLevel =>
    /safety|estop|e_stop|emerg/i.test(n) ? 'Safety'
        : /(^|\.)(wrn|warn)/i.test(n) ? 'Warning'
            : /(^|\.)(flt|fault)/i.test(n) ? 'Fault' : 'Alarm';
const humanize = (n: string): string => n.replace(/^.*\./, '').replace(/^(alm|alarm|al|wrn|warn|warning|flt|fault|err|error)_?/i, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim() || n;

// ─── parsed documents ──────────────────────────────────────
interface Block {
    kind: 'OB' | 'FC' | 'FB' | 'GlobalDB' | 'InstanceDB' | 'ArrayDB';
    name: string; folders: string[]; lang: string; number: string; comment: string;
    sections: Section[]; code: string; networks: number; instanceOf: string;
}
interface Tag { name: string; type: string; address: string; comment: string; table: string }
interface Udt { name: string; comment: string; members: Member[] }
interface PlcData { name: string; blocks: Block[]; tags: Tag[]; udts: Udt[] }

function readBlock(el: XNode, folders: string[], warnings: string[]): Block {
    const al = kid(el, 'AttributeList');
    const name = kid(al, 'Name')?.text || 'Unnamed';
    const kind = el.tag.replace('SW.Blocks.', '') as Block['kind'];
    const lang = kid(al, 'ProgrammingLanguage')?.text || '';
    const parts: string[] = [];
    let networks = 0;
    for (const cu of kids(kid(el, 'ObjectList'), 'SW.Blocks.CompileUnit')) {
        networks++;
        const cal = kid(cu, 'AttributeList');
        const src = kid(cal, 'NetworkSource');
        const title = mlText(cu, 'Title');
        const comment = mlText(cu, 'Comment');
        const cuLang = kid(cal, 'ProgrammingLanguage')?.text || lang;
        let body = '';
        try {
            const st = kid(src, 'StructuredText');
            const flg = kid(src, 'FlgNet');
            if (st) body = renderScl(st);
            else if (flg) body = renderFlgNet(flg);
            else if (src && src.children.length) {
                body = `// ${cuLang} network: not converted, see the block in TIA Portal`;
                warnings.push(`${name}: a ${cuLang} network could not be converted to text.`);
            }
        } catch (e: any) {
            body = `// network not converted: ${e?.message || e}`;
            warnings.push(`${name}: network ${networks} could not be converted (${e?.message || e}).`);
        }
        const single = cuLang === 'SCL' && lang === 'SCL';
        const head = single && !title ? '' : `// --- Network ${networks}${title ? `: ${title}` : ''}${cuLang !== 'SCL' ? ` (${cuLang})` : ''}`;
        parts.push([head, comment ? comment.split('\n').map(l => `// ${l}`).join('\n') : '', body].filter(Boolean).join('\n'));
    }
    return {
        kind, name, folders, lang, number: kid(al, 'Number')?.text || '', comment: mlText(el, 'Comment'),
        sections: sectionsOf(el), code: parts.filter(Boolean).join('\n\n'), networks,
        instanceOf: kid(al, 'InstanceOfName')?.text || '',
    };
}

function readTagTable(el: XNode): Tag[] {
    const table = kid(kid(el, 'AttributeList'), 'Name')?.text || '';
    return kids(kid(el, 'ObjectList'), 'SW.Tags.PlcTag').map(t => {
        const al = kid(t, 'AttributeList');
        return {
            name: kid(al, 'Name')?.text || '', type: kid(al, 'DataTypeName')?.text || '',
            address: kid(al, 'LogicalAddress')?.text || '', comment: mlText(t, 'Comment'), table,
        };
    }).filter(t => t.name);
}

// ─── hardware ──────────────────────────────────────────────
const orderNo = (type: string): { code: string; fw: string } => {
    const m = /^OrderNumber:([^/]+)(?:\/(.*))?$/.exec(type || '');
    return m ? { code: m[1].trim(), fw: (m[2] || '').replace(/^-$/, '') } : { code: '', fw: '' };
};
function importHardware(json: string, warnings: string[]): { sbom: HardwareItem[]; nodes: any[]; edges: any[]; devices: number } {
    const sbom: HardwareItem[] = []; const nodes: any[] = []; const edges: any[] = [];
    let data: any;
    try { data = JSON.parse(json); } catch { warnings.push('hardware.json is not valid JSON: hardware not imported.'); return { sbom, nodes, edges, devices: 0 }; }
    const devices: any[] = Array.isArray(data?.devices) ? data.devices : [];
    const modules = new Map<string, HardwareItem>();
    let plcNode = '';
    devices.forEach((dev, i) => {
        const items: any[] = dev.items || [];
        const withOrder = items.map(it => ({ it, ...orderNo(it.type) })).filter(x => x.code);
        const head = withOrder.find(x => /CPU|HM/i.test(x.it.classification)) || withOrder.find(x => !/^6ES7 59\d/.test(x.code)) || withOrder[0];
        const gsd = items.map(it => /^GSD:([^/]+)/.exec(it.type || '')?.[1]).find(Boolean);
        const node = items.flatMap(it => it.nodes || []).find((n: any) => n.ip);
        const isCpu = !!withOrder.find(x => /CPU/i.test(x.it.classification));
        const isNet = /^6GK5/.test(head?.code || '') || /scalance|switch/i.test(dev.name || '');
        const isHmi = /^6AV/.test(head?.code || '');
        const row: HardwareItem = {
            id: generateId(), type: isNet ? 'Network' : 'Hardware',
            hardware: `${dev.name}${head ? ` (${head.code})` : gsd ? ` (${gsd.replace(/^GSDML-V[\d.]+-/i, '').replace(/-\d{8}\.xml$/i, '')})` : ''}`,
            firmware: head?.fw || '', quantity: 1,
            notes: isCpu ? 'PLC' : isHmi ? 'HMI panel' : (node?.pnName ? `PROFINET name: ${node.pnName}` : ''),
            ipAddress: node?.ip || '', supplierCode: head?.code || '', manufacturer: head ? 'Siemens' : '',
        };
        sbom.push(row);
        // the other modules of the station (I/O cards, power modules...) are grouped by order number
        for (const x of withOrder) {
            if (x === head || x.it.depth > 0 && orderNo(x.it.type).code === head?.code) continue;
            const g = modules.get(x.code) || { id: generateId(), type: 'Hardware' as const, hardware: x.code, firmware: x.fw, quantity: 0, notes: '', supplierCode: x.code, manufacturer: 'Siemens' };
            g.quantity++;
            g.notes = [...new Set([...(g.notes ? g.notes.split(', ') : []), `${dev.name}: ${x.it.name}`])].join(', ');
            modules.set(x.code, g);
        }
        if (node?.ip) {
            const id = `node-${i}`;
            if (isCpu && !plcNode) plcNode = id;
            nodes.push({
                id, sbomId: row.id, x: isCpu ? 520 : 100 + (nodes.length % 5) * 210, y: isCpu ? 60 : 240 + Math.floor(nodes.length / 5) * 150,
                label: dev.name, ip: node.ip, type: row.type, note: row.notes, mask: node.mask, subnet: node.subnet,
            });
        }
    });
    sbom.push(...modules.values());
    const hub = nodes.find(n => n.type === 'Network')?.id || plcNode || nodes[0]?.id;
    for (const n of nodes) {
        if (n.id === hub) continue;
        edges.push({
            id: `edge-${n.id}-${hub}`, source: n.id, target: hub, protocol: 'PROFINET', sourcePort: '', targetPort: '',
            subnetMask: n.mask || '255.255.255.0', gateway: '', isEncrypted: false, isFirewalled: false,
        });
    }
    for (const n of nodes) { delete n.mask; delete n.subnet; }
    if (edges.length) warnings.push('Topology: links inferred (every device to the switch or the PLC): please verify.');
    return { sbom, nodes, edges, devices: devices.length };
}

// ─── main ──────────────────────────────────────────────────
const levelOfFolder = (n: string): 'UN' | 'EM' | 'CM' | null =>
    /^(un|unit)[_\- ]/i.test(n) ? 'UN' : /^em[_\- ]/i.test(n) ? 'EM' : /^cm[_\- ]/i.test(n) ? 'CM' : null;
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';

export function importTia(files: Record<string, string>, sourceName = 'TIA Portal', author = 'TIA Portal'): TiaImportResult {
    const warnings: string[] = [];
    const stats = { plcs: 0, blocks: 0, codeBlocks: 0, fbs: 0, dbs: 0, udts: 0, variables: 0, tags: 0, io: 0, alarms: 0, networks: 0, devices: 0 };
    const today = new Date().toISOString().split('T')[0];

    // ---- read every file ----
    const plcs = new Map<string, PlcData>();
    const plcOf = (name: string): PlcData => {
        if (!plcs.has(name)) plcs.set(name, { name, blocks: [], tags: [], udts: [] });
        return plcs.get(name)!;
    };
    let hardwareJson = ''; let projectName = '';
    for (const [rawPath, text] of Object.entries(files)) {
        const path = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
        const base = path.split('/').pop() || '';
        if (/^hardware\.json$/i.test(base)) { hardwareJson = text; continue; }
        if (/^manifest\.json$/i.test(base)) {
            try {
                const mf = JSON.parse(text);
                projectName = mf.project || '';
                for (const e of mf.errors || []) warnings.push(`Not exported by TIA Portal: ${e}`);
            } catch { /* optional */ }
            continue;
        }
        if (!/\.xml$/i.test(base)) continue;
        let doc: XNode;
        try { doc = parseXml(text); } catch { warnings.push(`${path}: not a readable XML file, skipped.`); continue; }
        const root = kid(doc, 'Document');
        const el = kids(root).find(c => c.tag.startsWith('SW.'));
        if (!el) continue;
        const segs = path.split('/').slice(0, -1);
        const k = segs.findIndex(s => /^(blocks|tags|types)$/i.test(s));
        const plc = plcOf(k > 0 ? segs[k - 1] : 'PLC');
        const folders = k >= 0 ? segs.slice(k + 1) : segs;
        try {
            if (el.tag.startsWith('SW.Blocks.')) plc.blocks.push(readBlock(el, folders, warnings));
            else if (el.tag === 'SW.Tags.PlcTagTable') plc.tags.push(...readTagTable(el));
            else if (el.tag === 'SW.Types.PlcStruct') {
                plc.udts.push({
                    name: kid(kid(el, 'AttributeList'), 'Name')?.text || base.replace(/\.xml$/i, ''),
                    comment: mlText(el, 'Comment'), members: sectionsOf(el).flatMap(s => s.members),
                });
            }
        } catch (e: any) { warnings.push(`${path}: could not be read (${e?.message || e}).`); }
    }
    if (![...plcs.values()].some(p => p.blocks.length || p.tags.length)) {
        throw new Error('No TIA Portal export found in this folder: it must contain the XML files of the blocks and PLC tags.');
    }

    const usedIds = new Set<string>();
    const idFor = (prefix: string, name: string): string => {
        let id = `${prefix}-${slug(name)}`, i = 2;
        while (usedIds.has(id)) id = `${prefix}-${slug(name)}-${i++}`;
        usedIds.add(id);
        return id;
    };
    const make = <T extends BlockBase>(level: 'UN' | 'EM' | 'CM' | 'FB', prefix: string, name: string, description: string): T => {
        const e: any = createEmptyBlock(level, name, author);
        e.id = idFor(prefix, name);
        e.description = description;
        e.revisions = [{ version: '1.0', date: today, author, notes: `Imported from ${sourceName}` }];
        return e as T;
    };

    const library: FunctionBlock[] = []; const units: Unit[] = [];
    const equipmentModules: EquipmentModule[] = []; const controlModules: ControlModule[] = [];
    const tree: AssemblyNode[] = [];

    for (const plc of plcs.values()) {
        stats.plcs++;
        stats.blocks += plc.blocks.length;
        const multi = plcs.size > 1;

        // ---- FBs and UDTs -> library ----
        const fbByName = new Map<string, FunctionBlock>();
        for (const b of plc.blocks.filter(x => x.kind === 'FB')) {
            const fb = make<FunctionBlock>('FB', 'fb', b.name, b.comment || `Function block ${b.name} (${b.lang})`);
            for (const s of b.sections) {
                for (const m of flatten(s.members)) {
                    const t = mapType(m.type);
                    fb.variables.push({ id: generateId(), name: m.name, description: m.comment, ...t, scope: SCOPE[s.name] || 'Local' });
                }
            }
            fb.code = [`// FB "${b.name}" (${b.lang}), ${b.networks} network(s)`, b.code].filter(Boolean).join('\n');
            stats.fbs++; stats.codeBlocks++; stats.networks += b.networks; stats.variables += fb.variables.length;
            fbByName.set(b.name, fb);
            library.push(fb);
        }
        for (const u of plc.udts) {
            const fb = make<FunctionBlock>('FB', 'udt', u.name, `[UDT] ${u.comment}`.trim());
            for (const m of flatten(u.members)) fb.variables.push({ id: generateId(), name: m.name, description: m.comment, ...mapType(m.type), scope: 'Local' });
            stats.udts++; stats.variables += fb.variables.length;
            library.push(fb);
        }

        // ---- folders -> entities ----
        type Ent = { e: any; level: 'UN' | 'EM' | 'CM'; parent: Ent | null; children: Ent[]; code: string[] };
        const ents = new Map<string, Ent>();
        const add = (key: string, level: 'UN' | 'EM' | 'CM', name: string, description: string, parent: Ent | null): Ent => {
            const e = make<any>(level, level.toLowerCase(), name, description);
            const ent: Ent = { e, level, parent, children: [], code: [] };
            ents.set(key, ent);
            parent?.children.push(ent);
            (level === 'UN' ? units : level === 'EM' ? equipmentModules : controlModules).push(e);
            return ent;
        };
        let root: Ent | null = null;
        const rootUnit = (): Ent => root || (root = add('#root', 'UN', `UN_${multi ? plc.name : (projectName || plc.name)}`, `Main unit of ${projectName || plc.name}: blocks outside the Unit folders.`, null));
        const holders = new Map<string, Ent>();
        const holderEm = (unit: Ent, label: string, key: string): Ent => {
            if (!holders.has(key)) holders.set(key, add(`#em:${key}`, 'EM', label, 'Groups the control modules that are not inside an Equipment Module folder.', unit));
            return holders.get(key)!;
        };
        /** Entity that owns the blocks of a folder path (created on demand). */
        const entityFor = (folders: string[]): Ent => {
            if (!folders.length) return rootUnit();
            const key = folders.join('/');
            if (ents.has(key)) return ents.get(key)!;
            const name = folders[folders.length - 1];
            const own = levelOfFolder(name);
            // nearest ancestor that is an entity by name
            let up: Ent | null = null;
            for (let i = folders.length - 1; i > 0 && !up; i--) {
                if (levelOfFolder(folders[i - 1])) up = entityFor(folders.slice(0, i));
                else if (ents.has(folders.slice(0, i).join('/'))) up = ents.get(folders.slice(0, i).join('/'))!;
            }
            const where = `TIA folder: ${key}`;
            if (own === 'UN') return add(key, 'UN', name, where, null);
            const unitOf = (x: Ent | null): Ent => { let u = x; while (u && u.level !== 'UN') u = u.parent; return u || rootUnit(); };
            if (own === 'EM') return add(key, 'EM', name, where, unitOf(up));
            if (own === 'CM') {
                const em = up?.level === 'EM' ? up : holderEm(unitOf(up), folders.length > 1 && !levelOfFolder(folders[folders.length - 2]) ? folders[folders.length - 2] : `EM_${unitOf(up).e.name.replace(/^(UN|Unit)_/i, '')}_Modules`, folders.slice(0, -1).join('/') || '#');
                return add(key, 'CM', name, where, em);
            }
            // a folder with no ISA-88 prefix
            if (up?.level === 'CM') { ents.set(key, up); return up; }               // deeper than CM: same CM
            if (up?.level === 'EM') return add(key, 'CM', name, where, up);
            return add(key, 'EM', name, where, unitOf(up));
        };

        const dbOwner = new Map<string, Ent>();
        const sorted = [...plc.blocks].sort((a, b) => a.folders.join('/').localeCompare(b.folders.join('/')) || a.name.localeCompare(b.name, undefined, { numeric: true }));
        // folders that only hold other Unit folders (Area / Cell) do not become entities
        const holdsUnits = (folders: string[]): boolean => !levelOfFolder(folders[folders.length - 1] || '') && !folders.some(f => levelOfFolder(f))
            && sorted.some(b => b.folders.length > folders.length && folders.every((f, i) => b.folders[i] === f) && b.folders.slice(folders.length).some(f => levelOfFolder(f) === 'UN'));
        for (const b of sorted) {
            if (b.kind === 'FB') {
                const ent = b.folders.length && !holdsUnits(b.folders) ? entityFor(b.folders) : rootUnit();
                const fb = fbByName.get(b.name)!;
                ent.e.assignedFBs = [...new Set([...(ent.e.assignedFBs || []), fb.id])];
                continue;
            }
            const ent = b.folders.length && !holdsUnits(b.folders) ? entityFor(b.folders) : rootUnit();
            if (b.kind === 'OB' || b.kind === 'FC') {
                // the interface (inputs, outputs, temporaries) becomes variables "<block>.<name>", like DB members
                for (const s of b.sections) {
                    if (s.name === 'Return') continue;
                    for (const m of flatten(s.members)) {
                        ent.e.variables.push({
                            id: generateId(), name: `${b.name}.${m.name}`,
                            description: [m.comment, `${b.kind} ${b.name}, ${s.name}${m.start ? `, start value ${m.start}` : ''}`].filter(Boolean).join(' · '),
                            ...mapType(m.type), scope: SCOPE[s.name] || 'Local',
                        } as Variable);
                    }
                }
                ent.code.push([`// ===== ${b.kind} "${b.name}"${b.number ? ` [${b.kind}${b.number}]` : ''} (${b.lang}) =====`, b.comment ? `// ${b.comment}` : '', b.code].filter(Boolean).join('\n'));
                stats.codeBlocks++; stats.networks += b.networks;
            } else if (b.kind === 'InstanceDB') {
                stats.dbs++;
                const fb = fbByName.get(b.instanceOf);
                ent.e.variables.push({ id: generateId(), name: b.name, description: `Instance DB of ${b.instanceOf || 'a function block'}${b.comment ? `: ${b.comment}` : ''}`, dataType: 'Other', customDataType: b.instanceOf || 'FB', scope: 'Local' } as Variable);
                if (fb) ent.e.assignedFBs = [...new Set([...(ent.e.assignedFBs || []), fb.id])];
                dbOwner.set(b.name, ent);
            } else {
                stats.dbs++;
                dbOwner.set(b.name, ent);
                const alarmDb = /alm|alarm/i.test(b.name);
                for (const m of flatten(b.sections.flatMap(s => s.members))) {
                    const full = `${b.name}.${m.name}`;
                    const t = mapType(m.type);
                    ent.e.variables.push({ id: generateId(), name: full, description: m.comment, ...t, scope: 'Local' } as Variable);
                    if (t.dataType === 'BOOL' && (alarmDb || isAlarmName(m.name))) {
                        ent.e.alarms.push({
                            id: generateId(), alarmId: m.name.replace(/^.*\./, ''), message: m.comment || humanize(m.name), level: levelOf(m.name),
                            triggerVariable: `"${b.name}".${m.name}`, action: levelOf(m.name) === 'Warning' ? 'Log' : 'Stop', linkedModules: [],
                        } as Alarm);
                    }
                }
            }
        }
        for (const ent of new Set(ents.values())) ent.e.code = ent.code.join('\n\n');

        // ---- PLC tags -> I/O and variables, given to the entity that uses them most ----
        const all = [...new Set(ents.values())];
        const fbOwner = new Map<string, Ent>();
        for (const ent of all) for (const id of ent.e.assignedFBs || []) if (!fbOwner.has(id)) fbOwner.set(id, ent);
        const texts: { ent: Ent; text: string }[] = all.map(ent => ({ ent, text: ent.e.code as string }));
        for (const fb of fbByName.values()) { const o = fbOwner.get(fb.id); if (o) texts.push({ ent: o, text: fb.code }); }
        const count = (text: string, needle: string): number => { let n = 0, i = 0; while ((i = text.indexOf(needle, i)) >= 0) { n++; i += needle.length; } return n; };
        let unused = 0;
        for (const tag of plc.tags) {
            stats.tags++;
            const needle = `"${tag.name}"`;
            let best: Ent | null = null, bestN = 0;
            for (const t of texts) { const n = count(t.text, needle); if (n > bestN) { bestN = n; best = t.ent; } }
            if (!best) { unused++; best = rootUnit(); }
            const t = mapType(tag.type);
            const io = /^%([IQ])/i.exec(tag.address);
            const desc = [tag.comment, tag.table && tag.table !== 'Default tag table' ? `[${tag.table}]` : ''].filter(Boolean).join(' ');
            if (io) {
                const input = io[1].toUpperCase() === 'I';
                const bit = t.dataType === 'BOOL';
                best.e.io.push({
                    id: generateId(), signalId: tag.name, signalType: bit ? (input ? 'DI' : 'DO') : (input ? 'AI' : 'AO'),
                    address: tag.address, variable: tag.name, description: desc, ...t,
                } as IOSignal);
                stats.io++;
            } else {
                best.e.variables.push({ id: generateId(), name: tag.name, description: desc, ...t, scope: 'Local', address: tag.address || undefined } as Variable);
                if (t.dataType === 'BOOL' && isAlarmName(tag.name)) {
                    best.e.alarms.push({
                        id: generateId(), alarmId: tag.name, message: tag.comment || humanize(tag.name), level: levelOf(tag.name),
                        triggerVariable: `"${tag.name}"`, action: levelOf(tag.name) === 'Warning' ? 'Log' : 'Stop', linkedModules: [],
                    } as Alarm);
                }
            }
        }
        if (unused) warnings.push(`${unused} PLC tag(s) are not used by any block: kept in ${rootUnit().e.name}.`);

        // ---- assignments and assembly tree ----
        for (const ent of all) {
            stats.variables += ent.e.variables.length;
            stats.alarms += ent.e.alarms.length;
            if (ent.level === 'UN') ent.e.assignedEMs = ent.children.filter(c => c.level === 'EM').map(c => c.e.id);
            if (ent.level === 'EM') ent.e.assignedCMs = ent.children.filter(c => c.level === 'CM').map(c => c.e.id);
        }
        const nodeOf = (ent: Ent): AssemblyNode => ({
            id: generateId(), refId: ent.e.id, level: ent.level,
            children: [
                ...ent.children.map(nodeOf),
                ...((ent.e.assignedFBs || []) as string[]).map(id => ({ id: generateId(), refId: id, level: 'FB' as const, children: [] })),
            ],
        });
        tree.push(...all.filter(x => x.level === 'UN').map(nodeOf));
    }

    const hw = hardwareJson ? importHardware(hardwareJson, warnings) : { sbom: [], nodes: [], edges: [], devices: 0 };
    if (!hardwareJson) warnings.push('No hardware.json in the folder: SBOM and topology were not imported (use the AMA extractor to get them).');
    stats.devices = hw.devices;
    if (stats.udts) warnings.push(`${stats.udts} PLC data type(s) (UDT) saved in the library with the description "[UDT]" and their members as variables.`);
    if (stats.alarms) warnings.push('Alarms were recognised from Bool names (Alm_, Err_, Wrn_, Flt_) and from DBs named *Alm* / *Alarm*: review levels and messages.');
    else warnings.push('No alarm was recognised: this project has no Bool named Alm_/Err_/Wrn_/Flt_ and no alarm DB.');
    if (stats.networks) warnings.push('LAD/FBD networks were converted to Structured Text so the logic is readable in AMA: compare with TIA Portal before reusing it.');

    const name = projectName || [...plcs.keys()][0] || 'TIA project';
    return {
        project: {
            library, units, equipmentModules, controlModules,
            assembly: {
                id: generateId(), name, description: `Imported from ${sourceName}.`, version: '1.0.0',
                tree, sbom: hw.sbom, networkNodes: hw.nodes, networkEdges: hw.edges,
            },
        },
        stats, warnings,
    };
}
