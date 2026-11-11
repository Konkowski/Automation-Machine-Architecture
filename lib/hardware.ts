// ============================================================
// AMA — Hardware of a code base / machine
// SBOM rows + network topology travel together as a "hardware set".
// The Code base keeps a reference set (hardware.json); a machine
// starts from it and may differ (customer changes). Merging only ever
// ADDS what is missing: nothing already there is removed or replaced.
// ============================================================
import type { HardwareItem, BomItemType } from '../types/machine';
import { generateId } from './helpers';

export interface HardwareSet { sbom: HardwareItem[]; nodes: any[]; edges: any[] }

export const emptyHardware = (): HardwareSet => ({ sbom: [], nodes: [], edges: [] });

const norm = (x: unknown) => String(x ?? '').trim().toLowerCase();

/** Two rows are the same device when type, name, supplier code and IP match. */
export const hardwareKey = (h: HardwareItem): string =>
    [h.type || 'Hardware', h.hardware, h.supplierCode, h.ipAddress].map(norm).join('|');

/** A new, empty SBOM row. */
export function newSbomItem(type: BomItemType = 'Hardware', over: Partial<HardwareItem> = {}): HardwareItem {
    return { id: generateId(), type, hardware: '', firmware: '', quantity: 1, notes: '', ipAddress: '', ...over };
}

/** Add to `into` what `from` has and `into` lacks (rows, their places on the map and the links between them). */
export function mergeHardware(into: HardwareSet, from: HardwareSet): { set: HardwareSet; added: number } {
    const sbom = [...into.sbom];
    const nodes = [...into.nodes];
    const edges = [...into.edges];
    const byKey = new Map(sbom.map(h => [hardwareKey(h), h.id] as const));
    const usedIds = new Set(sbom.map(h => h.id));
    const idMap = new Map<string, string>();          // from-row id -> row id in the result
    let added = 0;

    for (const h of from.sbom || []) {
        const key = hardwareKey(h);
        const same = byKey.get(key);
        if (same) { idMap.set(h.id, same); continue; }
        const id = usedIds.has(h.id) ? generateId() : h.id;
        sbom.push({ ...h, id });
        usedIds.add(id); byKey.set(key, id); idMap.set(h.id, id);
        added++;
    }

    const placed = new Set(nodes.map(n => n.sbomId));
    const nodeIds = new Set(nodes.map(n => n.id));
    const nodeMap = new Map<string, string>();        // from-node id -> node id in the result
    for (const n of from.nodes || []) {
        const sbomId = idMap.get(n.sbomId);
        if (!sbomId) continue;
        const existing = nodes.find(x => x.sbomId === sbomId);
        if (existing) { nodeMap.set(n.id, existing.id); continue; }
        if (placed.has(sbomId)) continue;
        const id = nodeIds.has(n.id) ? generateId() : n.id;
        nodes.push({ ...n, id, sbomId });
        nodeIds.add(id); placed.add(sbomId); nodeMap.set(n.id, id);
    }
    const haveEdge = new Set(edges.map(e => `${e.source}>${e.target}`));
    const edgeIds = new Set(edges.map(e => e.id));
    for (const e of from.edges || []) {
        const s = nodeMap.get(e.source), t = nodeMap.get(e.target);
        if (!s || !t || s === t || haveEdge.has(`${s}>${t}`) || haveEdge.has(`${t}>${s}`)) continue;
        edges.push({ ...e, id: edgeIds.has(e.id) ? generateId() : e.id, source: s, target: t });
        haveEdge.add(`${s}>${t}`);
    }
    return { set: { sbom, nodes, edges }, added };
}

/** Read hardware.json (tolerant: a missing or broken file is just "no hardware"). */
export function parseHardware(text: string | undefined): HardwareSet {
    if (!text) return emptyHardware();
    try {
        const j = JSON.parse(text);
        const sbom = (Array.isArray(j.sbom) ? j.sbom : []).filter((h: any) => h && typeof h === 'object').map((h: any) => ({
            ...h, id: h.id || generateId(), type: h.type || 'Hardware', hardware: h.hardware || '', firmware: h.firmware || '',
            quantity: Number.isFinite(h.quantity) ? h.quantity : 1, notes: h.notes || '',
        })) as HardwareItem[];
        return { sbom, nodes: Array.isArray(j.nodes) ? j.nodes : [], edges: Array.isArray(j.edges) ? j.edges : [] };
    } catch { return emptyHardware(); }
}

/** What the code base keeps of the hardware: everything a machine needs to start from it. */
export const hardwareFile = (h: HardwareSet) => ({ kind: 'hardware', sbom: h.sbom, nodes: h.nodes, edges: h.edges });
