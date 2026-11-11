// ============================================================
// AMA — TIA Portal export (via TIA Openness)
//
// Like the Studio 5000 L5X card, but for Siemens: generates a
// self-contained, deterministic TEXT package that builds the TIA
// project on the engineering PC (TIA has no single import file
// covering hardware + code, and Openness can only run where TIA
// Portal is installed):
//
//   sources/10_udt/*.udt        PLC data types (external sources)
//   sources/20_scl/<folder>/*.scl  complete block sources, build order
//   sources/30_db/*.db          instance DBs referenced by the OB
//   tags/Machine_IO.csv         PLC tag table (deterministic addresses)
//   hardware.json               devices (exact MLFB/FW/IP), rack slots,
//                               network, program folders, TOs, build order
//   TiaBuilder/                 C# console app (TIA Openness V21, with
//                               fallback probing) that builds everything
//   README.md                   prerequisites + what is automated vs manual
//
// READ-ONLY over the model — the L5X exporter is untouched.
// ============================================================
import type { AssemblyProject } from '../types/machine';
import type { EntityDB } from './helpers';
import {
    buildModel, sortedSbom, computeDevices, orderNumberOf, componentNameOf,
    type Model, type Block, type Dev, type FileMap,
} from './plcModel';

// ─── deterministic I/O address assignment ──────────────────
interface TagRow { name: string; dataType: string; address: string; comment: string; block: string }

/** DI -> %I0.0.., DO -> %Q0.0.., assigned in model/block order (stable). */
function assignTags(m: Model): { tags: TagRow[]; overflow: string[] } {
    const tags: TagRow[] = [];
    const overflow: string[] = [];
    let iByte = 0, iBit = 0, qByte = 0, qBit = 0;
    const seen = new Set<string>();
    for (const b of m.blocks) {
        const e = b.entity;
        if (!e) continue;
        for (const io of e.io || []) {
            const name = (io.variable || io.signalId || '').trim();
            if (!name || seen.has(name)) continue;
            seen.add(name);
            let address = '';
            if (io.signalType === 'DI') { address = `%I${iByte}.${iBit}`; if (++iBit > 7) { iBit = 0; iByte++; } }
            else if (io.signalType === 'DO') { address = `%Q${qByte}.${qBit}`; if (++qBit > 7) { qBit = 0; qByte++; } }
            else { overflow.push(`${name}: type ${io.signalType} not mapped automatically`); }
            tags.push({ name, dataType: 'Bool', address, comment: (io.description || '').replace(/\r?\n/g, ' ').trim(), block: b.name });
        }
    }
    return { tags, overflow };
}

// ─── UDT external sources ───────────────────────────────────
// The telegram structs get canonical, correct member types; other UDTs
// come from the model reconstruction.
const CANONICAL_UDTS: Record<string, [string, string, string][]> = {
    typeTelegram1In: [
        ['ZSW1', 'Word', 'Status word (Telegram 1)'],
        ['NIST_A', 'Int', 'Velocita attuale (N2, 16384 = 100%)'],
        ['Valid', 'Bool', 'Telegram validity (diagnostics)'],
        ['ConnectionFaulted', 'Bool', 'PROFINET connection in error (was :I.ConnectionFaulted) — TODO: link to the PN diagnostics'],
    ],
    typeTelegram1Out: [
        ['STW1', 'Word', 'Control word (Telegram 1)'],
        ['NSOLL_A', 'Int', 'Setpoint velocita (N2, 16384 = 100%)'],
    ],
};

