// ============================================================
// AMA — Release page (step 3 of the Code base workspace)
// Review the blocks, release the stable ones (a machine can only
// assemble Released blocks), then save and commit the code base.
// ============================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { GitCommit, CheckCircle } from 'lucide-react';
import { useStore } from '../lib/store';
import { saveCodebase } from '../lib/codebaseActions';
import { gitAvailable, gitRun, gitEnsureIdentity } from '../lib/gitOps';
import { toast } from '../components/Toaster';
import { releaseIssues, errorsOf, type Issue } from '../lib/releaseCheck';
import { releaseBlock } from '../lib/releaseActions';
import { ReleaseIssues } from '../components/ReleaseIssues';
import type { BlockBase, EntityLevel, EntityStatus } from '../types/machine';

const STATUSES: EntityStatus[] = ['Draft', 'In Review', 'Released', 'Deprecated'];
const LEVELS: EntityLevel[] = ['UN', 'EM', 'CM', 'FB'];


export const ReleasePage: React.FC = () => {
    const units = useStore(s => s.units);
    const ems = useStore(s => s.equipmentModules);
    const cms = useStore(s => s.controlModules);
    const library = useStore(s => s.library);
    const codebase = useStore(s => s.codebase);
    const activeUser = useStore(s => s.activeUser);
    const updateEntity = useStore(s => s.updateEntity);
    const addRevision = useStore(s => s.addRevision);

    const [levelFilter, setLevelFilter] = useState<'all' | EntityLevel>('all');
    const [statusFilter, setStatusFilter] = useState<'all' | EntityStatus>('all');
    const [message, setMessage] = useState('');
    const [repo, setRepo] = useState<{ isRepo: boolean; status: string; log: string } | null>(null);
    const [busy, setBusy] = useState(false);

    const rows = useMemo(() => {
        const all: BlockBase[] = [...units, ...ems, ...cms, ...library];
        return all.filter(e =>
            (levelFilter === 'all' || e.level === levelFilter) &&
            (statusFilter === 'all' || (e.status || 'Draft') === statusFilter));
    }, [units, ems, cms, library, levelFilter, statusFilter]);

    const issuesOf = useMemo(() => {
        const lists = { library, units, equipmentModules: ems, controlModules: cms };
        const map = new Map<string, Issue[]>();
        for (const e of [...units, ...ems, ...cms, ...library]) map.set(e.id, releaseIssues(e, lists));
        return map;
    }, [units, ems, cms, library]);
    const [open, setOpen] = useState<string | null>(null);

    /** Returns false (and says why) when the release checks block the change. */
    const setStatus = (e: BlockBase, status: EntityStatus): boolean => {
        if ((e.status || 'Draft') === status) return true;
        if (status === 'Released') {
            const res = releaseBlock(e);
            if (!res.ok) {
                setOpen(e.id);
                toast(`"${e.name}" has ${res.blocking.length} error${res.blocking.length > 1 ? 's' : ''}: see below where each one is, fix it, or release it anyway with a reason.`, 'error');
            }
            return res.ok;
        }
        updateEntity(e.id, e.level, { status });
        addRevision(e.id, {
            version: e.currentVersion, date: new Date().toISOString().split('T')[0],
            author: activeUser || 'AMA', notes: `Status: ${e.status || 'Draft'} → ${status}`,
        });
        return true;
    };

    const releaseAllInReview = () => {
        const inReview = () => { const s = useStore.getState(); return [...s.units, ...s.equipmentModules, ...s.controlModules, ...s.library].filter(e => e.status === 'In Review'); };
        const total = inReview().length;
        if (!total) { toast('No block is In Review.'); return; }
        if (!confirm(`Release the blocks In Review that pass all checks (${total} waiting)?`)) return;
        // children first: a parent only passes once the blocks it uses are Released
        let released = 0;
        for (let pass = 0; pass < 4; pass++) {
            let progress = false;
            for (const e of inReview()) {
                const st = useStore.getState();
                if (errorsOf(releaseIssues(e, st)).length) continue;
                if (setStatus(e, 'Released')) { released++; progress = true; }
            }
            if (!progress) break;
        }
        const left = inReview().length;
        toast(`${released} block(s) released.${left ? ` ${left} still have errors: open their checks below.` : ''}`, left ? 'info' : 'success');
    };

    const refreshRepo = useCallback(async () => {
        if (!gitAvailable() || !codebase?.path) { setRepo(null); return; }
        const inside = await gitRun(['rev-parse', '--is-inside-work-tree']);
        if (!inside.ok || !inside.stdout.trim().startsWith('true')) { setRepo({ isRepo: false, status: '', log: '' }); return; }
        const [st, lg] = await Promise.all([gitRun(['status', '--short', '-b']), gitRun(['log', '--oneline', '-5'])]);
        setRepo({ isRepo: true, status: st.stdout.trim(), log: lg.stdout.trim() });
    }, [codebase?.path]);
    useEffect(() => { refreshRepo(); }, [refreshRepo]);

    const commit = async () => {
        if (!message.trim()) { toast('Write a commit message first.'); return; }
        setBusy(true);
        try {
            await saveCodebase();
            const path = useStore.getState().codebase?.path;
            if (!path) return;
            const inside = await gitRun(['rev-parse', '--is-inside-work-tree']);
            if (!inside.ok || !inside.stdout.trim().startsWith('true')) {
                if (!confirm('This folder is not a Git repository yet. Initialize one?')) return;
                const init = await gitRun(['init']);
                if (!init.ok) { toast(init.error || init.stderr || 'git init failed.'); return; }
                await gitRun(['symbolic-ref', 'HEAD', 'refs/heads/main']);
            }
            await gitEnsureIdentity();
            const add = await gitRun(['add', '-A']);
            if (!add.ok) { toast(add.error || add.stderr || 'git add failed.'); return; }
            const res = await gitRun(['commit', '-m', message.trim()]);
            if (res.ok) { toast('Code base committed.', 'success'); setMessage(''); }
            else if (/nothing to commit/i.test(res.stdout + res.stderr)) toast('Nothing to commit: the code base is unchanged.');
            else toast(res.error || res.stderr || res.stdout || 'git commit failed.');
        } finally {
            setBusy(false);
            refreshRepo();
        }
    };

    return (
        <div className="project-page">
            <section>
                <h1>Release</h1>
                <p className="project-lead">
                    Only <strong>Released</strong> blocks can be assembled into a machine. A block can be Released only when it passes the
                    checks below (description, code, released children, no critical DFMEA left open). Editing a Released block takes it back to Draft.
                    Every change is logged in the block's revision history.
                </p>
            </section>

            <section className="project-card">
                <div className="release-filters">
                    <select className="input input-sm" value={levelFilter} onChange={e => setLevelFilter(e.target.value as any)}>
                        <option value="all">All levels</option>
                        {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                    <select className="input input-sm" value={statusFilter} onChange={e => setStatusFilter(e.target.value as any)}>
                        <option value="all">All statuses</option>
                        {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <span style={{ flex: 1 }} />
                    <button className="btn btn-secondary btn-sm" onClick={releaseAllInReview}><CheckCircle size={13} /> Release all In Review</button>
                </div>
                <table className="release-table">
                    <thead>
                        <tr><th>Level</th><th>Name</th><th>Version</th><th>Checks</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                        {rows.length === 0 && <tr><td colSpan={5} style={{ color: 'var(--text-muted)', padding: 14 }}>No blocks match.</td></tr>}
                        {rows.map(e => {
                            const issues = issuesOf.get(e.id) || [];
                            const errs = issues.filter(i => i.severity === 'error').length;
                            const accepted = issues.filter(i => i.severity === 'accepted').length;
                            const warns = issues.length - errs - accepted;
                            return (
                                <React.Fragment key={e.id}>
                                    <tr>
                                        <td><span className={`badge badge-${e.level.toLowerCase()}`}>{e.level}</span></td>
                                        <td title={e.description}>{e.name}</td>
                                        <td>v{e.currentVersion}</td>
                                        <td>
                                            {issues.length === 0 || (errs === 0 && warns === 0 && accepted === 0)
                                                ? <span style={{ color: 'var(--green, #3fb950)' }}>Ready</span>
                                                : <button className="btn btn-ghost btn-sm" onClick={() => setOpen(open === e.id ? null : e.id)}>
                                                    {errs > 0 && <span style={{ color: 'var(--red)' }}>{errs} error{errs > 1 ? 's' : ''}</span>}
                                                    {errs > 0 && warns > 0 && ' · '}
                                                    {warns > 0 && <span style={{ color: 'var(--yellow, #d29922)' }}>{warns} warning{warns > 1 ? 's' : ''}</span>}
                                                    {accepted > 0 && <span style={{ color: 'var(--text-muted)' }}>{errs + warns > 0 ? ' · ' : ''}{accepted} accepted</span>}
                                                </button>}
                                        </td>
                                        <td>
                                            <select className="input input-sm" value={e.status || 'Draft'} onChange={ev => { if (!setStatus(e, ev.target.value as EntityStatus)) ev.target.value = e.status || 'Draft'; }}>
                                                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                                            </select>
                                        </td>
                                    </tr>
                                    {open === e.id && issues.length > 0 && (
                                        <tr className="release-issues-row">
                                            <td colSpan={5}>
                                                <ReleaseIssues block={e} />
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </tbody>
                </table>
            </section>

            <section className="project-card">
                <h2>Commit the code base</h2>
                {!gitAvailable() ? (
                    <p className="project-lead" style={{ margin: 0 }}>Git is only available in the desktop app.</p>
                ) : (
                    <>
                        <div className="cb-path" title={codebase?.path}>{codebase?.path || 'No folder yet: it is chosen when you commit.'}</div>
                        {repo && !repo.isRepo && <p className="project-counts" style={{ marginTop: 8 }}>This folder is not a Git repository yet; it will be initialized on the first commit.</p>}
                        {repo?.isRepo && <pre className="release-git">{repo.status}{repo.log ? `\n\n${repo.log}` : ''}</pre>}
                        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                            <input
                                className="input" placeholder="Commit message, e.g. Release EM_Capping v1.2"
                                value={message} onChange={e => setMessage(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') commit(); }}
                            />
                            <button className="btn btn-primary" onClick={commit} disabled={busy}>
                                <GitCommit size={14} /> Save and commit
                            </button>
                        </div>
                    </>
                )}
            </section>
        </div>
    );
};
