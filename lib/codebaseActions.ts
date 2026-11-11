// ============================================================
// AMA — Code base actions (open / save / link / refresh)
// Shared by the ribbon commands and the pages.
// ============================================================
import type { AssemblyNode } from '../types/machine';
import { useStore } from './store';
import { emptyAssembly } from './normalize';
import {
    openCodebaseFolder, readCodebaseFolder, writeCodebaseFolder, pickCodebaseFolderForSave,
    diffLists, type EntityLists, type ParsedCodebase,
} from './codebase';
import { setGitDir, gitStateOf } from './gitOps';
import { mergeFromCodebase } from './deviation';
import { mergeHardware } from './hardware';
import { toast } from '../components/Toaster';

const listsOfState = (): EntityLists => {
    const s = useStore.getState();
    return { library: s.library, units: s.units, equipmentModules: s.equipmentModules, controlModules: s.controlModules };
};

const fail = (e: any) => toast(e?.message || 'Operation failed.');

/** Code base workspace: open a code base folder (a Git repository). */
export async function openCodebase(): Promise<void> {
    try {
        const res = await openCodebaseFolder();
        if (!res) return;
        const { parsed, path } = res;
        const st = useStore.getState();
        if (st.workspaceKind !== 'codebase') st.switchWorkspaceKind('codebase');
        useStore.setState({
            ...parsed.lists,
            // in the Code base workspace the assembly object only carries the reference hardware (SBOM + topology)
            assembly: { ...emptyAssembly(parsed.info.name, parsed.info.description), sbom: parsed.hardware.sbom, networkNodes: parsed.hardware.nodes, networkEdges: parsed.hardware.edges },
            codebase: { ...parsed.info, path },
            projectFilePath: null,
            workspaceLoaded: true,
            selectedNodeId: null,
        });
        setGitDir(path);
        const n = parsed.lists.units.length + parsed.lists.equipmentModules.length + parsed.lists.controlModules.length + parsed.lists.library.length;
        if (n === 0) {
            toast(`No blocks found in ${path}. If this is a new code base, that is fine. Otherwise choose the folder that contains codebase.json (or the units / control-modules folders).`, 'info');
            return;
        }
        toast(`Opened code base "${parsed.info.name}": ${n} blocks${parsed.errors.length ? ` (${parsed.errors.length} file(s) skipped)` : ''}.`, parsed.errors.length ? 'info' : 'success');
    } catch (e) { fail(e); }
}

/** Code base workspace: write the code base to its folder. */
export async function saveCodebase(asNew = false): Promise<void> {
    const st = useStore.getState();
    if (st.workspaceKind !== 'codebase') return;
    try {
        let info = st.codebase || { name: 'New Code Base', version: '1.0.0', description: '', path: '' };
        let dir: string | null = asNew ? null : info.path;
        if (!dir) dir = await pickCodebaseFolderForSave();
        if (!dir) return;
        info = { ...info, path: dir };
        const a = st.assembly;
        const n = await writeCodebaseFolder(dir, info, listsOfState(), { sbom: a.sbom || [], nodes: a.networkNodes || [], edges: a.networkEdges || [] });
        useStore.setState({ codebase: info });
        setGitDir(dir);
        toast(`Code base saved: ${n} files in ${dir}`, 'success');
    } catch (e) { fail(e); }
}

const countMissingRefs = (tree: AssemblyNode[], ids: Set<string>): number =>
    tree.reduce((n, x) => n + (ids.has(x.refId) ? 0 : 1) + countMissingRefs(x.children, ids), 0);

/** Machine workspace: replace the library snapshot with the code base content. */
async function applyCodebaseToMachine(path: string, parsed: ParsedCodebase, verb: string): Promise<void> {
    // Nothing the machine already has is deleted: adjusted blocks and the machine's own blocks stay.
    const { lists, summary } = mergeFromCodebase(listsOfState(), parsed.lists);
    // hardware: only what the machine does not have yet is added (customer changes are never overwritten)
    const a0 = useStore.getState().assembly;
    const hw = mergeHardware({ sbom: a0.sbom || [], nodes: a0.networkNodes || [], edges: a0.networkEdges || [] }, parsed.hardware);
    const msg = [
        `${verb} code base "${parsed.info.name}" v${parsed.info.version}?`,
        '',
        `${hw.added} hardware / software row(s) added to the SBOM`,
        `${summary.added} new block(s) from the code base`,
        `${summary.updated} updated (not adjusted on this machine)`,
        `${summary.keptAdjusted} kept as you adjusted them${summary.adjustedNewer ? ` (${summary.adjustedNewer} also changed in the code base: review them)` : ''}`,
        `${summary.machineOnly} only on this machine, kept`,
        '',
        'Nothing of this machine is deleted.',
    ].join('\n');
    if (!confirm(msg)) return;
    const git = await gitStateOf(path);   // which exact commit the machine is taking
    const a1 = useStore.getState().assembly;
    useStore.setState({
        ...lists,
        assembly: { ...a1, sbom: hw.set.sbom, networkNodes: hw.set.nodes, networkEdges: hw.set.edges },
        codebase: { ...parsed.info, path, syncedAt: new Date().toISOString(), commit: git.commit, dirty: git.dirty },
        selectedNodeId: null,
    });
    toast(`Code base "${parsed.info.name}" v${parsed.info.version} brought in. ${summary.keptAdjusted + summary.machineOnly} block(s) of this machine kept.`, 'success');
}

/** Machine workspace: choose a code base folder to take the library from. */
export async function linkCodebase(): Promise<void> {
    try {
        const res = await openCodebaseFolder();
        if (!res) return;
        if (res.parsed.errors.length) toast(`${res.parsed.errors.length} file(s) of the code base were skipped.`, 'info');
        await applyCodebaseToMachine(res.path, res.parsed, 'Link');
    } catch (e) { fail(e); }
}

/** Machine workspace: bring the code base's reference hardware (SBOM + topology) into this machine. Adds only; deletes nothing. */
export async function hardwareFromCodebase(): Promise<void> {
    const cb = useStore.getState().codebase;
    if (!cb?.path) { toast('Link a code base first: its hardware comes from there.'); return; }
    try {
        const parsed = await readCodebaseFolder(cb.path);
        const a = useStore.getState().assembly;
        const hw = mergeHardware({ sbom: a.sbom || [], nodes: a.networkNodes || [], edges: a.networkEdges || [] }, parsed.hardware);
        if (parsed.hardware.sbom.length === 0) { toast('The code base has no hardware yet (Code base → Hardware).', 'info'); return; }
        useStore.setState({ assembly: { ...a, sbom: hw.set.sbom, networkNodes: hw.set.nodes, networkEdges: hw.set.edges } });
        toast(hw.added ? `${hw.added} hardware / software row(s) added from the code base. Yours were kept.` : 'This machine already has everything the code base lists.', 'success');
    } catch (e) { fail(e); }
}

/** Machine workspace: update the snapshot from the linked code base folder. */
export async function refreshCodebase(): Promise<void> {
    const cb = useStore.getState().codebase;
    if (!cb?.path) { toast('Link a code base first.'); return; }
    try {
        await applyCodebaseToMachine(cb.path, await readCodebaseFolder(cb.path), 'Refresh from');
    } catch (e) { fail(e); }
}