function udtSource(name: string, members: [string, string, string][]): string {
    const L = [`TYPE "${name}"`, `VERSION : 0.1`, `   STRUCT`];
    for (const [n, t, c] of members) L.push(`      ${n} : ${t};${c ? `   // ${c}` : ''}`);
    L.push(`   END_STRUCT;`, ``, `END_TYPE`, ``);
    return L.join('\n');
}

// ─── OB / instance-DB sources ───────────────────────────────
function obSource(m: Model, ob: Block): string {
    const calls = m.calls.filter(c => c.fromId === ob.id);
    const L = [
        `ORGANIZATION_BLOCK "Main"`,
        `TITLE = Ciclo principale`,
        `{ S7_Optimized_Access := 'TRUE' }`,
        `VERSION : 0.1`,
        `BEGIN`,
        ...calls.map(c => {
            const tgt = m.blocks.find(x => x.id === c.toId)!;
            return `    "idb${tgt.name}"();   // [${c.id}]`;
        }),
        `END_ORGANIZATION_BLOCK`,
        ``,
    ];
    return L.join('\n');
}

/** Compilable FB skeleton from the model interface, used when a block has no
 *  complete source: the block (and its instance DB) still exist in TIA, so the
 *  parents that call it compile and nothing silently disappears. */
function stubSource(b: Block): string {
    // Logix-only types have no SCL twin: TIMER/COUNTER map to IEC instances,
    // the rest is kept as a comment so the skeleton always compiles
    const decl = (x: { name: string; type: string; description: string }, withComment: boolean): string => {
        const c = withComment && x.description ? `   // ${x.description.replace(/\s+/g, ' ')}` : '';
        if (/^(TIMER|FBD_TIMER)$/i.test(x.type)) return `   ${x.name} : TON_TIME;${c}`;
        if (/^COUNTER$/i.test(x.type)) return `   ${x.name} : CTU_INT;${c}`;
        if (/^(MODULE|MOTION_INSTRUCTION)$/i.test(x.type)) return `   // ${x.name} : ${x.type};   (Logix type that does not exist in SCL)`;
        return `   ${x.name} : ${x.type};${c}`;
    };
    const sect = (kw: string, ms: { name: string; type: string; description: string }[]) =>
        ms.length ? [`VAR_${kw}`, ...ms.map(x => decl(x, true)), `END_VAR`] : [];
    return [
        `FUNCTION_BLOCK "${b.name}"`,
        `{ S7_Optimized_Access := 'TRUE' }`,
        `VERSION : 0.1`,
        ...sect("INPUT", b.in), ...sect("OUTPUT", b.out), ...sect("IN_OUT", b.inout),
        ...(b.static.length ? [`VAR`, ...b.static.map(x => decl(x, false)), `END_VAR`] : []),
        `BEGIN`,
        `   // TODO: source not present in the AMA model - block generated as a skeleton`,
        `END_FUNCTION_BLOCK`,
        ``,
    ].join('\n');
}

function idbSource(fbName: string): string {
    return [
        `DATA_BLOCK "idb${fbName}"`,
        `{ S7_Optimized_Access := 'TRUE' }`,
        `VERSION : 0.1`,
        `"${fbName}"`,
        ``,
        `BEGIN`,
        ``,
        `END_DATA_BLOCK`,
        ``,
    ].join('\n');
}

// ─── the package ────────────────────────────────────────────
export function buildTiaPackage(assembly: AssemblyProject, db: EntityDB): FileMap {
    const m = buildModel(assembly, db);
    const sbom = sortedSbom(m);
    const devices: Dev[] = computeDevices(m, sbom);
    const nodes = (m.assembly.networkNodes || []) as any[];
    const edges = (m.assembly.networkEdges || []) as any[];
    const files: FileMap = {};
    const pad2 = (n: number) => String(n).padStart(2, '0');

    // ---- sources: UDTs ----
    const udtFiles: string[] = [];
    // which blocks/types each source must produce: the builder verifies them
    const sourceBlocks: { file: string; kind: string; names: string[] }[] = [];
    let u = 0;
    for (const udt of m.udts) {
        const members: [string, string, string][] = CANONICAL_UDTS[udt.name]
            || udt.members.map(x => [x.name, x.type, ''] as [string, string, string]);
        const rel = `sources/10_udt/${pad2(++u)}_${udt.name}.udt`;
        files[rel] = udtSource(udt.name, members);
        udtFiles.push(rel);
        sourceBlocks.push({ file: rel, kind: 'udt', names: [udt.name] });
    }

    // ---- tags (needed early: tag names influence the variable mapping) ----
    const { tags, overflow } = assignTags(m);
    const tagNames = new Set(tags.map(t => t.name));
    files['tags/Machine_IO.csv'] = ['Name,DataType,Address,Comment,Block',
        ...tags.map(t => [t.name, t.dataType, t.address, t.comment, t.block].map(x => `"${String(x).replace(/"/g, '""')}"`).join(','))
    ].join('\n') + '\n';

    // ---- hierarchical program folders (the machine structure, not levels):
    // one folder per UN, the EM folders inside it, the CM folders inside
    // those. Library FBs -> "Library"; OB1 stays at the root. Each folder
    // holds its block's source AND its instance DB (the local variables). ----
    const isStructural = (b: Block) => b.level === 'UN' || b.level === 'EM' || b.level === 'CM';
    const parentOf = new Map<string, string>();
    for (const c of m.calls) {
        const from = m.blocks.find(x => x.id === c.fromId);
        const to = m.blocks.find(x => x.id === c.toId);
        if (!from || !to || !isStructural(to) || from.level === 'FB') continue;
        if (!parentOf.has(to.id)) parentOf.set(to.id, from.id);
    }
    const pathOf = (b: Block): string => {
        if (b.type === 'OB') return '';
        if (b.level === 'FB') return 'Library';
        const segs = [b.name];
        let cur: Block = b;
        for (;;) {
            const pid = parentOf.get(cur.id);
            if (!pid) break;
            const p = m.blocks.find(x => x.id === pid)!;
            if (p.type === 'OB') break;
            segs.unshift(p.name);
            cur = p;
        }
        return segs.join('/');
    };

    // ---- pass 1: collect raw block sources ----
    const ordered: Block[] = [...m.folders].reverse().flatMap(f => f.blocks);
    const manualBlocks: string[] = [];
    const srcOf = new Map<string, string>();          // block id -> source text
    for (const b of ordered) {
        if (b.type === 'OB') { srcOf.set(b.id, obSource(m, b)); continue; }
        const src = (b.entity?.code || '').trim();
        if (!/FUNCTION_BLOCK/.test(src)) {
            manualBlocks.push(`${b.id} ${b.name}: no complete source in the model - generated a SKELETON (interface only), logic to be written`);
            srcOf.set(b.id, stubSource(b) + '\n');
            continue;
        }
        srcOf.set(b.id, src + '\n');
    }

    // declared names per source (all VAR sections) — used for shadow checks
    const declaredOf = (src: string): Set<string> => {
        const out = new Set<string>();
        for (const sec of src.matchAll(/^VAR(?:_INPUT|_OUTPUT|_IN_OUT|_TEMP)?\b[^\n]*\n([\s\S]*?)^END_VAR/gm)) {
            for (const line of sec[1].split(/\r?\n/)) {
                const dm = line.match(/^\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?:\{[^}]*\})?\s*:\s*[^;]+;/);
                if (dm) for (const n of dm[1].split(/\s*,\s*/)) out.add(n);
            }
        }
        return out;
    };

    // ---- pass 2: shared machine variables -> gDB_Machine global DB.
    // Variables declared in the UN but referenced by other blocks were
    // "not mapped" anywhere TIA could see: they become a global DB and every
    // bare reference is rewritten to "gDB_Machine".Name. UN declarations
    // that collide with PLC tag names are dropped (the tag table wins). ----
    const unBlock = ordered.find(b => b.level === 'UN' && srcOf.has(b.id));
    const gdbDecls: string[] = [];
    if (unBlock) {
        let unSrc = srcOf.get(unBlock.id)!;
        const varSec = unSrc.match(/^VAR\b[^\n]*\n([\s\S]*?)^END_VAR/m);
        if (varSec) {
            const otherSources = ordered.filter(b => b.id !== unBlock.id && srcOf.has(b.id)).map(b => srcOf.get(b.id)!);
            const othersJoined = otherSources.join('\n');
            const refRe = (n: string) => new RegExp(`(?<![\\w."#])${n}\\b`);
            const keptLines: string[] = [];
            const movedNames: string[] = [];
            const droppedTagNames: string[] = [];
            for (const line of varSec[1].split(/\r?\n/)) {
                const dm = line.match(/^\s+([A-Za-z_]\w*)\s*((?:\{[^}]*\})?\s*:\s*[^;]+;.*)$/);
                if (!dm) { if (line.trim()) keptLines.push(line); continue; }
                const name = dm[1];
                if (tagNames.has(name)) { droppedTagNames.push(name); continue; }         // PLC tag wins
                if (refRe(name).test(othersJoined)) { gdbDecls.push(`      ${name} ${dm[2]}`.replace(/;\s*(\/\/.*)?$/, (mm, cm2) => `;${cm2 ? '   ' + cm2 : ''}`)); movedNames.push(name); }
                else keptLines.push(line);
            }
            unSrc = unSrc.replace(varSec[0], `VAR\n${keptLines.join('\n')}\nEND_VAR`);
            srcOf.set(unBlock.id, unSrc);
            // rewrite every bare reference (in all sources) to the moved names
            for (const b of ordered) {
                let src = srcOf.get(b.id);
                if (!src) continue;
                const shadows = declaredOf(src);
                for (const n of movedNames) {
                    if (shadows.has(n)) continue;
                    src = src.replace(new RegExp(`(?<![\\w."#])${n}\\b`, 'g'), `"gDB_Machine".${n}`);
                }
                srcOf.set(b.id, src);
            }
            if (movedNames.length) manualBlocks.push(`INFO: ${movedNames.length} shared variables moved to gDB_Machine; ${droppedTagNames.length} duplicate declarations removed from the UN (they resolve in the Machine_IO tag table).`);
        }

        // the UN's CM multi-instances become single instances: each CM's local
        // data then lives in its own idbCM_x, inside the CM's folder
        let unSrc2 = srcOf.get(unBlock.id)!;
        const structuralNames = new Set(ordered.filter(isStructural).map(b => b.name));
        unSrc2 = unSrc2.split(/\r?\n/).filter(l => {
            const im = l.match(/^\s+FB_(\w+)\s*:\s*"(\w+)";/);
            return !(im && structuralNames.has(im[2]));
        }).join('\n');
        unSrc2 = unSrc2.replace(/\bFB_(\w+)\s*\(\s*\)/g, (mm, nm) => structuralNames.has(nm) ? `"idb${nm}"()` : mm);
        srcOf.set(unBlock.id, unSrc2);
    }

    // ---- pass 2b: riparazioni post-spostamento ----
    // (a) accesso a bit su variabili scalari del gDB: il port Rockwell scrive
    //     Name[n] ("bit di word"); su Byte/Word/DWord/LWord in TIA e' lo
    //     slice access Name.%Xn (l'indicizzazione [] vale solo per gli Array).
    const gdbTypeOf = new Map<string, string>();
    for (const d of gdbDecls) {
        const dm = d.match(/^\s*(\w+)\s*(?:\{[^}]*\})?\s*:\s*([^;]+?)\s*;/);
        if (dm) gdbTypeOf.set(dm[1], dm[2].trim());
    }
    const isBitString = (t: string) => /^(Byte|Word|DWord|LWord)$/i.test(t);
    for (const b of ordered) {
        let src = srcOf.get(b.id);
        if (!src) continue;
        src = src.replace(/"gDB_Machine"\.(\w+)\[(\d+)\]/g, (mm, n, i) =>
            isBitString(gdbTypeOf.get(n) || '') ? `"gDB_Machine".${n}.%X${i}` : mm);
        srcOf.set(b.id, src);
    }
    // (b) le strutture telegramma dei drive (NAME:I/:O -> NAME_In/NAME_Out)
    //     non sono dichiarate da nessuna parte: vivono nel gDB come
    //     typeTelegram1In/Out, da mappare ai PZD reali quando i drive esistono.
    const teleDecl = new Map<string, string>();
    for (const b of ordered) {
        const src = srcOf.get(b.id);
        if (!src) continue;
        const local = declaredOf(src);
        for (const mm of src.matchAll(/Telegram(In|Out)\s*:=\s*([A-Za-z_]\w*)\b/g)) {
            const n = mm[2];
            if (local.has(n) || gdbTypeOf.has(n) || tagNames.has(n)) continue;
            teleDecl.set(n, `"typeTelegram1${mm[1]}"`);
        }
    }
    if (teleDecl.size) {
        for (const [n, t] of [...teleDecl.entries()].sort((a, b2) => a[0].localeCompare(b2[0]))) {
            gdbDecls.push(`      ${n} : ${t};   // TODO: map to the drive PZDs (PROFINET telegram)`);
            gdbTypeOf.set(n, t);
        }
        for (const b of ordered) {
            let src = srcOf.get(b.id);
            if (!src) continue;
            const shadows = declaredOf(src);
            for (const n of teleDecl.keys()) {
                if (shadows.has(n)) continue;
                src = src.replace(new RegExp(`(?<![\\w."#])${n}\\b`, 'g'), `"gDB_Machine".${n}`);
            }
            srcOf.set(b.id, src);
        }
        manualBlocks.push(`INFO: ${teleDecl.size} drive telegram structures declared in gDB_Machine (TODO: map to the real drive PZDs).`);
    }

    // ---- emission: gDB first, then blocks leaves-first, each with its idb ----
    const sourceFiles: string[] = [];
    if (gdbDecls.length) {
        const rel = 'sources/15_db/00_gDB_Machine.db';
        files[rel] = [
            `DATA_BLOCK "gDB_Machine"`,
            `{ S7_Optimized_Access := 'TRUE' }`,
            `VERSION : 0.1`,
            `NON_RETAIN`,
            `   STRUCT`,
            // le istanze timer IEC in un DB globale vogliono l'attributo InstructionName
            ...gdbDecls.map(d => d.replace(/^(\s*)(\w+)(\s*):(\s*)(TON_TIME|TOF_TIME)\b/i,
                (mm, sp, n, s1, s2, t) => `${sp}${n} { InstructionName := '${String(t).toUpperCase()}'; LibVersion := '1.0' } :${s2}${t}`)),
            `   END_STRUCT;`,
            ``,
            `BEGIN`,
            ``,
            `END_DATA_BLOCK`,
            ``,
        ].join('\n');
        sourceFiles.push(rel);
        sourceBlocks.push({ file: rel, kind: 'block', names: ['gDB_Machine'] });
    }
    let s = 0;
    const blockFolders: { name: string; folder: string }[] = [];
    if (gdbDecls.length) blockFolders.push({ name: 'gDB_Machine', folder: '' });
    for (const b of ordered) {
        const src = srcOf.get(b.id);
        if (!src) continue;
        const path = pathOf(b);
        const dir = path ? `sources/20_scl/${path}` : 'sources/20_scl';
        const rel = `${dir}/${pad2(++s)}_${b.type === 'OB' ? 'Main' : b.name}.scl`;
        files[rel] = src;
        sourceFiles.push(rel);
        sourceBlocks.push({ file: rel, kind: 'block', names: [b.type === 'OB' ? 'Main' : b.name] });
        blockFolders.push({ name: b.type === 'OB' ? 'Main' : b.name, folder: path });
        // instance DB with the block's local variables, in the SAME folder
        if (isStructural(b)) {
            const dbRel = `${dir}/${pad2(++s)}_idb${b.name}.db`;
            files[dbRel] = idbSource(b.name);
            sourceFiles.push(dbRel);
            sourceBlocks.push({ file: dbRel, kind: 'block', names: [`idb${b.name}`] });
            blockFolders.push({ name: `idb${b.name}`, folder: path });
        }
    }
    // ordine di spostamento: Export/Delete/Import di un blocco rende
    // inconsistenti i blocchi che lo INCORPORANO (multi-istanza) finche' non si
    // ricompila — quindi: prima i DB (idb/gDB, non incorporano nulla), poi i
    // blocchi strutturali (incorporano solo la Library, ancora intatta), per
    // ultima la Library in ordine "chi incorpora prima di chi e' incorporato"
    // (e.g. F_RTA contains G120C => F_RTA moves before G120C).
    const libBlocks = ordered.filter(b => b.level === 'FB');
    const libNames = libBlocks.map(b => b.name);
    const embeds = new Map<string, Set<string>>();
    for (const b of libBlocks) {
        const src = srcOf.get(b.id) || '';
        const deps = new Set<string>();
        for (const n of libNames) if (n !== b.name && new RegExp(`:\\s*"${n}"\\s*;`).test(src)) deps.add(n);
        embeds.set(b.name, deps);
    }
    const libOrder: string[] = [];
    const visitLib = (n: string, stack: Set<string>) => {
        if (libOrder.includes(n) || stack.has(n)) return;
        stack.add(n);
        for (const [other, deps] of embeds) if (deps.has(n)) visitLib(other, stack);   // gli embedder prima
        stack.delete(n);
        libOrder.push(n);
    };
    for (const n of libNames) visitLib(n, new Set());
    const moveRank = (bf: { name: string }) => {
        if (bf.name === 'gDB_Machine' || bf.name.startsWith('idb')) return 0;
        const li = libOrder.indexOf(bf.name);
        return li >= 0 ? 2 + li : 1;
    };
    blockFolders.sort((a, b2) => moveRank(a) - moveRank(b2));   // sort stabile: l'ordine relativo resta

    // ordered folder-path list, parents before children
    const folderPaths: string[] = [];
    for (const bf of blockFolders) {
        if (!bf.folder) continue;
        const segs = bf.folder.split('/');
        for (let i = 1; i <= segs.length; i++) {
            const p = segs.slice(0, i).join('/');
            if (!folderPaths.includes(p)) folderPaths.push(p);
        }
    }

    // ---- correct known-inaccurate order numbers so devices resolve in the
    // TIA catalog (verified real replacements, July 2026). The AMA model had
    // some placeholder MLFBs (e.g. a PM240-2 power-module number labelled
    // "G120C"); fix them at export instead of depending on every project. ----
    const MLFB_FIX: { when: (model: string, mlfb: string) => boolean; mlfb: string; note: string }[] = [
        { when: (model, mlfb) => /G120C/i.test(model) && /^6SL3210-1PE/i.test(mlfb),
          mlfb: '6SL3210-1KE14-3AF2', note: 'real G120C PN 1.5 kW (it was a PM240-2 code that cannot be instantiated) — VERIFY the size for the motor' },
    ];
    const correctionNotes: string[] = [];
    const fixMlfb = (model: string, mlfb: string): string => {
        for (const c of MLFB_FIX) if (c.when(model, mlfb)) {
            const n = `INFO: order number corrected ${mlfb} -> ${c.mlfb} [${model}] — ${c.note}`;
            if (!correctionNotes.includes(n)) correctionNotes.push(n);
            return c.mlfb;
        }
        return mlfb;
    };

    // ---- hardware.json (everything the builder needs, fixed key order) ----
    const usedSbomIds = new Set(nodes.map((n: any) => n.sbomId).filter(Boolean));
    const leftovers = sbom.filter(h => !usedSbomIds.has(h.id));
    const rackMods = leftovers.filter(h => /^6ES71[23]/.test(orderNumberOf(h)));
    const rack: any[] = [];
    let slot = 0;
    for (const h of rackMods) for (let i = 0; i < Math.max(1, h.quantity || 1); i++) {
        rack.push({ slot: ++slot, name: `Slot_${slot}`, model: componentNameOf(h), mlfb: fixMlfb(componentNameOf(h), orderNumberOf(h)), fw: h.firmware || '' });
    }
    // ET 200SP stations require the server module terminator (not in the SBOM — added here)
    rack.push({ slot: ++slot, name: `Server_module`, model: 'ET 200SP server module', mlfb: '6ES7193-6PA00-0AA0', fw: '' });

    // SBOM hardware that is neither in the network topology nor a rack module
    // used to vanish without a trace: list it so it is never silently lost.
    const unplaced = leftovers
        .filter(h => !rackMods.includes(h) && (h.type || 'Hardware') === 'Hardware' && orderNumberOf(h))
        .map(h => `HARDWARE not in the network diagram, NOT created: ${Math.max(1, h.quantity || 1)} x ${componentNameOf(h)} (${orderNumberOf(h)}) - add it to the network topology or insert it by hand.`);

    const kindOf = (d: Dev): string => {
        if (/S7-15/.test(d.model)) return 'plc';
        if (/IM155|ET 200/i.test(d.model)) return 'io';
        if (/servo drive|SINAMICS/i.test(d.model)) return 'drive';
        if (/SCALANCE/i.test(d.model)) return 'switch';
        if (/HMI|TP1200/i.test(d.model)) return 'hmi-manual';       // WinCC not installed
        if (!/^6/.test(d.mlfb)) return 'gsd-manual';                // third-party, needs GSDML
        return 'other';
    };
    const servoDevs = devices.filter(d => /servo drive/i.test(d.model));
    const tosList = [
        ...servoDevs.map(d => ({ name: `TO_${d.name.replace(/^DRV_/, '')}`, type: 'TO_PositioningAxis', drive: d.name })),
        ...(sbom.some(h => /TM Count/i.test(String(h.hardware || ''))) ? [{ name: 'TO_Encoder', type: 'TO_ExternalEncoder', drive: '' }] : []),
    ];
    const nodeOf = (id: string) => nodes.find((n: any) => n.id === id) as any;

    const hw = {
        project: m.project.name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, ''),
        tiaVersion: 'V21',
        subnet: { name: 'PN/IE_1', mask: '255.255.255.0', gateway: '192.168.0.254' },
        devices: devices.map(d => ({ name: d.name, model: d.model, mlfb: fixMlfb(d.model, d.mlfb), fw: d.fw, ip: d.ip, kind: kindOf(d) })),
        et200spRack: { station: devices.find(d => kindOf(d) === 'io')?.name || 'IO_1', modules: rack },
        connections: edges.map((e: any) => {
            const a = nodeOf(e.source), b2 = nodeOf(e.target);
            return a && b2 ? { from: a.label, to: b2.label, protocol: e.protocol || 'PROFINET' } : null;
        }).filter(Boolean),
        folders: folderPaths,
        buildOrder: [...udtFiles, ...sourceFiles],
        blockFolders,
        sourceBlocks,
        technologyObjects: { versionCandidates: ['12.0', '11.0', '10.0', '9.0', '8.0'], items: tosList },
        tags: { table: 'Machine_IO', rows: tags },
        manualSteps: [
            ...correctionNotes,
            ...unplaced,
            ...devices.filter(d => kindOf(d) === 'hmi-manual').map(d => `HMI ${d.name} (${d.mlfb}): create manually — WinCC is not installed in this TIA.`),
            ...devices.filter(d => kindOf(d) === 'gsd-manual').map(d => `${d.name} (${d.model}): install the manufacturer's GSDML and create the GSD device manually.`),
            ...manualBlocks,
            ...overflow,
        ],
    };
    files['hardware.json'] = JSON.stringify(hw, null, 2) + '\n';
    // TIA external sources: UTF-8 WITH BOM so accented characters in comments
    // are not misread as ANSI
    for (const k of Object.keys(files)) if (/\.(scl|db|udt)$/i.test(k)) files[k] = '﻿' + files[k];

    // ---- TiaBuilder (C# console app, TIA Openness) ----
    files['TiaBuilder/TiaBuilder.csproj'] = TIA_CSPROJ;
    files['TiaBuilder/Program.cs'] = TIA_PROGRAM_CS;

    // ---- one-click launcher: build + run + open the report ----
    files['RUN_ME.bat'] = RUN_ME_BAT;

    // ---- README ----
    files['README.md'] = renderReadme(hw);

    return files;
}

