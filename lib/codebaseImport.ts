// ============================================================
// AMA — Import a PLC project (TIA Portal / Studio 5000) INTO the code base
// The blocks come in as Draft, the hardware (SBOM + topology) joins the
// code base's reference hardware. Nothing already in the code base is
// replaced: a block with the same name is skipped, a device already in
// the SBOM is not duplicated.
// ============================================================
import { useStore } from './store';
import { mergeHardware } from './hardware';

export interface CodebaseImportSummary {
    added: number; total: number; skipped: number;
    hardwareAdded: number; hardwareTotal: number;
}

/** `p` is the project an importer built (blocks + assembly with SBOM and topology). */
export function addProjectToCodebase(p: any): CodebaseImportSummary {
    const st = useStore.getState();
    const add = <T extends { name: string }>(have: T[], incoming: T[] = []): { list: T[]; added: number } => {
        const names = new Set(have.map(e => e.name));
        const fresh = incoming.filter(e => !names.has(e.name)).map(e => ({ ...e, status: 'Draft' } as T));
        return { list: [...have, ...fresh], added: fresh.length };
    };
    const lib = add(st.library, p.library), un = add(st.units, p.units),
        em = add(st.equipmentModules, p.equipmentModules), cm = add(st.controlModules, p.controlModules);

    // the code base keeps its reference hardware in the assembly object
    const a = st.assembly;
    const from = { sbom: p.assembly?.sbom || [], nodes: p.assembly?.networkNodes || [], edges: p.assembly?.networkEdges || [] };
    const hw = mergeHardware({ sbom: a.sbom || [], nodes: a.networkNodes || [], edges: a.networkEdges || [] }, from);

    useStore.setState({
        library: lib.list, units: un.list, equipmentModules: em.list, controlModules: cm.list,
        assembly: { ...a, sbom: hw.set.sbom, networkNodes: hw.set.nodes, networkEdges: hw.set.edges },
        workspaceLoaded: true,
    });
    const total = (p.library?.length || 0) + (p.units?.length || 0) + (p.equipmentModules?.length || 0) + (p.controlModules?.length || 0);
    const added = lib.added + un.added + em.added + cm.added;
    return { added, total, skipped: total - added, hardwareAdded: hw.added, hardwareTotal: from.sbom.length };
}
