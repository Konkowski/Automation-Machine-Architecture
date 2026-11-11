// ============================================================
// AMA — Release checks
// A block can only become Released when it is complete and safe to
// reuse. Errors block the release, but the Product Owner can ACCEPT
// them with a written reason (the check may be wrong for this block):
// accepted checks stay visible, with who accepted them and why.
// Warnings are shown but never block.
// Pure functions: the same rules run in the Release page, the block
// editor and the tests.
// ============================================================
import type { BlockBase, EntityStatus } from '../types/machine';
import { isMitigated, RPN_ATTENTION, RPN_CRITICAL } from './dfmeaGuide';

export interface EntityLists {
    library: BlockBase[];
    units: BlockBase[];
    equipmentModules: BlockBase[];
    controlModules: BlockBase[];
}

/** Editor tab where a check can be looked at / fixed. */
export type IssueTab = 'info' | 'fbs' | 'variables' | 'code' | 'alarms' | 'io' | 'dfmea' | 'bom';

export interface Issue {
    /** 'accepted' = it was an error or a warning that the Product Owner accepted. */
    severity: 'error' | 'warning' | 'accepted';
    text: string;
    /** Where to go to see it: the editor tab of the block (or of `targetId`). */
    tab?: IssueTab;
    /** Another block is the place to look at (e.g. the unreleased child). */
    targetId?: string;
    /** A row inside the tab (e.g. the DFMEA entry), highlighted when opened. */
    itemId?: string;
    /** Accepted checks: what it was, who accepted it, why. */
    was?: 'error' | 'warning';
    reason?: string;
    by?: string;
    date?: string;
}

const PHYSICAL: BlockBase['category'][] = ['Motion', 'Valve', 'Sensor'];

const childIds = (e: BlockBase): string[] => {
    const a = e as any;
    return [...(a.assignedFBs || []), ...(a.assignedEMs || []), ...(a.assignedCMs || [])];
};

/** Everything that stops (error), should worry (warning) or was accepted for a release of this block. */
export function releaseIssues(e: BlockBase, lists: EntityLists): Issue[] {
    const out: Issue[] = [];
    const err = (text: string, where: Partial<Issue> = {}) => out.push({ severity: 'error', text, ...where });
    const warn = (text: string, where: Partial<Issue> = {}) => out.push({ severity: 'warning', text, ...where });
    const all = [...lists.library, ...lists.units, ...lists.equipmentModules, ...lists.controlModules];
    const byId = new Map(all.map(x => [x.id, x]));

    if (!(e.description || '').trim()) err('No description: say what the block does.', { tab: 'info' });
    if (!(e.currentVersion || '').trim()) err('No version.', { tab: 'info' });

    const kids = childIds(e).map(id => byId.get(id)).filter(Boolean) as BlockBase[];
    const hasCode = !!(e.code || '').trim();
    if ((e.level === 'CM' || e.level === 'FB') && !hasCode) err('No code.', { tab: 'code' });
    if ((e.level === 'UN' || e.level === 'EM') && !hasCode && kids.length === 0) err('Empty: no code and no blocks assigned to it.', { tab: 'fbs' });

    for (const k of kids) {
        const st: EntityStatus = k.status || 'Draft';
        if (st !== 'Released') err(`Uses ${k.level} "${k.name}" which is ${st}: release it first.`, { targetId: k.id, tab: 'info' });
    }

    // DFMEA: where the Product Owner must have answered
    const dfmea = e.dfmea || [];
    for (const d of dfmea) {
        if (isMitigated(d)) continue;
        if (d.rpn >= RPN_CRITICAL) err(`DFMEA "${d.failureMode}": RPN ${d.rpn} is critical and not implemented.`, { tab: 'dfmea', itemId: d.id });
        else if (d.rpn >= RPN_ATTENTION) warn(`DFMEA "${d.failureMode}": RPN ${d.rpn}, not implemented yet.`, { tab: 'dfmea', itemId: d.id });
    }
    for (const d of dfmea) {
        if (d.rpn >= RPN_ATTENTION && !(e.alarms || []).some(a => a.id === d.alarmId)) {
            warn(`DFMEA "${d.failureMode}": no alarm linked to a high-RPN failure.`, { tab: 'dfmea', itemId: d.id });
        }
        if (d.componentId && !(e.bom || []).some(p => p.id === d.componentId)) warn(`DFMEA "${d.failureMode}": linked component no longer exists.`, { tab: 'dfmea', itemId: d.id });
    }

    // Physical blocks should describe their hardware side
    if (PHYSICAL.includes(e.category) && (e.level === 'CM' || e.level === 'FB')) {
        if (!(e.io || []).length) warn('A physical block with no I/O signals.', { tab: 'io' });
        if (!(e.alarms || []).length) warn('A physical block with no alarms.', { tab: 'alarms' });
        if (e.level === 'CM' && !(e.bom || []).length) warn('No components (BOM) registered.', { tab: 'bom' });
    }

    // Accepted by the Product Owner: still listed, no longer blocking
    const waivers = e.waivers || [];
    return out.map(i => {
        const w = waivers.find(x => x.text === i.text);
        return w ? { ...i, severity: 'accepted' as const, was: i.severity as 'error' | 'warning', reason: w.reason, by: w.by, date: w.date } : i;
    });
}

export const errorsOf = (issues: Issue[]): Issue[] => issues.filter(i => i.severity === 'error');

/** x.y.z -> x.y.(z+1); x.y -> x.(y+1). */
export function bumpVersion(v: string): string {
    const parts = (v || '1.0').split('.').map(n => parseInt(n, 10) || 0);
    parts[parts.length - 1]++;
    return parts.join('.');
}

/** Fields that are bookkeeping: changing only these never "modifies" a Released block. */
export const META_KEYS = new Set(['revisions', 'lastModifiedBy', 'status', 'waivers']);