// ─── RUN_ME.bat — the whole thing in one double-click ───────
const RUN_ME_BAT = `@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================================
echo   AMA - TIA Portal project generator (TIA Openness)
echo ============================================================
echo.
echo Package folder: %CD%
echo.

where dotnet >nul 2>nul
if errorlevel 1 (
    echo ERROR: 'dotnet' not found in the PATH.
    echo Install the .NET SDK: https://dotnet.microsoft.com/download
    echo The .NET Framework 4.8 Developer Pack is also required.
    echo.
    pause
    exit /b 1
)

echo [1/4] Looking for the TIA Openness libraries...
set "SIEPATH=%~1"
if defined SIEPATH if not exist "%SIEPATH%" set "SIEPATH="

:: If an explicit path was given (file or folder)
if defined SIEPATH (
    if exist "%SIEPATH%\\Siemens.Engineering.dll" (
        set "SIEDIR=%SIEPATH%"
    ) else if exist "%SIEPATH%\\Siemens.Engineering.Base.dll" (
        set "SIEDIR=%SIEPATH%"
    ) else if exist "%SIEPATH%\\net48\\Siemens.Engineering.Base.dll" (
        set "SIEDIR=%SIEPATH%\\net48"
    ) else (
        for %%I in ("%SIEPATH%") do set "SIEDIR=%%~dpI"
    )
)

:: Direct check of the standard paths (faster and more reliable than where /r)
if not defined SIEDIR if exist "C:\\Program Files\\Siemens\\Automation\\Portal V21\\PublicAPI\\V21\\net48\\Siemens.Engineering.Base.dll" set "SIEDIR=C:\\Program Files\\Siemens\\Automation\\Portal V21\\PublicAPI\\V21\\net48"
if not defined SIEDIR if exist "C:\\Program Files\\Siemens\\Automation\\Portal V20\\PublicAPI\\V20\\net48\\Siemens.Engineering.Base.dll" set "SIEDIR=C:\\Program Files\\Siemens\\Automation\\Portal V20\\PublicAPI\\V20\\net48"
if not defined SIEDIR if exist "C:\\Program Files\\Siemens\\Automation\\Portal V20\\PublicAPI\\V20\\Siemens.Engineering.dll" set "SIEDIR=C:\\Program Files\\Siemens\\Automation\\Portal V20\\PublicAPI\\V20"
if not defined SIEDIR if exist "C:\\Program Files\\Siemens\\Automation\\Portal V19\\PublicAPI\\V19\\net48\\Siemens.Engineering.Base.dll" set "SIEDIR=C:\\Program Files\\Siemens\\Automation\\Portal V19\\PublicAPI\\V19\\net48"
if not defined SIEDIR if exist "C:\\Program Files\\Siemens\\Automation\\Portal V19\\PublicAPI\\V19\\Siemens.Engineering.dll" set "SIEDIR=C:\\Program Files\\Siemens\\Automation\\Portal V19\\PublicAPI\\V19"
if not defined SIEDIR if exist "C:\\Program Files\\Siemens\\Automation\\Portal V18\\PublicAPI\\V18\\net48\\Siemens.Engineering.Base.dll" set "SIEDIR=C:\\Program Files\\Siemens\\Automation\\Portal V18\\PublicAPI\\V18\\net48"
if not defined SIEDIR if exist "C:\\Program Files\\Siemens\\Automation\\Portal V18\\PublicAPI\\V18\\Siemens.Engineering.dll" set "SIEDIR=C:\\Program Files\\Siemens\\Automation\\Portal V18\\PublicAPI\\V18"
if not defined SIEDIR if exist "C:\\Program Files\\Siemens\\Automation\\Portal V17\\PublicAPI\\V17\\net48\\Siemens.Engineering.Base.dll" set "SIEDIR=C:\\Program Files\\Siemens\\Automation\\Portal V17\\PublicAPI\\V17\\net48"
if not defined SIEDIR if exist "C:\\Program Files\\Siemens\\Automation\\Portal V17\\PublicAPI\\V17\\Siemens.Engineering.dll" set "SIEDIR=C:\\Program Files\\Siemens\\Automation\\Portal V17\\PublicAPI\\V17"
if not defined SIEDIR if exist "C:\\Program Files\\Siemens\\Automation\\Portal V16\\PublicAPI\\V16\\Siemens.Engineering.dll" set "SIEDIR=C:\\Program Files\\Siemens\\Automation\\Portal V16\\PublicAPI\\V16"

:: Automatic search through where as a fallback if not found in the standard paths
if not defined SIEDIR (
    for /f "delims=" %%P in ('where /r "C:\\Program Files\\Siemens" Siemens.Engineering.Base.dll 2^>nul') do (
        for %%I in ("%%P") do set "SIEDIR=%%~dpI"
    )
)
if not defined SIEDIR (
    for /f "delims=" %%P in ('where /r "C:\\Program Files\\Siemens" Siemens.Engineering.dll 2^>nul') do (
        for %%I in ("%%P") do set "SIEDIR=%%~dpI"
    )
)
if not defined SIEDIR (
    for /f "delims=" %%P in ('where /r "D:\\Program Files\\Siemens" Siemens.Engineering.Base.dll 2^>nul') do (
        for %%I in ("%%P") do set "SIEDIR=%%~dpI"
    )
)
if not defined SIEDIR (
    for /f "delims=" %%P in ('where /r "D:\\Program Files\\Siemens" Siemens.Engineering.dll 2^>nul') do (
        for %%I in ("%%P") do set "SIEDIR=%%~dpI"
    )
)
if not defined SIEDIR (
    for /f "delims=" %%P in ('where /r "C:\\Siemens" Siemens.Engineering.Base.dll 2^>nul') do (
        for %%I in ("%%P") do set "SIEDIR=%%~dpI"
    )
)
if not defined SIEDIR (
    for /f "delims=" %%P in ('where /r "C:\\Siemens" Siemens.Engineering.dll 2^>nul') do (
        for %%I in ("%%P") do set "SIEDIR=%%~dpI"
    )
)

:: Remove the trailing backslash from SIEDIR if present
if defined SIEDIR if "%SIEDIR:~-1%"=="\\" set "SIEDIR=%SIEDIR:~0,-1%"

if not defined SIEDIR (
    echo.
    echo ERROR: TIA Openness library Siemens.Engineering.dll or Siemens.Engineering.Base.dll not found.
    echo.
    echo Check that:
    echo   - TIA Portal ^(with the "Openness" option^) is installed ON THIS PC.
    echo   - If it is installed, look for the file manually and re-run like this:
    echo       RUN_ME.bat "C:\\full\\path\\to\\Siemens.Engineering.Base.dll"
    echo.
    pause
    exit /b 1
)
echo       API folder found: %SIEDIR%
set "SIEMENS_ENGINEERING_DIR=%SIEDIR%"

echo.
echo [2/4] Building TiaBuilder...
dotnet build "TiaBuilder\\TiaBuilder.csproj" -c Release -v minimal -p:SiemensEngineeringDir="%SIEDIR%"
if errorlevel 1 (
    echo.
    echo BUILD FAILED. See the errors above.
    echo Check: user in the local group "Siemens TIA Openness" ^(restart the
    echo session after adding it^), .NET Framework 4.8 Developer Pack installed.
    echo.
    pause
    exit /b 1
)

set "EXE=TiaBuilder\\bin\\Release\\net48\\TiaBuilder.exe"
if not exist "%EXE%" (
    for /r "TiaBuilder\\bin" %%F in (TiaBuilder.exe) do set "EXE=%%F"
)
if not exist "%EXE%" (
    echo ERROR: TiaBuilder.exe not found after the build.
    pause
    exit /b 1
)

set "OUTDIR=%CD%\\_TIA_Project"

echo.
echo [3/4] Starting TIA Portal and building the project...
echo       Destination: %OUTDIR%
echo       It may take several minutes. DO NOT close this window.
echo       (To regenerate from scratch, first delete the _TIA_Project folder.)
echo.
"%EXE%" --package "%CD%" --out "%OUTDIR%" --ui

echo.
echo [4/4] Finished. Opening the report...
if exist "BuildReport.txt" (
    start "" notepad "BuildReport.txt"
) else (
    echo No BuildReport.txt produced: the previous phase did not run to completion.
)

echo.
echo Check BuildReport.txt: it lists what was created [OK] and any
echo manual steps [MANUAL] or errors [FAIL] to fix.
pause
`;

