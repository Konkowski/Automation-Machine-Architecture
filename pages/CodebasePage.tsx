// ============================================================
// AMA — Code base page (step 1 of the Code base workspace)
// The code base is the reusable library kept in a Git repository.
// ============================================================
import React, { useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderOpen, Save, Check, Circle, ArrowRight } from 'lucide-react';
import { useStore } from '../lib/store';
import { runCommandWhenReady } from '../lib/commands';
import { statusCounts } from '../lib/codebase';

const BLANK = { name: 'New Code Base', version: '1.0.0', description: '', path: '' };

export const CodebasePage: React.FC = () => {
    const navigate = useNavigate();
    const codebase = useStore(s => s.codebase);
    const setCodebase = useStore(s => s.setCodebase);
    const units = useStore(s => s.units);
    const ems = useStore(s => s.equipmentModules);
    const cms = useStore(s => s.controlModules);
    const library = useStore(s => s.library);

    const info = codebase || BLANK;
    const [name, setName] = useState(info.name);
    const [version, setVersion] = useState(info.version);
    const [desc, setDesc] = useState(info.description);
    useEffect(() => { setName(info.name); setVersion(info.version); setDesc(info.description); }, [info.name, info.version, info.description]);

    const counts = useMemo(() => statusCounts({ library, units, equipmentModules: ems, controlModules: cms }), [library, units, ems, cms]);
    const total = units.length + ems.length + cms.length + library.length;
    const dirty = name !== info.name || version !== info.version || desc !== info.description;

    const steps = [
        { done: !!info.path, title: 'Choose the code base folder', hint: 'A folder that is (or will become) a Git repository on the company server or the customer PC.' },
        { done: total > 0, title: 'Build the reusable blocks', hint: 'Units, Equipment Modules, Control Modules and Function Blocks, with code, components and DFMEA.', to: '/', label: 'Architecture' },
        { done: total > 0 && ![...units, ...ems, ...cms, ...library].some(e => (e.dfmea || []).some(d => d.rpn >= 200 && d.status !== 'Implemented' && d.status !== 'Verified'))
            && [...units, ...ems, ...cms, ...library].some(e => (e.dfmea || []).length > 0),
          title: 'Review the risks', hint: 'The DFMEA says where blocks and components need attention. Close the critical failures.', to: '/risk', label: 'Risk' },
        { done: counts.Released > 0, title: 'Release the stable blocks', hint: 'Only blocks that pass the release checks can be Released and used by a machine.', to: '/release', label: 'Release' },
        { done: false, title: 'Commit the code base', hint: 'Save it to the folder and commit it to Git, so machines can take that version.', to: '/release', label: 'Release' },
    ];
    const current = steps.findIndex(s => !s.done);

    return (
        <div className="project-page">
            {total === 0 && !info.path && (
                <section>
                    <h1>The code base</h1>
                    <p className="project-lead">
                        The code base is the reusable architecture: ISA-88 blocks with their code, components and DFMEA.
                        You build it once, release it, and every machine is assembled from it.
                    </p>
                    <div className="start-cards">
                        <button className="start-card" onClick={() => runCommandWhenReady('codebase:open')}>
                            <FolderOpen size={30} />
                            <h3>Open a code base folder</h3>
                            <p>Pick the repository folder. An empty folder starts a new code base.</p>
                        </button>
                        <button className="start-card" onClick={() => navigate('/')}>
                            <Save size={30} />
                            <h3>Start from scratch</h3>
                            <p>Build the first blocks in Architecture and choose the folder when you save.</p>
                        </button>
                    </div>
                </section>
            )}

            <section className="project-card">
                <h2>The code base</h2>
                <div className="project-form">
                    <label>Name<input className="input" value={name} onChange={e => setName(e.target.value)} /></label>
                    <label>Version<input className="input" value={version} onChange={e => setVersion(e.target.value)} /></label>
                    <label className="wide">Description<textarea className="input" rows={3} value={desc} onChange={e => setDesc(e.target.value)} /></label>
                </div>
                <div className="cb-path" title={info.path} style={{ marginTop: 12 }}>
                    {info.path || 'No folder yet: it is chosen the first time you save.'}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => runCommandWhenReady('codebase:open')}>
                        <FolderOpen size={13} /> Open a code base folder…
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={() => runCommandWhenReady('data:import-tia')}>
                        Import blocks from TIA Portal…
                    </button>
                    <button className="btn btn-primary btn-sm"
                        disabled={!dirty || !name.trim()}
                        onClick={() => setCodebase({ ...info, name: name.trim(), version: version.trim() || '1.0.0', description: desc })}
                    >Save details</button>
                    <span className="project-counts">
                        {units.length} UN · {ems.length} EM · {cms.length} CM · {library.length} FB
                        {' · '}{counts.Released} Released · {counts['In Review']} In Review · {counts.Draft} Draft
                    </span>
                </div>
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
                            {i === current && s.to && (
                                <button className="btn btn-primary btn-sm" onClick={() => navigate(s.to!)}>
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
