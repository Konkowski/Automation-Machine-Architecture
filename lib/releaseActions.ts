// ============================================================
// AMA — Release actions (shared by the Release page and the block editor)
// ============================================================
import type { BlockBase } from '../types/machine';
import { useStore } from './store';
import { releaseIssues, errorsOf, type Issue } from './releaseCheck';

export interface ReleaseResult { ok: boolean; blocking: Issue[] }

/**
 * Releases a block. Fails (and says what blocks it) when a check is an error,
 * unless `acceptReason` is given: then the current errors are ACCEPTED, with the
 * reason, the user and the date, and the block is released. The acceptance is kept
 * on the block and written to its revision history.
 */
export function releaseBlock(e: BlockBase, acceptReason?: string): ReleaseResult {
    const st = useStore.getState();
    const blocking = errorsOf(releaseIssues(e, st));
    const reason = (acceptReason || '').trim();
    if (blocking.length && !reason) return { ok: false, blocking };

    const who = st.activeUser || 'AMA';
    const date = new Date().toISOString().split('T')[0];
    const patch: any = { status: 'Released' };
    if (blocking.length) {
        const accepted = new Set(blocking.map(b => b.text));
        patch.waivers = [
            ...(e.waivers || []).filter(w => !accepted.has(w.text)),
            ...blocking.map(b => ({ text: b.text, reason, by: who, date })),
        ];
    }
    st.updateEntity(e.id, e.level, patch);
    st.addRevision(e.id, {
        version: e.currentVersion, date, author: who,
        notes: `Status: ${e.status || 'Draft'} → Released${blocking.length ? ` (accepted ${blocking.length} check${blocking.length > 1 ? 's' : ''}: ${reason})` : ''}`,
    });
    return { ok: true, blocking };
}

/** Takes back the acceptance of one check. */
export function revokeAcceptance(e: BlockBase, text: string): void {
    useStore.getState().updateEntity(e.id, e.level, { waivers: (e.waivers || []).filter(w => w.text !== text) } as any);
}