// ─── README ─────────────────────────────────────────────────
function renderReadme(hw: any): string {
    return [
        `# TIA Portal build package — ${hw.project}`,
        ``,
        `Generated by AMA. Builds the TIA Portal project via **TIA Openness**,`,
        `the way the L5X export does for Studio 5000. Plain text, deterministic.`,
        ``,
        `## Prerequisites (on the engineering PC)`,
        `- TIA Portal **${hw.tiaVersion}** with the **Openness** option (the Windows user must`,
        `  belong to the local group \`Siemens TIA Openness\` — restart the session after adding it).`,
        `- **Startdrive** (to create the SINAMICS G120C / S210).`,
        `- **.NET SDK** (\`dotnet\` in the PATH) + **.NET Framework 4.8 Developer Pack**.`,
        ``,
        `## Usage — a single step`,
        `Copy the ENTIRE folder of this package (all files and subfolders) to the`,
        `engineering PC, then double-click **\`RUN_ME.bat\`**.`,
        ``,
        `The script: finds \`Siemens.Engineering.dll\` on the disk by itself (no path`,
        `to guess), builds TiaBuilder, starts TIA Portal (with its interface, so`,
        `you can follow the steps), builds the project in \`_TIA_Project\` next to`,
        `this package, and at the end opens **BuildReport.txt** automatically — it lists`,
        `what was created \`[OK]\`, the remaining manual steps \`[MANUAL]\` and any`,
        `errors \`[FAIL]\`.`,
        ``,
        `If the automatic search does not find the DLL (installation in an`,
        `unusual path), look for it manually in File Explorer ("Siemens.Engineering.dll") and`,
        `re-run like this: \`RUN_ME.bat "C:\\full\\path\\Siemens.Engineering.dll"\``,
        ``,
        `To regenerate from scratch, first delete the \`_TIA_Project\` folder (the builder`,
        `refuses to write over a non-empty destination, for safety).`,
        ``,
        `### Manual usage (alternative to RUN_ME.bat)`,
        `1. \`dotnet build TiaBuilder\\TiaBuilder.csproj -c Release -p:SiemensEngineeringDll="<DLL path>"\``,
        `2. \`TiaBuilder\\bin\\Release\\net48\\TiaBuilder.exe --package <this folder> --out <project folder> [--ui]\``,
        `3. Read **BuildReport.txt**.`,
        ``,
        `## What it does automatically`,
        `- Project, PLC (exact order number), ET 200SP with modules in the slots, drives`,
        `  (Startdrive), switches; PROFINET subnet with the IPs from \`hardware.json\`.`,
        `- HIERARCHICAL program folders (${hw.folders.length} groups): one folder for the`,
        `  Unit, inside it the EM folders, inside those the CM folders — each folder`,
        `  holds the block and its instance DB (the local variables). The shared`,
        `  machine variables live in the global DB \`gDB_Machine\` at the root.`,
        `- Import of the external sources in order (\`buildOrder\`): UDT → FB → DB → OB,`,
        `  with block generation (KeepOnError: blocks with errors are left to be refined).`,
        `- Technology Objects (${hw.technologyObjects.items.length}) and tag table \`${hw.tags.table}\`.`,
        `- Final compilation + report.`,
        ``,
        `## Manual steps (also listed in BuildReport.txt)`,
        ...hw.manualSteps.map((s2: string) => `- ${s2}`),
        ``,
        `## Honest note`,
        `This package cannot be tested without a real TIA Portal: as with`,
        `the L5X, the first real import may need iterations. The builder`,
        `does not stop at the first error: it tries every step and reports everything in the report.`,
        ``,
    ].join('\n');
}

