// ============================================================
// AMA — Machine page (step 1 of the Machine workspace)
//   - nothing yet: three clear ways to begin
//   - always: machine identity, the linked code base, and a
//     "what is done / what is next" list
// Actions live in the ribbon; the start cards just trigger the same commands.
// ============================================================
import React, { useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link2, FolderOpen, Download, Check, Circle, ArrowRight, RefreshCw } from 'lucide-react';
import { useStore } from '../lib/store';
import { runCommandWhenReady } from '../lib/commands';
import { isAdjusted, isMachineOnly } from '../lib/deviation';

const countAssembled = (nodes: { children?: any[] }[]): number =>
    nodes.reduce((n, x) => n + 1 + countAssembled(x.children || []), 0);

export const ProjectPage: React.FC = () => {
    const navigate = useNavigate();
    const assembly = useStore(s => s.assembly);
    const codebase = useStore(s => s.codebase);
    const units = useStore(s => s.units);
    const ems = useStore(s => s.equipmentModules);
    const cms = useStore(s => s.controlModules);
    const library = useStore(s => s.library);
    const updateAssemblyMeta = useStore(s => s.updateAssemblyMeta);

    const [name, setName] = useState(assembly.name);
    const [desc, setDesc] = useState(assembly.description);
    const [version, setVersion] = useState(assembly.version);
    useEffect(() => { setName(assembly.name); setDesc(assembly.description); setVersion(assembly.version); }, [assembly.id, assembly.name, assembly.description, assembly.version]);

    const all = useMemo(() => [...units, ...ems, ...cms, ...library], [units, ems, cms, library]);
    const released = all.filter(e => e.origin === 'codebase' && e.status === 'Released').length;
    const adjustedCount = all.filter(isAdjusted).length;
    const machineOnlyCount = all.filter(isMachineOnly).length;
    const assembled = useMemo(() => countAssembled(assembly.tree as any[]), [assembly.tree]);
    const empty = all.length === 0 && !codebase;
    const dirty = name !== assembly.name || desc !== assembly.description || version !== assembly.version;

    const steps: { done: boolean; title: string; hint: string; to: string; label: string }[] = [
        { done: !!assembly.name && assembly.name !== 'New Machine' && assembly.name !== 'No Project', title: 'Name the machine', hint: 'Above: name, description and version.', to: '/project', label: 'Machine' },
        { done: !!codebase, title: 'Link the code base', hint: 'The library of blocks this machine is built from.', to: '/project', label: 'Machine' },
        { done: assembled > 0, title: 'Assemble the machine', hint: 'Drag Released blocks into the tree and check hardware and network.', to: '/assembly', label: 'Assembly' },
        { done: false, title: 'Verify and export the PLC code', hint: 'Check the errors, then generate L5X, TIA Portal and the documents.', to: '/export', label: 'Verify and export' },
    ];
    const current = steps.findIndex(s => !s.done);

    return (
        <div className="project-page">
            {empty && (
                <section>
                    <h1>How do you want to start?</h1>
                    <p className="project-lead">A machine is assembled from a code base: the reusable blocks kept in a Git repository.</p>
                    <div className="start-cards">
                        <button className="start-card" onClick={() => runCommandWhenReady('machine:link-codebase')}>
                            <Link2 size={30} />
                            <h3>Link a code base</h3>
                            <p>Pick the code base folder and assemble a new machine from its Released blocks.</p>
                        </button>
                        <button className="start-card" onClick={() => runCommandWhenReady('file:open')}>
                            <FolderOpen size={30} />
                            <h3>Open a saved machine</h3>
                            <p>AMA JSON file or ZIP exported for Git.</p>
                        </button>
                        <button className="start-card" onClick={() => runCommandWhenReady('data:import-l5x')}>
                            <Download size={30} />
                            <h3>Import from Studio 5000</h3>
                            <p>Creates a machine from an .L5X file: programs, tags, I/O, alarms and hardware.</p>
                        </button>
                        <button className="start-card" onClick={() => runCommandWhenReady('data:import-tia')}>
                            <Download size={30} />
                            <h3>Import from TIA Portal</h3>
                            <p>Creates a machine from a TIA Portal project: blocks, tags, I/O, alarms and hardware.</p>
                        </button>
                    </div>
                </section>
            )}

            <section className="project-card">
                <h2>The machine</h2>
                <div className="project-form">
                    <label>Name<input className="input" value={name} onChange={e => setName(e.target.value)} /></label>
                    <label>Version<input className="input" value={version} onChange={e => setVersion(e.target.value)} /></label>
                    <label className="wide">Description<textarea className="input" rows={3} value={desc} onChange={e => setDesc(e.target.value)} /></label>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
                    <button
                        className="btn btn-primary btn-sm"
                        disabled={!dirty || !name.trim()}
                        onClick={() => updateAssemblyMeta({ name: name.trim(), description: desc, version: version.trim() || '1.0.0' })}
                    >Save details</button>
                    <span className="project-counts">{assembled} blocks in the tree</span>
                </div>
            </section>

            <section className="project-card">
                <h2>Code base</h2>
                {codebase ? (
                    <>
                        <div className="cb-line"><strong>{codebase.name}</strong> <span className="project-counts">v{codebase.version}</span></div>
                        <div className="cb-path" title={codebase.path}>{codebase.path}</div>
                        <div className="project-counts" style={{ marginTop: 6 }}>
                            {all.length} blocks · {released} Released in the code base · {adjustedCount} adjusted on this machine · {machineOnlyCount} only on this machine
                            {codebase.syncedAt ? ` · taken on ${new Date(codebase.syncedAt).toLocaleString()}` : ''}
                        </div>
                        <div className="project-counts" style={{ marginTop: 4 }}>
                            {codebase.commit
                                ? <>Commit <code>{codebase.commit.slice(0, 8)}</code>{codebase.dirty ? <span style={{ color: 'var(--orange)' }}> · with uncommitted changes</span> : null}</>
                                : 'No Git commit recorded: commit the code base in its Release step, then refresh.'}
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                            <button className="btn btn-secondary btn-sm" onClick={() => runCommandWhenReady('machine:refresh-codebase')}>
                                <RefreshCw size={13} /> Refresh from the code base
                            </button>
                            <button className="btn btn-secondary btn-sm" onClick={() => runCommandWhenReady('machine:link-codebase')}>
                                <Link2 size={13} /> Use another code base
                            </button>
                        </div>
                    </>
                ) : (
                    <p className="project-lead" style={{ margin: 0 }}>
                        No code base linked. Without one, every block already in this project can be assembled.
                        Link a code base to work with released, versioned blocks only.
                    </p>
                )}
            </section>

            <section className="project-card">
                <h2>What to do</h2>
                <ol className="todo-list">
                    {steps.map((s, i) => (
                        <li key={s.title} className={`${s.done ? 'done' : ''} ${i === current ? 'current' : ''}`}>
                            <span className="todo-mark">{s.done ? <Check size={14} /> : <Circle size={10} />}</span>
                            <div style={{ flex: 1 }}>
                                <div className="todo-title">{s.title}</div>
                                <div className="todo-hint">{s.hint}</div>
                            </div>
                            {i === current && s.to !== '/project' && (
                                <button className="btn btn-primary btn-sm" onClick={() => navigate(s.to)}>
                                    Go to {s.label} <ArrowRight size={13} />
                                </button>
                            )}
                        </li>
                    ))}
                </ol>
            </section>
        </div>
    );
};