// ─── TiaBuilder sources (embedded, generated verbatim) ──────
const TIA_CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net48</TargetFramework>
    <LangVersion>latest</LangVersion>
    <PlatformTarget>x64</PlatformTarget>
    <Nullable>disable</Nullable>
  </PropertyGroup>
  <!-- Siemens.Engineering: RUN_ME.bat searches the disk for the DLLs and passes
       the directory path here (-p:SiemensEngineeringDir=...) — no guessing needed.
       We support both the legacy monolithic Siemens.Engineering.dll and the V21+ modular DLLs. -->
  <PropertyGroup>
    <SiemensEngineeringDir Condition="'\$(SiemensEngineeringDir)' == '' AND '\$(SiemensEngineeringDll)' != ''">\$([System.IO.Path]::GetDirectoryName('\$(SiemensEngineeringDll)'))</SiemensEngineeringDir>
  </PropertyGroup>
  <ItemGroup Condition="'\$(SiemensEngineeringDir)' != ''">
    <!-- Legacy monolithic library (V14-V20) -->
    <Reference Include="Siemens.Engineering" Condition="Exists('\$(SiemensEngineeringDir)\\Siemens.Engineering.dll')">
      <HintPath>\$(SiemensEngineeringDir)\\Siemens.Engineering.dll</HintPath>
      <Private>false</Private>
    </Reference>
    <!-- Modular libraries (V21+) -->
    <Reference Include="Siemens.Engineering.Base" Condition="Exists('\$(SiemensEngineeringDir)\\Siemens.Engineering.Base.dll')">
      <HintPath>\$(SiemensEngineeringDir)\\Siemens.Engineering.Base.dll</HintPath>
      <Private>false</Private>
    </Reference>
    <Reference Include="Siemens.Engineering.Step7" Condition="Exists('\$(SiemensEngineeringDir)\\Siemens.Engineering.Step7.dll')">
      <HintPath>\$(SiemensEngineeringDir)\\Siemens.Engineering.Step7.dll</HintPath>
      <Private>false</Private>
    </Reference>
    <Reference Include="Siemens.Engineering.WinCC" Condition="Exists('\$(SiemensEngineeringDir)\\Siemens.Engineering.WinCC.dll')">
      <HintPath>\$(SiemensEngineeringDir)\\Siemens.Engineering.WinCC.dll</HintPath>
      <Private>false</Private>
    </Reference>
  </ItemGroup>
  <Choose>
    <When Condition="'\$(SiemensEngineeringDir)' == '' AND Exists('C:\\Program Files\\Siemens\\Automation\\Portal V21\\PublicAPI\\V21\\net48\\Siemens.Engineering.Base.dll')">
      <ItemGroup>
        <Reference Include="Siemens.Engineering.Base"><HintPath>C:\\Program Files\\Siemens\\Automation\\Portal V21\\PublicAPI\\V21\\net48\\Siemens.Engineering.Base.dll</HintPath><Private>false</Private></Reference>
        <Reference Include="Siemens.Engineering.Step7"><HintPath>C:\\Program Files\\Siemens\\Automation\\Portal V21\\PublicAPI\\V21\\net48\\Siemens.Engineering.Step7.dll</HintPath><Private>false</Private></Reference>
        <Reference Include="Siemens.Engineering.WinCC"><HintPath>C:\\Program Files\\Siemens\\Automation\\Portal V21\\PublicAPI\\V21\\net48\\Siemens.Engineering.WinCC.dll</HintPath><Private>false</Private></Reference>
      </ItemGroup>
    </When>
    <When Condition="'\$(SiemensEngineeringDir)' == '' AND Exists('C:\\Program Files\\Siemens\\Automation\\Portal V20\\PublicAPI\\V20\\Siemens.Engineering.dll')">
      <ItemGroup><Reference Include="Siemens.Engineering"><HintPath>C:\\Program Files\\Siemens\\Automation\\Portal V20\\PublicAPI\\V20\\Siemens.Engineering.dll</HintPath><Private>false</Private></Reference></ItemGroup>
    </When>
    <When Condition="'\$(SiemensEngineeringDir)' == '' AND Exists('C:\\Program Files\\Siemens\\Automation\\Portal V19\\PublicAPI\\V19\\Siemens.Engineering.dll')">
      <ItemGroup><Reference Include="Siemens.Engineering"><HintPath>C:\\Program Files\\Siemens\\Automation\\Portal V19\\PublicAPI\\V19\\Siemens.Engineering.dll</HintPath><Private>false</Private></Reference></ItemGroup>
    </When>
    <When Condition="'\$(SiemensEngineeringDir)' == '' AND Exists('C:\\Program Files\\Siemens\\Automation\\Portal V18\\PublicAPI\\V18\\Siemens.Engineering.dll')">
      <ItemGroup><Reference Include="Siemens.Engineering"><HintPath>C:\\Program Files\\Siemens\\Automation\\Portal V18\\PublicAPI\\V18\\Siemens.Engineering.dll</HintPath><Private>false</Private></Reference></ItemGroup>
    </When>
  </Choose>
</Project>
`;

const TIA_PROGRAM_CS = `// ============================================================
// TiaBuilder — builds the TIA Portal project from the AMA package
// (hardware.json + external sources). Every step is in try/catch:
// an error does not stop the build, it ends up in BuildReport.txt.
// Usage: TiaBuilder.exe --package <package dir> --out <project dir> [--ui]
// ============================================================
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Siemens.Engineering;
using Siemens.Engineering.Compiler;
using Siemens.Engineering.HW;
using Siemens.Engineering.HW.Features;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Blocks;
using Siemens.Engineering.SW.ExternalSources;
using Siemens.Engineering.SW.Tags;
using Siemens.Engineering.SW.Types;

internal static class Program
{
    static Program()
    {
        AppDomain.CurrentDomain.AssemblyResolve += ResolveSiemensAssemblies;
    }

    private static Assembly ResolveSiemensAssemblies(object sender, ResolveEventArgs args)
    {
        var name = new AssemblyName(args.Name).Name;
        
        // 1. Try Environment Variable set by RUN_ME.bat
        var apiDir = Environment.GetEnvironmentVariable("SIEMENS_ENGINEERING_DIR");
        if (!string.IsNullOrEmpty(apiDir))
        {
            var dllPath = Path.Combine(apiDir, name + ".dll");
            if (File.Exists(dllPath)) return Assembly.LoadFrom(dllPath);
        }

        // 2. Try Registry Lookup
        try
        {
            using (var baseKey = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Siemens\Automation\Openness"))
            {
                if (baseKey != null)
                {
                    foreach (var ver in baseKey.GetSubKeyNames().OrderByDescending(x => x))
                    {
                        using (var pubKey = baseKey.OpenSubKey(ver + @"\PublicAPI"))
                        {
                            if (pubKey != null)
                            {
                                foreach (var subVer in pubKey.GetSubKeyNames().OrderByDescending(x => x))
                                {
                                    using (var netKey = pubKey.OpenSubKey(subVer + @"\\net48"))
                                    {
                                        if (netKey != null)
                                        {
                                            var pathVal = netKey.GetValue("Siemens.Engineering.Base") as string;
                                            if (!string.IsNullOrEmpty(pathVal) && File.Exists(pathVal))
                                            {
                                                var dir = Path.GetDirectoryName(pathVal);
                                                var dllPath = Path.Combine(dir, name + ".dll");
                                                if (File.Exists(dllPath)) return Assembly.LoadFrom(dllPath);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        catch {}

        return null;
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static int RunBuilder(string[] args)
    {
        return BuilderExecutor.Execute(args);
    }

    private static int Main(string[] args)
    {
        try
        {
            return RunBuilder(args);
        }
        catch (Exception ex)
        {
            Console.WriteLine("CRITICAL ERROR: " + ex.ToString());
            return 1;
        }
    }
}

internal static class BuilderExecutor
{
    public static readonly List<string> Report = new List<string>();
    public static void Log(string s) { Console.WriteLine(s); Report.Add(s); }
    public static void Ok(string s) { Log("  [OK]     " + s); }
    public static void Manual(string s) { Log("  [MANUAL] " + s); }
    public static void Fail(string s, Exception ex) { Log("  [FAIL]   " + s + " -> " + (ex != null ? ex.Message : "null")); }

    // Compile error details in the report: without this only the count
    // is visible and it is not clear WHAT to fix.
    private static void LogCompileErrors(CompilerResult result, int max)
    {
        try
        {
            int shown = 0;
            LogCompileWalk(result.Messages, "", ref shown, max);
            if (shown >= max) Log("    ... (more errors omitted, see TIA Portal)");
        }
        catch (Exception ex) { Log("    (unable to read the compile messages: " + ex.Message + ")"); }
    }

    private static void LogCompileWalk(CompilerResultMessageComposition msgs, string ctx, ref int shown, int max)
    {
        foreach (CompilerResultMessage m2 in msgs)
        {
            if (shown >= max) return;
            // the Path of leaf messages is just the line number: carry along
            // the chain of parent Paths (the block name) to understand
            // WHERE the error is.
            var here = string.IsNullOrEmpty(m2.Path) ? ctx : (string.IsNullOrEmpty(ctx) ? m2.Path : ctx + " / " + m2.Path);
            if (m2.State == CompilerResultState.Error && !string.IsNullOrEmpty(m2.Description))
            {
                Log("    ERR " + here + " | " + m2.Description);
                shown++;
            }
            LogCompileWalk(m2.Messages, here, ref shown, max);
        }
    }

    // Firmware candidates: exact, then descending minor versions, then none.
    // The catalog often has a device at a slightly different FW than we guessed
    // (e.g. we say V2.1 but the module is V2.0), so we probe downwards.
    private static IEnumerable<string> FwCandidates(string fw)
    {
        var seen = new HashSet<string>();
        if (!string.IsNullOrEmpty(fw))
        {
            var v = fw.Split(' ')[0].TrimStart('V', 'v');   // "V4.7 SP14" -> "4.7"
            var parts = v.Split('.');
            if (parts.Length >= 2 && int.TryParse(parts[0], out int maj) && int.TryParse(parts[1], out int min))
            {
                for (int m = min; m >= 0; m--) { var s = "V" + maj + "." + m; if (seen.Add(s)) yield return s; }
            }
            else { yield return "V" + v; }
        }
        yield return null;   // no firmware suffix
    }

    // "6ES7516-3TN00-0AB0" -> also "6ES7 516-3TN00-0AB0" (catalog format);
    // each tried with a descending list of firmware suffixes and with none.
    private static IEnumerable<string> TypeIds(string mlfb, string fw)
    {
        var spaced = mlfb.Length > 4 ? mlfb.Substring(0, 4) + " " + mlfb.Substring(4) : mlfb;
        var forms = spaced == mlfb ? new[] { mlfb } : new[] { spaced, mlfb };
        foreach (var m in forms)
            foreach (var f in FwCandidates(fw))
                yield return f == null ? "OrderNumber:" + m : "OrderNumber:" + m + "/" + f;
    }

    private static Device CreateDevice(Project project, string mlfb, string fw, string name)
    {
        Exception last = null;
        var tried = new List<string>();
        foreach (var tid in TypeIds(mlfb, fw))
        {
            tried.Add(tid);
            try { return project.Devices.CreateWithItem(tid, name, name); }
            catch (Exception ex) { last = ex; }
        }
        var notInCatalog = last != null && last.Message.IndexOf("No hardware object", StringComparison.OrdinalIgnoreCase) >= 0;
        var hint = notInCatalog
            ? " => order number not in the TIA catalog: VERIFY the exact order number in the Hardware Catalog (with the HSPs/Startdrive installed)."
            : "";
        throw new Exception((last != null ? last.Message : "no valid identifier")
            + hint + " [provati: " + string.Join(" | ", tried) + "]");
    }

    public static int Execute(string[] args)
    {
        string pkg = null, outDir = null; bool ui = false;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--package") pkg = args[++i];
            else if (args[i] == "--out") outDir = args[++i];
            else if (args[i] == "--ui") ui = true;
        }
        if (pkg == null || outDir == null)
        {
            Console.WriteLine("Usage: TiaBuilder --package <AMA package dir> --out <project dir> [--ui]");
            return 2;
        }
        // Fail fast, before touching TIA Portal at all, if the destination is
        // not empty (Projects.Create would reject it and there is nothing
        // useful to build a report about yet).
        if (Directory.Exists(outDir) && Directory.EnumerateFileSystemEntries(outDir).Any())
        {
            Log("ERROR: the destination folder already exists and is not empty:");
            Log("  " + outDir);
            Log("Delete the folder (or rename it) or choose another destination with --out, then try again.");
            WriteReport(pkg);
            return 3;
        }
        var hw = SimpleJson.Parse(File.ReadAllText(Path.Combine(pkg, "hardware.json")));

        Log("== TiaBuilder: " + (string)hw["project"] + " ==");
        using (var tia = new TiaPortal(ui ? TiaPortalMode.WithUserInterface : TiaPortalMode.WithoutUserInterface))
        {
            Log("TIA Portal started (" + (ui ? "with UI" : "without UI") + ").");
            // Everything from here on is wrapped: a crash mid-build must still
            // leave BuildReport.txt behind (with everything logged so far)
            // instead of an unhandled .NET exception and no report at all.
            Project project = null;
            try
            {
            project = tia.Projects.Create(new DirectoryInfo(outDir), (string)hw["project"]);
            Ok("project created in " + outDir);

            // ---- devices ----
            var created = new Dictionary<string, Device>();
            PlcSoftware plc = null;
            foreach (var d in (List<object>)hw["devices"])
            {
                var dev = (Dictionary<string, object>)d;
                string name = (string)dev["name"], mlfb = (string)dev["mlfb"], fw = (string)dev["fw"], kind = (string)dev["kind"];
                if (kind == "hmi-manual" || kind == "gsd-manual") { Manual(name + " (" + mlfb + "): create manually."); continue; }
                try
                {
                    var device = CreateDevice(project, mlfb, fw, name);
                    created[name] = device;
                    Ok("device " + name + " (" + mlfb + ")");
                    if (kind == "plc")
                    {
                        foreach (var item in device.DeviceItems)
                        {
                            var sc = item.GetService<SoftwareContainer>();
                            if (sc?.Software is PlcSoftware p2) { plc = p2; break; }
                        }
                    }
                }
                catch (Exception ex) { Fail("device " + name + " (" + mlfb + ")", ex); }
            }
            // without a PLC the software cannot be built, but hardware and network
            // stay and the project is still saved (it used to exit without
            // saving and the whole hardware configuration was lost)
            if (plc == null) Log("!! PLC not created: skipping the software part, saving the hardware anyway.");

            // ---- ET 200SP modules ----
            try
            {
                var rack = (Dictionary<string, object>)hw["et200spRack"];
                var station = (string)rack["station"];
                if (created.TryGetValue(station, out var io))
                {
                    // the module must be plugged into the container (DIN rail) that accepts it:
                    // every item of the station is tried with CanPlugNew
                    var hosts = io.DeviceItems.SelectMany(Flatten).ToList();
                    foreach (var mo in (List<object>)rack["modules"])
                    {
                        var mod = (Dictionary<string, object>)mo;
                        int pos = Convert.ToInt32(mod["slot"]);
                        string mlfb = (string)mod["mlfb"], nm = (string)mod["name"];
                        bool plugged = false; Exception last = null;
                        foreach (var tid in TypeIds(mlfb, (string)mod["fw"]))
                        {
                            foreach (var host in hosts)
                            {
                                try
                                {
                                    if (!host.CanPlugNew(tid, nm, pos)) continue;
                                    host.PlugNew(tid, nm, pos); plugged = true; break;
                                }
                                catch (Exception ex) { last = ex; }
                            }
                            if (plugged) break;
                        }
                        if (plugged) Ok("modulo slot " + pos + " " + mlfb);
                        else Fail("modulo slot " + pos + " " + mlfb, last);
                    }
                }
                else Fail("ET 200SP rack: station " + station + " not created, modules not plugged", null);
            }
            catch (Exception ex) { Fail("rack ET 200SP", ex); }

            // ---- network: subnet + IP ----
            try
            {
                var subnetName = (string)((Dictionary<string, object>)hw["subnet"])["name"];
                Subnet subnet = null;
                IoSystem ioSystem = null;

                // Pass 1: Configure PLC node and create the PROFINET IO System
                foreach (var d in (List<object>)hw["devices"])
                {
                    var dev = (Dictionary<string, object>)d;
                    string name = (string)dev["name"], ip = (string)dev["ip"], kind = (string)dev["kind"];
                    if (kind != "plc" || string.IsNullOrEmpty(ip) || !created.TryGetValue(name, out var device)) continue;
                    try
                    {
                        var netIf = FindPnInterface(device);
                        if (netIf == null) { Fail(name + ": PROFINET interface not found on the PLC.", null); continue; }
                        var node = netIf.Nodes.First();

                        // Diagnostic log of all attributes
                        try
                        {
                            var engNode = (Siemens.Engineering.IEngineeringObject)node;
                            Log("INFO: Network attributes for " + name + ":");
                            foreach (var attr in engNode.GetAttributeInfos())
                            {
                                try { Log("  - " + attr.Name + ": " + engNode.GetAttribute(attr.Name) + " (Access: " + attr.AccessMode + ")"); }
                                catch (Exception exAttr) { Log("  - " + attr.Name + " [error reading]: " + exAttr.Message); }
                            }
                        }
                        catch (Exception exDiag) { Log("WARN: Unable to read debug attributes: " + exDiag.Message); }

                        subnet = node.CreateAndConnectToSubnet(subnetName);

                        // Set SubnetMask if supported
                        try { node.SetAttribute("SubnetMask", "255.255.255.0"); }
                        catch (Exception exMask) { Log("WARN: Unable to set SubnetMask: " + exMask.Message); }

                        node.SetAttribute("Address", ip);
                        Ok("subnet creata e collegata al PLC: " + name + " = " + ip);

                        var ioController = netIf.IoControllers.FirstOrDefault();
                        if (ioController != null)
                        {
                            ioSystem = ioController.CreateIoSystem("PNIO_1");
                            Ok("PROFINET IO System creato: PNIO_1");
                        }
                        else
                        {
                            Fail("IoController not found on the PLC " + name, null);
                        }
                    }
                    catch (Exception ex) { Fail("PLC network " + name, ex); }
                }

                // Pass 2: Configure non-PLC nodes and assign them to the subnet & IO System
                foreach (var d in (List<object>)hw["devices"])
                {
                    var dev = (Dictionary<string, object>)d;
                    string name = (string)dev["name"], ip = (string)dev["ip"], kind = (string)dev["kind"];
                    if (kind == "plc" || string.IsNullOrEmpty(ip) || !created.TryGetValue(name, out var device)) continue;
                    try
                    {
                        var netIf = FindPnInterface(device);
                        if (netIf == null) { Manual(name + ": PROFINET interface not found, IP " + ip + " to be set manually."); continue; }
                        var node = netIf.Nodes.First();
                        if (subnet != null) node.ConnectToSubnet(subnet);
                        else subnet = node.CreateAndConnectToSubnet(subnetName);

                        try { node.SetAttribute("SubnetMask", "255.255.255.0"); }
                        catch (Exception exMask) { Log("WARN: Unable to set SubnetMask: " + exMask.Message); }

                        node.SetAttribute("Address", ip);

                        var ioConnector = netIf.IoConnectors.FirstOrDefault();
                        if (ioConnector != null && ioSystem != null)
                        {
                            ioConnector.ConnectToIoSystem(ioSystem);
                            Ok("network " + name + " = " + ip + " (assigned to PNIO_1)");
                        }
                        else
                        {
                            Ok("network " + name + " = " + ip + " (connected to the subnet)");
                        }
                    }
                    catch (Exception ex) { Fail("network " + name, ex); }
                }
            }
            catch (Exception ex) { Fail("subnet", ex); }

            if (plc == null) goto swDone;

            // ---- program folders (hierarchical: nested UN / EM / CM) ----
            // "folders" contiene percorsi tipo "UN_ROE/EM_Capping/CM_Screwing":
            // every segment is a group nested inside the previous one.
            var groups = new Dictionary<string, PlcBlockUserGroup>();
            foreach (var f in (List<object>)hw["folders"])
            {
                var pathStr = (string)f;
                try
                {
                    PlcBlockUserGroup parentGrp = null;
                    var acc = "";
                    foreach (var seg in pathStr.Split('/'))
                    {
                        acc = acc.Length == 0 ? seg : acc + "/" + seg;
                        if (!groups.TryGetValue(acc, out var g))
                        {
                            var comp = parentGrp == null ? plc.BlockGroup.Groups : parentGrp.Groups;
                            g = comp.FirstOrDefault(x => x.Name == seg) ?? comp.Create(seg);
                            groups[acc] = g;
                        }
                        parentGrp = groups[acc];
                    }
                    Ok("folder " + pathStr);
                }
                catch (Exception ex) { Fail("folder " + pathStr, ex); }
            }

            // ---- tag table BEFORE the sources: the blocks reference the I/O
            // tags (In_SBx, Btn_x...) — without the table the compilation produced
            // hundreds of errors and the blocks stayed inconsistent ----
            try
            {
                var tags = (Dictionary<string, object>)hw["tags"];
                var table = plc.TagTableGroup.TagTables.Create((string)tags["table"]);
                int n = 0;
                foreach (var r in (List<object>)tags["rows"])
                {
                    var row = (Dictionary<string, object>)r;
                    try { table.Tags.Create((string)row["name"], (string)row["dataType"], (string)row["address"]); n++; }
                    catch (Exception ex) { Fail("tag " + row["name"], ex); }
                }
                Ok("tabella tag: " + n + " tag creati");
            }
            catch (Exception ex) { Fail("tabella tag", ex); }

            // ---- Technology Objects (before the sources) ----
            try
            {
                var to = (Dictionary<string, object>)hw["technologyObjects"];
                var versions = ((List<object>)to["versionCandidates"]).Select(v => new Version((string)v)).ToList();
                var toGroup = plc.GetType().GetProperty("TechnologicalObjectGroup")?.GetValue(plc);
                var toComp = toGroup?.GetType().GetProperty("TechnologicalObjects")?.GetValue(toGroup);
                var createM = toComp?.GetType().GetMethods().FirstOrDefault(x => x.Name == "Create" && x.GetParameters().Length == 3);
                foreach (var t in (List<object>)to["items"])
                {
                    var item = (Dictionary<string, object>)t;
                    string name = (string)item["name"], type = (string)item["type"];
                    bool done = false;
                    foreach (var v in versions)
                    {
                        try { createM?.Invoke(toComp, new object[] { name, type, v }); done = true; break; }
                        catch { }
                    }
                    if (done) Ok("TO " + name + " (" + type + ") — collegare al drive " + item["drive"]);
                    else Manual("create the TO " + name + " (" + type + ") and link it to the drive " + item["drive"] + ".");
                }
            }
            catch (Exception ex) { Fail("technology objects", ex); }

            // ---- external sources in ordine ----
            // Every source must produce the expected blocks (sourceBlocks): TIA
            // often does NOT throw when generation fails (e.g. a forward
            // reference to a block that is not there yet), the block is simply missing.
            // So existence is verified and the missing sources are retried (up to 3
            // times), because forward references resolve once the later blocks exist.
            var sourceBlocks = ((List<object>)hw["sourceBlocks"]).Select(o => (Dictionary<string, object>)o).ToList();
            var extSrcs = new Dictionary<string, PlcExternalSource>();
            var srcErr = new Dictionary<string, string>();
            for (int pass = 1; pass <= 3; pass++)
            {
                int progress = 0, pending = 0;
                foreach (var sb in sourceBlocks)
                {
                    string rel = (string)sb["file"], kind = (string)sb["kind"];
                    var names = ((List<object>)sb["names"]).Select(x => (string)x).ToList();
                    if (names.All(n => Exists(plc, kind, n))) continue;
                    pending++;
                    var path = Path.Combine(pkg, rel.Replace('/', Path.DirectorySeparatorChar));
                    try
                    {
                        PlcExternalSource old;
                        if (extSrcs.TryGetValue(rel, out old)) { try { old.Delete(); } catch { } extSrcs.Remove(rel); }
                        var src = plc.ExternalSourceGroup.ExternalSources.CreateFromFile(Path.GetFileName(path), path);
                        extSrcs[rel] = src;
                        try { src.GenerateBlocksFromSource(GenerateBlockOption.KeepOnError); }
                        catch (MissingMethodException) { src.GenerateBlocksFromSource(); }
                    }
                    catch (Exception ex) { srcErr[rel] = ex.Message; continue; }
                    if (names.All(n => Exists(plc, kind, n)))
                    {
                        progress++; srcErr.Remove(rel);
                        Ok("source " + rel + (pass > 1 ? " (retry " + pass + ")" : ""));
                    }
                    else srcErr[rel] = "source imported but block not generated (" + string.Join(", ", names.Where(n => !Exists(plc, kind, n))) + ")";
                }
                if (pending == 0 || progress == 0) break;
            }
            foreach (var kv in srcErr) Fail("source " + kv.Key, new Exception(kv.Value));

            // ---- blocks into the folders (Export/Delete/Import) ----
            // The Openness export rejects "inconsistent" blocks: a compilation is
            // needed BEFORE moving (it was the cause of the earlier FAILs).
            try
            {
                var pre = plc.GetService<ICompilable>().Compile();
                Log("Preliminary compilation (before moving): errors " + pre.ErrorCount + ", warnings " + pre.WarningCount);
                LogCompileErrors(pre, 60);
            }
            catch (Exception ex) { Fail("preliminary compilation", ex); }

            var moveTmp = Path.Combine(Path.GetTempPath(), "TiaBuilderMove");
            Directory.CreateDirectory(moveTmp);
            int moveCompiles = 0;   // "recovery" recompilations during the moves
            foreach (var bf in (List<object>)hw["blockFolders"])
            {
                var it = (Dictionary<string, object>)bf;
                string name = (string)it["name"], folder = (string)it["folder"];
                if (string.IsNullOrEmpty(folder)) continue;   // resta alla radice (OB1, gDB)
                if (!groups.ContainsKey(folder))
                {
                    Manual("drag the block " + name + " into the folder " + folder + " (destination folder not created).");
                    continue;
                }
                var moved = false; Exception lastEx = null;
                // 2 attempts: if the export fails because of an "inconsistent" block
                // (usually because an embedded block was just moved
                // via Delete/Import), a recompilation restores it.
                for (int attempt = 0; attempt < 2 && !moved; attempt++)
                {
                    try
                    {
                        var block = plc.BlockGroup.Blocks.FirstOrDefault(x => x.Name == name);
                        if (block == null) { moved = true; break; }   // not generated: already reported above
                        var tempFile = new FileInfo(Path.Combine(moveTmp, name + ".xml"));
                        if (tempFile.Exists) tempFile.Delete();
                        block.Export(tempFile, ExportOptions.WithDefaults);
                        block.Delete();
                        try { groups[folder].Blocks.Import(tempFile, ImportOptions.Override); }
                        catch (Exception impEx)
                        {
                            // the block was deleted: never leave it lost, it is put
                            // back at the root from the exported file
                            try { plc.BlockGroup.Blocks.Import(tempFile, ImportOptions.Override); Log("  [WARN]   block " + name + " restored at the root (move failed)"); }
                            catch (Exception restEx) { Fail("BLOCK LOST " + name + " (re-import failed: recreate it from the source in the package)", restEx); }
                            throw impEx;
                        }
                        Ok("block " + name + " -> " + folder + (attempt > 0 ? " (after recompilation)" : ""));
                        moved = true;
                    }
                    catch (Exception ex)
                    {
                        lastEx = ex;
                        var inconsistent = ex.Message.IndexOf("Inconsistent", StringComparison.OrdinalIgnoreCase) >= 0;
                        if (attempt == 0 && inconsistent && moveCompiles < 5)
                        {
                            moveCompiles++;
                            try { plc.GetService<ICompilable>().Compile(); } catch { break; }
                        }
                        else break;
                    }
                }
                if (!moved && lastEx != null)
                {
                    var hint = lastEx.Message.IndexOf("Inconsistent", StringComparison.OrdinalIgnoreCase) >= 0
                        ? " => the block has compile errors: fix them and move it by hand (or run again)."
                        : "";
                    Fail("moving block " + name + " -> " + folder + hint, lastEx);
                }
            }

            // ---- final compilation (with error details in the report) ----
            try
            {
                var result = plc.GetService<ICompilable>().Compile();
                Log("Final compilation: " + result.State + " — errors " + result.ErrorCount + ", warnings " + result.WarningCount);
                LogCompileErrors(result, 60);
            }
            catch (Exception ex) { Fail("compilation", ex); }

            // ---- final verification: nothing may be missing silently ----
            Log("== VERIFICATION ==");
            int missing = 0;
            foreach (var sb in sourceBlocks)
            {
                foreach (var n in ((List<object>)sb["names"]).Select(x => (string)x))
                    if (!Exists(plc, (string)sb["kind"], n)) { missing++; Log("  [MISSING] " + sb["kind"] + " " + n + " not present in the project"); }
            }
            Log("  blocchi/tipi attesi mancanti: " + missing);
            swDone:
            Log("== RIEPILOGO ==");
            int expectedDevs = ((List<object>)hw["devices"]).Count(d => { var k = (string)((Dictionary<string, object>)d)["kind"]; return k != "hmi-manual" && k != "gsd-manual"; });
            Log("  devices created: " + created.Count + " / " + expectedDevs + " expected");

            foreach (var msObj in (List<object>)hw["manualSteps"]) Manual((string)msObj);

            SaveProject(project);
            }
            catch (Exception ex)
            {
                Log("!! CRITICAL ERROR (build interrupted): " + ex.Message);
                Log("   " + ex.GetType().FullName);
                SaveProject(project);   // what was built so far must not be lost
            }
        }
        WriteReport(pkg);
        return 0;
    }

    private static void SaveProject(Project project)
    {
        if (project == null) return;
        try { project.Save(); Ok("project saved"); }
        catch (Exception ex) { Fail("saving the project", ex); }
    }

    // First PROFINET/Ethernet interface of the device; every access is protected
    // because GetAttribute throws on some items and used to discard the whole device.
    private static NetworkInterface FindPnInterface(Device device)
    {
        foreach (var item in device.DeviceItems.SelectMany(Flatten))
        {
            try
            {
                var ni = item.GetService<NetworkInterface>();
                if (ni == null || !ni.Nodes.Any()) continue;
                if (Convert.ToString(ni.InterfaceType).Contains("Profibus")) continue;
                if (Convert.ToString(ni.Nodes.First().GetAttribute("NodeType")).Contains("Profibus")) continue;
                return ni;
            }
            catch { }
        }
        return null;
    }

    private static PlcBlock FindBlock(PlcBlockGroup g, string name)
    {
        var b = g.Blocks.FirstOrDefault(x => x.Name == name);
        if (b != null) return b;
        foreach (var sg in g.Groups) { var r = FindBlock(sg, name); if (r != null) return r; }
        return null;
    }

    private static bool FindType(PlcTypeGroup g, string name)
    {
        if (g.Types.Any(x => x.Name == name)) return true;
        foreach (var sg in g.Groups) if (FindType(sg, name)) return true;
        return false;
    }

    private static bool Exists(PlcSoftware plc, string kind, string name)
    {
        try { return kind == "udt" ? FindType(plc.TypeGroup, name) : FindBlock(plc.BlockGroup, name) != null; }
        catch { return false; }
    }

    private static IEnumerable<DeviceItem> Flatten(DeviceItem item)
    {
        yield return item;
        foreach (var c in item.DeviceItems) foreach (var x in Flatten(c)) yield return x;
    }

    private static void WriteReport(string pkg)
    {
        var path = Path.Combine(pkg, "BuildReport.txt");
        File.WriteAllLines(path, Report);
        Console.WriteLine("Report written: " + path);
    }
}

// ── minimal JSON parser (no external dependency) ──
internal static class SimpleJson
{
    public static Dictionary<string, object> Parse(string s) { int i = 0; return (Dictionary<string, object>)ParseValue(s, ref i); }
    private static object ParseValue(string s, ref int i)
    {
        SkipWs(s, ref i);
        char c = s[i];
        if (c == '{') return ParseObj(s, ref i);
        if (c == '[') return ParseArr(s, ref i);
        if (c == '"') return ParseStr(s, ref i);
        if (c == 't') { i += 4; return true; }
        if (c == 'f') { i += 5; return false; }
        if (c == 'n') { i += 4; return null; }
        int start = i;
        while (i < s.Length && (char.IsDigit(s[i]) || s[i] == '-' || s[i] == '+' || s[i] == '.' || s[i] == 'e' || s[i] == 'E')) i++;
        return double.Parse(s.Substring(start, i - start), System.Globalization.CultureInfo.InvariantCulture);
    }
    private static Dictionary<string, object> ParseObj(string s, ref int i)
    {
        var o = new Dictionary<string, object>(); i++;
        for (;;)
        {
            SkipWs(s, ref i);
            if (s[i] == '}') { i++; return o; }
            var k = ParseStr(s, ref i);
            SkipWs(s, ref i); i++; // ':'
            o[k] = ParseValue(s, ref i);
            SkipWs(s, ref i);
            if (s[i] == ',') i++;
        }
    }
    private static List<object> ParseArr(string s, ref int i)
    {
        var a = new List<object>(); i++;
        for (;;)
        {
            SkipWs(s, ref i);
            if (s[i] == ']') { i++; return a; }
            a.Add(ParseValue(s, ref i));
            SkipWs(s, ref i);
            if (s[i] == ',') i++;
        }
    }
    private static string ParseStr(string s, ref int i)
    {
        var sb = new System.Text.StringBuilder(); i++; // opening quote
        while (s[i] != '"')
        {
            if (s[i] == '\\\\')
            {
                i++;
                char e = s[i++];
                if (e == 'n') sb.Append('\\n'); else if (e == 't') sb.Append('\\t');
                else if (e == 'u') { sb.Append((char)Convert.ToInt32(s.Substring(i, 4), 16)); i += 4; }
                else sb.Append(e);
            }
            else sb.Append(s[i++]);
        }
        i++; return sb.ToString();
    }
    private static void SkipWs(string s, ref int i) { while (i < s.Length && char.IsWhiteSpace(s[i])) i++; }
}
`;

// ─── Electron delivery ───
const ipc = (): any => (window as any).amaIpc ?? null;

export interface TiaExportResult { ok: boolean; dir?: string; count?: number; canceled?: boolean; error?: string }

/** Folder pick -> write the TIA Openness package as loose text files. */
export async function exportTiaPackage(assembly: AssemblyProject, db: EntityDB): Promise<TiaExportResult> {
    const r = ipc();
    if (!r) return { ok: false, error: 'Only available in the desktop app.' };
    const picked = await r.invoke('ama:pick-folder');
    if (!picked || picked.canceled || !picked.dir) return { ok: false, canceled: true };
    const files = buildTiaPackage(assembly, db);
    const res = await r.invoke('ama:git-write', { dir: picked.dir, files });
    if (res?.ok) return { ok: true, dir: picked.dir, count: res.count };
    return { ok: false, error: res?.error || 'Write failed.' };
}
