// ============================================================
// AMA — EntityEditor (7-tab editor for Architecture entities)
// ============================================================
import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useStore } from '../lib/store';
import { Modal } from './Modal';
import { toast } from './Toaster';
import { generateId, calculateRPN, generateFBCallingCode, findEntityUsages } from '../lib/helpers';
import { releaseBlock } from '../lib/releaseActions';
import { ReleaseIssues } from './ReleaseIssues';
import { suggestFor, rpnBand, needsAttention } from '../lib/dfmeaGuide';
import Editor from '@monaco-editor/react';
import { ST_LANGUAGE_ID, stLanguageConfig, stTokensProvider, stTheme } from '../lib/stLanguage';
import type {
    BlockBase, Variable, Alarm, IOSignal, DFMEAEntry, Revision,
    DataType, VariableScope, AlarmLevel, AlarmAction, SignalType, DFMEAStatus,
    FunctionBlock, DevTimes, BomPart, BomItemType, EntityStatus, EntityPatch
} from '../types/machine';
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

(self as any).MonacoEnvironment = {
    getWorker(_: any, label: string) {
        return new editorWorker();
    }
};

// Use the local monaco-editor bundle instead of fetching from CDN
// This ensures the Code space works correctly in offline environments.
loader.config({ monaco });
import {
    FileText, Code, AlertTriangle, Radio, Shield, Clock, Plus, Trash2, Wand2, Link, GitCommit,
    CheckSquare, Timer, Pencil, Package, Lock, Unlock, ShieldCheck, ArrowUpRight, GitBranch
} from 'lucide-react';

// ─── Library lifecycle ──────────────────────────────────────
const STATUS_FLOW: EntityStatus[] = ['Draft', 'In Review', 'Released', 'Deprecated'];
const STATUS_META: Record<EntityStatus, { color: string; label: string }> = {
    'Draft': { color: 'var(--text-muted)', label: 'Draft' },
    'In Review': { color: 'var(--yellow)', label: 'In Review' },
    'Released': { color: 'var(--em-color)', label: 'Released' },
    'Deprecated': { color: 'var(--red)', label: 'Deprecated' },
};

type TabId = 'info' | 'fbs' | 'variables' | 'alarms' | 'io' | 'dfmea' | 'code' | 'revisions' | 'bom';

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: 'info', label: 'Info', icon: <FileText size={14} /> },
    { id: 'fbs', label: 'Sub-Items', icon: <Code size={14} /> },
    { id: 'variables', label: 'Variables', icon: <Code size={14} /> },
    { id: 'code', label: 'Code', icon: <Code size={14} /> },
    { id: 'alarms', label: 'Alarms', icon: <AlertTriangle size={14} /> },
    { id: 'io', label: 'I/O', icon: <Radio size={14} /> },
    { id: 'dfmea', label: 'DFMEA', icon: <Shield size={14} /> },
    { id: 'bom', label: 'BOM', icon: <Package size={14} /> },
    { id: 'revisions', label: 'Revisions', icon: <Clock size={14} /> },
];

const DATA_TYPES: DataType[] = ['BOOL', 'INT', 'DINT', 'REAL', 'LREAL', 'STRING', 'TIME', 'WORD', 'DWORD', 'System', 'UINT', 'ARRAY OF', 'Union OF', 'Other'];
const SCOPES: VariableScope[] = ['Input', 'Output', 'InOut', 'Local'];
const ALARM_LEVELS: AlarmLevel[] = ['Warning', 'Alarm', 'Fault', 'Safety'];
const ALARM_ACTIONS: AlarmAction[] = ['Stop', 'AutoReset', 'EmergencyStop', 'Log'];
const SIGNAL_TYPES: SignalType[] = ['DI', 'DO', 'AI', 'AO', 'Frequency'];
const DFMEA_STATUSES: DFMEAStatus[] = ['To Do', 'In Progress', 'Implemented', 'Verified'];
const BOM_TYPES: BomItemType[] = ['Hardware', 'Software', 'Network', 'Service', 'Security'];

interface EntityEditorProps {
    block: BlockBase;
    isLibrary?: boolean;
}

export const EntityEditor: React.FC<EntityEditorProps> = ({ block, isLibrary = false }) => {
    const tab = useStore(s => s.selectedTab) as TabId;
    const focusItem = useStore(s => s.focusItem);
    React.useEffect(() => {
        if (focusItem) setTimeout(() => document.getElementById(`dfmea-${focusItem}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 120);
    }, [focusItem, tab]);
    const setTab = useStore(s => s.setTab);
    const updateEntity = useStore(s => s.updateEntity);
    const updateFB = useStore(s => s.updateFB);
    const addFB = useStore(s => s.addFB); // to create new FBs
    const addVariable = useStore(s => s.addVariable);
    const deleteVariable = useStore(s => s.deleteVariable);
    const addAlarm = useStore(s => s.addAlarm);
    const deleteAlarm = useStore(s => s.deleteAlarm);
    const addIO = useStore(s => s.addIO);
    const deleteIO = useStore(s => s.deleteIO);
    const addDFMEA = useStore(s => s.addDFMEA);
    const deleteDFMEA = useStore(s => s.deleteDFMEA);
    const addRevision = useStore(s => s.addRevision);
    const library = useStore(s => s.library);
    const units = useStore(s => s.units);
    const equipmentModules = useStore(s => s.equipmentModules);
    const controlModules = useStore(s => s.controlModules);
    const assembly = useStore(s => s.assembly);
    const activeUser = useStore(s => s.activeUser);
    const selectNode = useStore(s => s.selectNode);
    const setArchTab = useStore(s => s.setArchTab);

    // DevTimes actions
    const updateDevTimes = useStore(s => s.updateDevTimes);

    const updateVariable = useStore(s => s.updateVariable);
    const updateAlarm = useStore(s => s.updateAlarm);
    const updateIO = useStore(s => s.updateIO);
    const updateDFMEA = useStore(s => s.updateDFMEA);

    const [editingVariable, setEditingVariable] = useState<Variable | null>(null);
    const [editingAlarm, setEditingAlarm] = useState<Alarm | null>(null);
    const [editingIO, setEditingIO] = useState<IOSignal | null>(null);
    const [editingDFMEA, setEditingDFMEA] = useState<DFMEAEntry | null>(null);

    const [showAddVar, setShowAddVar] = useState(false);
    const [showAddAlarm, setShowAddAlarm] = useState(false);
    const [showAddIO, setShowAddIO] = useState(false);
    const [showAddDFMEA, setShowAddDFMEA] = useState(false);
    const [showAddRevision, setShowAddRevision] = useState(false);
    const [newRevisionNotes, setNewRevisionNotes] = useState('');

    const editorRef = React.useRef<any>(null);

    useEffect(() => {
        if (editorRef.current) {
            const currentValue = editorRef.current.getValue();
            if (currentValue !== block.code) {
                editorRef.current.setValue(block.code || '');
            }
        }
    }, [block.code]);

    // Code edits are committed to the store debounced: pushing every
    // keystroke re-clones the entity list and re-renders every subscriber,
    // which does not scale to real PLC code blocks. The pending value is
    // flushed when the user switches block (cleanup below runs with the
    // previous block's `update` closure, so it lands on the right entity).
    const codeDebounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingCodeRef = React.useRef<string | null>(null);

    // ─── Library lifecycle / lock ───────────────────────────
    const status: EntityStatus = (block.status as EntityStatus) || 'Draft';
    const [unlocked, setUnlocked] = useState(false);
    useEffect(() => { setUnlocked(false); }, [block.id]);
    const locked = status === 'Released' && !unlocked;

    const rawUpdate = useCallback((updates: EntityPatch) => {
        if (isLibrary) updateFB(block.id, updates as any);
        else updateEntity(block.id, block.level, updates);
    }, [block.id, block.level, isLibrary, updateFB, updateEntity]);

    const update = useCallback((updates: EntityPatch) => {
        if (locked) { toast('"Released" block: unlock it to edit.', 'error'); return; }
        rawUpdate(updates);
    }, [locked, rawUpdate]);

    const commitCodeDebounced = useCallback((value: string) => {
        pendingCodeRef.current = value;
        if (codeDebounceRef.current) clearTimeout(codeDebounceRef.current);
        codeDebounceRef.current = setTimeout(() => {
            codeDebounceRef.current = null;
            if (pendingCodeRef.current !== null) {
                update({ code: pendingCodeRef.current });
                pendingCodeRef.current = null;
            }
        }, 350);
    }, [update]);

    // flush pending code when leaving this block (or unmounting)
    useEffect(() => {
        return () => {
            if (codeDebounceRef.current) { clearTimeout(codeDebounceRef.current); codeDebounceRef.current = null; }
            if (pendingCodeRef.current !== null) {
                update({ code: pendingCodeRef.current });
                pendingCodeRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [block.id]);

    const setStatus = (s: EntityStatus) => {
        if (s === 'Released') {
            const res = releaseBlock(block);
            if (!res.ok) {
                toast(`"${block.name}" has ${res.blocking.length} error${res.blocking.length > 1 ? 's' : ''}: see the checks below the status bar (each one shows where it is), or use "Release anyway".`, 'error');
                return;
            }
            setUnlocked(false);
            return;
        }
        rawUpdate({ status: s });
        setUnlocked(false);
    };

    // Where-used: every entity / machine instance that references this one
    const usages = useMemo(
        () => findEntityUsages(block.id, { library, units, equipmentModules, controlModules }, assembly),
        [block.id, library, units, equipmentModules, controlModules, assembly]
    );
    const gotoEntity = (id: string, level: string) => { setArchTab(level as any); selectNode(id); };

    // ─── Inheritance: collect data from assigned FBs ───
    const inheritedData = useMemo(() => {
        const vars: (Variable & { source: string })[] = [];
        const alarms: (Alarm & { source: string })[] = [];
        const ios: (IOSignal & { source: string })[] = [];
        const dfmeas: (DFMEAEntry & { source: string })[] = [];

        if (isLibrary) return { vars, alarms, ios, dfmeas };

        // Collect from assigned FBs (flat model — no tree traversal needed)
        const assignedFBIds: string[] = (block as any).assignedFBs || [];
        for (const fbId of assignedFBIds) {
            const fb = library.find(f => f.id === fbId);
            if (!fb) continue;
            fb.variables.forEach(v => vars.push({ ...v, source: `FB: ${fb.name} ` }));
            fb.alarms.forEach(a => alarms.push({ ...a, source: `FB: ${fb.name} ` }));
            fb.io.forEach(i => ios.push({ ...i, source: `FB: ${fb.name} ` }));
            fb.dfmea.forEach(d => dfmeas.push({ ...d, source: `FB: ${fb.name} ` }));
        }

        return { vars, alarms, ios, dfmeas };
    }, [block, library, isLibrary]);

    const totalVars = block.variables.length + inheritedData.vars.length;
    const totalAlarms = block.alarms.length + inheritedData.alarms.length;
    const totalIO = block.io.length + inheritedData.ios.length;
    const totalDFMEA = block.dfmea.length + inheritedData.dfmeas.length;

    const rpnClass = (rpn: number) => {
        if (rpn >= 200) return 'rpn-critical';
        if (rpn >= 100) return 'rpn-high';
        if (rpn >= 50) return 'rpn-medium';
        return 'rpn-low';
    };

    const badgeForLevel = (level: string) => {
        const map: Record<string, string> = { Warning: 'badge-warning', Alarm: 'badge-alarm', Fault: 'badge-fault', Safety: 'badge-safety' };
        return map[level] || '';
    };

    const badgeForSignal = (type: string) => `badge-${type.toLowerCase()}`;

    const badgeForStatus = (status: string) => {
        const map: Record<string, string> = { 'To Do': 'badge-dafore', 'In Progress': 'badge-incorso', 'Implemented': 'badge-implementato', 'Verified': 'badge-verificato' };
        return map[status] || '';
    };

    return (
        <div>
            {/* Tabs */}
            <div className="tabs">
                {TABS.map(t => {
                    // Hide the FBs and BOM tabs if this is a Library (FB) item itself
                    if ((t.id === 'fbs' || t.id === 'bom') && isLibrary) return null;
                    return (
                        <button
                            key={t.id}
                            className={`tab ${tab === t.id ? 'active' : ''}`}
                            onClick={() => setTab(t.id as any)}
                        >
                            {t.icon}
                            <span style={{ marginLeft: 4 }}>{t.label}</span>
                            {t.id === 'fbs' && !isLibrary && <span className="badge badge-un" style={{ marginLeft: 4 }}>{((block as any).assignedFBs || []).length}</span>}
                            {t.id === 'variables' && <span className="badge badge-em" style={{ marginLeft: 4 }}>{totalVars}</span>}
                            {t.id === 'alarms' && totalAlarms > 0 && <span className="badge badge-alarm" style={{ marginLeft: 4 }}>{totalAlarms}</span>}
                            {t.id === 'io' && totalIO > 0 && <span className="badge badge-cm" style={{ marginLeft: 4 }}>{totalIO}</span>}
                            {t.id === 'dfmea' && totalDFMEA > 0 && <span className="badge badge-fault" style={{ marginLeft: 4 }}>{totalDFMEA}</span>}
                            {t.id === 'bom' && (block.bom?.length || 0) > 0 && <span className="badge badge-cm" style={{ marginLeft: 4 }}>{block.bom!.length}</span>}
                        </button>
                    );
                })}
            </div>

            {/* Lock banner for Released (governed) blocks */}
            {status === 'Released' && (
                <div className={`entity-lock-banner ${unlocked ? 'unlocked' : ''}`}>
                    {unlocked ? <Unlock size={15} /> : <Lock size={15} />}
                    <span>
                        {unlocked
                            ? 'Unlocked. The first change takes this block back to Draft, raises its version and logs a revision.'
                            : 'Released block (read-only). Machines depend on it: unlock it only to change it.'}
                    </span>
                    <button className="btn btn-secondary btn-sm" onClick={() => setUnlocked(u => !u)}>
                        {unlocked ? <><Lock size={13} /> Lock again</> : <><Unlock size={13} /> Unlock to edit</>}
                    </button>
                </div>
            )}

            {/* Lifecycle / governance bar — always editable (status is governance) */}
            <div className="lifecycle-bar">
                <span className="lifecycle-label"><ShieldCheck size={14} /> Library status</span>
                <div className="lifecycle-segments">
                    {STATUS_FLOW.map(s => (
                        <button
                            key={s}
                            className={`lifecycle-seg ${status === s ? 'active' : ''}`}
                            style={status === s ? { color: STATUS_META[s].color, borderColor: STATUS_META[s].color } : undefined}
                            onClick={() => { if (s !== status) setStatus(s); }}
                        >
                            {STATUS_META[s].label}
                        </button>
                    ))}
                </div>
            </div>

            <ReleaseIssues block={block} />

            <div className={locked ? 'entity-locked-content' : ''}>

            {/* ═══ Info Tab ═══ */}
            {tab === 'info' && (
                <div className="flex flex-col gap-4">
                    <div className="form-row">
                        <div className="form-group">
                            <label className="form-label">Name</label>
                            <input className="form-input" value={block.name} onChange={e => update({ name: e.target.value })} />
                        </div>
                        <div className="form-group">
                            <label className="form-label">Categoria</label>
                            <select className="form-select" value={block.category} onChange={e => update({ category: e.target.value as any })}>
                                {['Motion', 'Valve', 'Sensor', 'Communication', 'Safety', 'Logic', 'HMI', 'Other'].map(c =>
                                    <option key={c} value={c}>{c}</option>
                                )}
                            </select>
                        </div>
                    </div>
                    <div className="form-row">
                        <div className="form-group">
                            <label className="form-label">Level</label>
                            <span className={`badge badge-${block.level.toLowerCase()}`}>{block.level}</span>
                        </div>
                        <div className="form-group">
                            <label className="form-label">Version</label>
                            <input className="form-input" value={block.currentVersion} onChange={e => update({ currentVersion: e.target.value })} />
                        </div>
                    </div>
                    <div className="form-group">
                        <label className="form-label">Description</label>
                        <textarea className="form-textarea" value={block.description} onChange={e => update({ description: e.target.value })} rows={4} />
                    </div>
                    <div className="form-row">
                        {!isLibrary && (
                            <div className="form-group">
                                <label className="form-label">Hardware</label>
                                <input className="form-input" value={block.hardware || ''} onChange={e => update({ hardware: e.target.value })} placeholder="e.g. PLC Omron, Allen Bradley, ecc..." />
                            </div>
                        )}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                        <div className="stat-card">
                            <div><div className="stat-value">{totalVars}</div><div className="stat-label">Variables {inheritedData.vars.length > 0 && `(${block.variables.length} proprie)`}</div></div>
                        </div>
                        <div className="stat-card">
                            <div><div className="stat-value">{totalAlarms}</div><div className="stat-label">Alarms {inheritedData.alarms.length > 0 && `(${block.alarms.length} own)`}</div></div>
                        </div>
                        <div className="stat-card">
                            <div><div className="stat-value">{totalIO}</div><div className="stat-label">I/O {inheritedData.ios.length > 0 && `(${block.io.length} own)`}</div></div>
                        </div>
                        <div className="stat-card">
                            <div><div className="stat-value">{totalDFMEA}</div><div className="stat-label">DFMEA {inheritedData.dfmeas.length > 0 && `(${block.dfmea.length} own)`}</div></div>
                        </div>
                    </div>

                    {/* ── Dove usato (where-used / impact) ── */}
                    <div className="where-used">
                        <div className="where-used-head">
                            <ArrowUpRight size={14} /> Where used
                            <span className="where-used-count">
                                {usages.referencedBy.length} entities · {usages.assemblyCount} {usages.assemblyCount === 1 ? 'instance' : 'instances'} assembled
                            </span>
                        </div>
                        {usages.referencedBy.length === 0 && usages.assemblyCount === 0 ? (
                            <p className="where-used-empty">
                                Not referenced yet. {isLibrary ? 'Assign it to a CM/EM/UN' : 'Assign it to a higher level or use it in an assembly'} to reuse it.
                            </p>
                        ) : (
                            <div className="where-used-list">
                                {usages.referencedBy.map(r => (
                                    <button key={r.id} className="where-used-item" onClick={() => gotoEntity(r.id, r.level)} title="Open">
                                        <span className={`badge badge-${r.level.toLowerCase()}`} style={{ fontSize: '0.6rem', padding: '1px 5px' }}>{r.level}</span>
                                        <span className="where-used-name">{r.name}</span>
                                        <ArrowUpRight size={12} style={{ color: 'var(--text-muted)' }} />
                                    </button>
                                ))}
                                {usages.assemblyCount > 0 && (
                                    <div className="where-used-asm">
                                        <GitBranch size={12} /> Present in {usages.assemblyCount} {usages.assemblyCount === 1 ? 'nodo' : 'nodi'} of the assembly tree
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ═══ Sotto-Elementi Tab (UN/EM/CM only) ═══ */}
            {tab === 'fbs' && !isLibrary && (
                <div className="flex flex-col gap-8">
                    {block.level === 'UN' && (
                        <div>
                            <div className="flex items-center justify-between mb-4">
                                <h4>Assigned Equipment Modules ({((block as any).assignedEMs || []).length})</h4>
                            </div>
                            <div className="card" style={{ padding: 16, marginBottom: 24 }}>
                                <h5 style={{ marginBottom: 16, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Link EM</h5>
                                <div className="flex gap-2">
                                    <select className="form-select" style={{ flex: 1 }} id="emSelect">
                                        <option value="">-- Select an EM --</option>
                                        {equipmentModules.map(em => (
                                            <option key={em.id} value={em.id}>{em.name}</option>
                                        ))}
                                    </select>
                                    <button className="btn btn-primary" onClick={() => {
                                        const select = document.getElementById('emSelect') as HTMLSelectElement;
                                        const val = select.value;
                                        if (!val) return;
                                        const ems = (block as any).assignedEMs || [];
                                        if (!ems.includes(val)) update({ assignedEMs: [...ems, val] });
                                        select.value = '';
                                    }}>
                                        <Plus size={14} /> Link
                                    </button>
                                </div>
                            </div>
                            <div className="table-wrap">
                                <table>
                                    <thead><tr><th>EM Name</th><th>Last Modified</th><th></th></tr></thead>
                                    <tbody>
                                        {((block as any).assignedEMs || []).map((emId: string) => {
                                            const em = equipmentModules.find(e => e.id === emId);
                                            if (!em) return null;
                                            return (
                                                <tr key={emId}>
                                                    <td><strong>{em.name}</strong></td>
                                                    <td>{new Date((em as any).lastModified || Date.now()).toLocaleDateString()}</td>
                                                    <td>
                                                        <button className="btn btn-ghost btn-icon btn-sm" onClick={() => {
                                                            const ems = (block as any).assignedEMs || [];
                                                            update({ assignedEMs: ems.filter((id: string) => id !== emId) });
                                                        }}><Trash2 size={13} style={{ color: 'var(--red)' }} /></button>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}
                    {block.level === 'EM' && (
                        <div>
                            <div className="flex items-center justify-between mb-4">
                                <h4>Assigned Control Modules ({((block as any).assignedCMs || []).length})</h4>
                            </div>
                            <div className="card" style={{ padding: 16, marginBottom: 24 }}>
                                <h5 style={{ marginBottom: 16, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Link CM</h5>
                                <div className="flex gap-2">
                                    <select className="form-select" style={{ flex: 1 }} id="cmSelect">
                                        <option value="">-- Select a CM --</option>
                                        {controlModules.map(cm => (
                                            <option key={cm.id} value={cm.id}>{cm.name}</option>
                                        ))}
                                    </select>
                                    <button className="btn btn-primary" onClick={() => {
                                        const select = document.getElementById('cmSelect') as HTMLSelectElement;
                                        const val = select.value;
                                        if (!val) return;
                                        const cms = (block as any).assignedCMs || [];
                                        if (!cms.includes(val)) update({ assignedCMs: [...cms, val] });
                                        select.value = '';
                                    }}>
                                        <Plus size={14} /> Link
                                    </button>
                                </div>
                            </div>
                            <div className="table-wrap">
                                <table>
                                    <thead><tr><th>CM Name</th><th>Last Modified</th><th></th></tr></thead>
                                    <tbody>
                                        {((block as any).assignedCMs || []).map((cmId: string) => {
                                            const cm = controlModules.find(e => e.id === cmId);
                                            if (!cm) return null;
                                            return (
                                                <tr key={cmId}>
                                                    <td><strong>{cm.name}</strong></td>
                                                    <td>{new Date((cm as any).lastModified || Date.now()).toLocaleDateString()}</td>
                                                    <td>
                                                        <button className="btn btn-ghost btn-icon btn-sm" onClick={() => {
                                                            const cms = (block as any).assignedCMs || [];
                                                            update({ assignedCMs: cms.filter((id: string) => id !== cmId) });
                                                        }}><Trash2 size={13} style={{ color: 'var(--red)' }} /></button>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}
                    <div>
                        <div className="flex items-center justify-between mb-4">
                            <h4>Assigned Function Blocks ({((block as any).assignedFBs || []).length})</h4>
                        </div>
                        <div className="card" style={{ padding: 16, marginBottom: 24 }}>
                            <h5 style={{ marginBottom: 16, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Link Function Block from the Library</h5>
                            <div className="flex gap-2">
                                <select className="form-select" style={{ flex: 1 }} id="fbSelect">
                                    <option value="">-- Select an FB --</option>
                                    {library.map(fb => (
                                        <option key={fb.id} value={fb.id}>{fb.name} v{fb.currentVersion} ({fb.category})</option>
                                    ))}
                                </select>
                                <button className="btn btn-primary" onClick={() => {
                                    const select = document.getElementById('fbSelect') as HTMLSelectElement;
                                    const val = select.value;
                                    if (!val) return;
                                    const fbs = (block as any).assignedFBs || [];
                                    if (!fbs.includes(val)) update({ assignedFBs: [...fbs, val] });
                                    select.value = '';
                                }}>
                                    <Plus size={14} /> Link
                                </button>
                            </div>
                        </div>
                        <div className="table-wrap">
                            <table>
                                <thead>
                                    <tr><th>FB Name</th><th>Categoria</th><th>Version</th><th>Description</th><th></th></tr>
                                </thead>
                                <tbody>
                                    {((block as any).assignedFBs || []).map((fbId: string) => {
                                        const fb = library.find(f => f.id === fbId);
                                        if (!fb) return null;
                                        return (
                                            <tr key={fbId}>
                                                <td><strong>{fb.name}</strong></td>
                                                <td><span className="badge badge-un">{fb.category}</span></td>
                                                <td>{fb.currentVersion}</td>
                                                <td>{fb.description}</td>
                                                <td>
                                                    <button className="btn btn-ghost btn-icon btn-sm" onClick={() => {
                                                        const fbs = (block as any).assignedFBs || [];
                                                        update({ assignedFBs: fbs.filter((id: string) => id !== fbId) });
                                                    }}><Trash2 size={13} style={{ color: 'var(--red)' }} /></button>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                    {(!(block as any).assignedFBs || (block as any).assignedFBs.length === 0) && (
                                        <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24 }}>No Function Block assigned to this entity.</td></tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══ Variables Tab ═══ */}
            {
                tab === 'variables' && (
                    <div>
                        <div className="flex items-center justify-between mb-4">
                            <h4>Variables ({block.variables.length})</h4>
                            <button className="btn btn-primary btn-sm" onClick={() => setShowAddVar(true)}>
                                <Plus size={14} />Add Variable
                            </button>
                        </div>
                        <div className="table-wrap">
                            <table>
                                <thead>
                                    <tr>
                                        <th>Name</th><th>Type</th><th>Scopo</th><th>Address</th><th>Description</th><th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {block.variables.map(v => (
                                        <tr key={v.id}>
                                            <td><code>{v.name}</code></td>
                                            <td><span className="badge badge-em">{v.dataType === 'Other' && v.customDataType ? v.customDataType : v.dataType}</span></td>
                                            <td><span className="badge badge-un">{v.scope}</span></td>
                                            <td><code>{v.address || '—'}</code></td>
                                            <td>{v.description}</td>
                                            <td>
                                                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => { setEditingVariable(v); setShowAddVar(true); }}>
                                                    <Pencil size={13} />
                                                </button>
                                                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => deleteVariable(block.id, v.id)}>
                                                    <Trash2 size={13} />
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                    {block.variables.length === 0 && (
                                        <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24 }}>No variables defined</td></tr>
                                    )}
                                </tbody>
                            </table>
                        </div>

                        {/* Inherited Variables */}
                        {inheritedData.vars.length > 0 && (
                            <>
                                <h4 style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <Link size={14} style={{ color: 'var(--sky)' }} />
                                    Inherited Variables ({inheritedData.vars.length})
                                </h4>
                                <div className="table-wrap" style={{ marginTop: 8, opacity: 0.85 }}>
                                    <table>
                                        <thead>
                                            <tr>
                                                <th>Name</th><th>Type</th><th>Scopo</th><th>Address</th><th>Origine</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {inheritedData.vars.map((v, i) => (
                                                <tr key={`inh - ${i} `} className="inherited-row">
                                                    <td><code>{v.name}</code></td>
                                                    <td><span className="badge badge-em">{v.dataType === 'Other' && v.customDataType ? v.customDataType : v.dataType}</span></td>
                                                    <td><span className="badge badge-un">{v.scope}</span></td>
                                                    <td><code>{v.address || '—'}</code></td>
                                                    <td><span className="text-xs" style={{ color: 'var(--sky)' }}>{v.source}</span></td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </>
                        )}
                        <VariableModal
                            open={showAddVar}
                            onClose={() => { setShowAddVar(false); setEditingVariable(null); }}
                            blockId={block.id}
                            addVariable={addVariable}
                            updateVariable={updateVariable}
                            initialValues={editingVariable}
                        />
                    </div>
                )
            }

            {/* ═══ Code Tab — Monaco Editor ═══ */}
            {
                tab === 'code' && (
                    <div>
                        <div className="code-editor-toolbar">
                            <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>Structured Text (IEC 61131-3) — Monaco Editor</span>
                            <div className="flex gap-2">
                                <button className="btn btn-secondary btn-sm" onClick={() => {
                                    const generated = generateFBCallingCode(block, library);
                                    update({ code: generated });
                                }}>
                                    <Wand2 size={14} /> Generate FB Calling Code
                                </button>
                            </div>
                        </div>
                        <div className="code-editor-container" style={{ marginTop: 0, borderRadius: '0 0 8px 8px', overflow: 'hidden' }}>
                            <Editor
                                key={block.id}
                                height="500px"
                                language={ST_LANGUAGE_ID}
                                theme="iec-st-dark"
                                defaultValue={block.code}
                                onChange={(value) => commitCodeDebounced(value || '')}
                                onMount={(editor) => {
                                    editorRef.current = editor;
                                }}
                                beforeMount={(monaco) => {
                                    if (!monaco.languages.getLanguages().some(l => l.id === ST_LANGUAGE_ID)) {
                                        monaco.languages.register({ id: ST_LANGUAGE_ID });
                                        monaco.languages.setMonarchTokensProvider(ST_LANGUAGE_ID, stTokensProvider as any);
                                        monaco.languages.setLanguageConfiguration(ST_LANGUAGE_ID, stLanguageConfig);
                                    }
                                    monaco.editor.defineTheme('iec-st-dark', stTheme);
                                }}
                                options={{
                                    readOnly: locked,
                                    minimap: { enabled: false },
                                    fontSize: 14,
                                    lineHeight: 22,
                                    wordWrap: 'on',
                                    scrollBeyondLastLine: false,
                                    automaticLayout: true,
                                    tabSize: 4,
                                    renderLineHighlight: 'line',
                                    lineNumbers: 'on',
                                    folding: true,
                                    bracketPairColorization: { enabled: true },
                                    padding: { top: 12, bottom: 12 },
                                }}
                            />
                        </div>
                    </div>
                )
            }

            {/* ═══ Alarms Tab ═══ */}
            {
                tab === 'alarms' && (
                    <div>
                        <div className="flex items-center justify-between mb-4">
                            <h4>Alarms ({block.alarms.length})</h4>
                            <button className="btn btn-primary btn-sm" onClick={() => setShowAddAlarm(true)}>
                                <Plus size={14} /> Add Alarm
                            </button>
                        </div>
                        <div className="table-wrap">
                            <table>
                                <thead>
                                    <tr>
                                        <th>ID</th><th>Message</th><th>Level</th><th>Trigger</th><th>Action</th><th>Possible Causes</th><th>Possible Solutions</th><th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {block.alarms.map(a => (
                                        <tr key={a.id}>
                                            <td><code>{a.alarmId}</code></td>
                                            <td>{a.message}</td>
                                            <td><span className={`badge ${badgeForLevel(a.level)} `}>{a.level}</span></td>
                                            <td><code>{a.triggerVariable}</code></td>
                                            <td>{a.action}</td>
                                            <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', maxWidth: 180 }}>{a.possibleCauses || '—'}</td>
                                            <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', maxWidth: 180 }}>{a.possibleSolutions || '—'}</td>
                                            <td>
                                                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => { setEditingAlarm(a); setShowAddAlarm(true); }}>
                                                    <Pencil size={13} />
                                                </button>
                                                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => deleteAlarm(block.id, a.id)}>
                                                    <Trash2 size={13} />
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                    {block.alarms.length === 0 && (
                                        <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24 }}>No alarms defined</td></tr>
                                    )}
                                </tbody>
                            </table>
                        </div>

                        {/* Inherited Alarms */}
                        {inheritedData.alarms.length > 0 && (
                            <>
                                <h4 style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <Link size={14} style={{ color: 'var(--sky)' }} />
                                    Inherited Alarms ({inheritedData.alarms.length})
                                </h4>
                                <div className="table-wrap" style={{ marginTop: 8, opacity: 0.85 }}>
                                    <table>
                                        <thead>
                                            <tr><th>ID</th><th>Message</th><th>Level</th><th>Trigger</th><th>Possible Causes</th><th>Possible Solutions</th><th>Origine</th></tr>
                                        </thead>
                                        <tbody>
                                            {inheritedData.alarms.map((a, i) => (
                                                <tr key={`inh - ${i} `} className="inherited-row">
                                                    <td><code>{a.alarmId}</code></td>
                                                    <td>{a.message}</td>
                                                    <td><span className={`badge ${badgeForLevel(a.level)} `}>{a.level}</span></td>
                                                    <td><code>{a.triggerVariable}</code></td>
                                                    <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{a.possibleCauses || '—'}</td>
                                                    <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{a.possibleSolutions || '—'}</td>
                                                    <td><span className="text-xs" style={{ color: 'var(--sky)' }}>{a.source}</span></td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </>
                        )}
                        <AlarmModal
                            open={showAddAlarm}
                            onClose={() => { setShowAddAlarm(false); setEditingAlarm(null); }}
                            blockId={block.id}
                            addAlarm={addAlarm}
                            updateAlarm={updateAlarm}
                            initialValues={editingAlarm}
                        />
                    </div>
                )
            }

            {/* ═══ I/O Tab ═══ */}
            {
                tab === 'io' && (
                    <div>
                        <div className="flex items-center justify-between mb-4">
                            <h4>I/O Signals ({block.io.length})</h4>
                            <button className="btn btn-primary btn-sm" onClick={() => { setEditingIO(null); setShowAddIO(true); }}>
                                <Plus size={14} /> Add Signal
                            </button>
                        </div>
                        <div className="table-wrap">
                            <table>
                                <thead>
                                    <tr><th>Signal ID</th><th>Type</th><th>Address</th><th>Variable</th><th>Description</th><th></th></tr>
                                </thead>
                                <tbody>
                                    {block.io.map(s => (
                                        <tr key={s.id}>
                                            <td><code>{s.signalId}</code></td>
                                            <td><span className={`badge ${badgeForSignal(s.signalType)} `}>{s.signalType}</span></td>
                                            <td><code>{s.address}</code></td>
                                            <td><code>{s.variable}</code></td>
                                            <td>{s.description}</td>
                                            <td>
                                                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => { setEditingIO(s); setShowAddIO(true); }}>
                                                    <Pencil size={13} />
                                                </button>
                                                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => deleteIO(block.id, s.id)}>
                                                    <Trash2 size={13} />
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                    {block.io.length === 0 && (
                                        <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24 }}>No I/O signals</td></tr>
                                    )}
                                </tbody>
                            </table>
                        </div>

                        {inheritedData.ios.length > 0 && (
                            <>
                                <h4 style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <Link size={14} style={{ color: 'var(--sky)' }} />
                                    Inherited I/O Signals ({inheritedData.ios.length})
                                </h4>
                                <div className="table-wrap" style={{ marginTop: 8, opacity: 0.85 }}>
                                    <table>
                                        <thead>
                                            <tr><th>Signal ID</th><th>Type</th><th>Address</th><th>Variable</th><th>Source</th></tr>
                                        </thead>
                                        <tbody>
                                            {inheritedData.ios.map((s, i) => (
                                                <tr key={`inh - ${i} `} className="inherited-row">
                                                    <td><code>{s.signalId}</code></td>
                                                    <td><span className={`badge ${badgeForSignal(s.signalType)} `}>{s.signalType}</span></td>
                                                    <td><code>{s.address}</code></td>
                                                    <td><code>{s.variable}</code></td>
                                                    <td><span className="text-xs" style={{ color: 'var(--sky)' }}>{s.source}</span></td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </>
                        )}
                        <IOModal
                            open={showAddIO}
                            onClose={() => { setShowAddIO(false); setEditingIO(null); }}
                            blockId={block.id}
                            addIO={addIO}
                            updateIO={updateIO}
                            initialValues={editingIO}
                        />
                    </div>
                )
            }

            {/* ═══ DFMEA Tab ═══ */}
            {
                tab === 'dfmea' && (
                    <div>
                        <div className="flex items-center justify-between mb-4">
                            <h4>DFMEA ({block.dfmea.length})</h4>
                            <button className="btn btn-primary btn-sm" onClick={() => { setEditingDFMEA(null); setShowAddDFMEA(true); }}>
                                <Plus size={14} /> Add Entry
                            </button>
                        </div>
                        <div className="table-wrap">
                            <table>
                                <thead>
                                    <tr>
                                        <th>Failure Mode</th><th>Effect</th><th>Cause</th>
                                        <th>S</th><th>O</th><th>D</th><th>RPN</th>
                                        <th>Controls</th><th>Status</th><th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {block.dfmea.map(d => (
                                        <tr key={d.id} id={`dfmea-${d.id}`} className={focusItem === d.id ? 'row-focus' : ''}>
                                            <td>
                                                {d.failureMode}
                                                {(() => {
                                                    const part = (block.bom || []).find(p => p.id === d.componentId);
                                                    const n = suggestFor(d, block).length;
                                                    return (
                                                        <div className="text-xs" style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                                                            {part && <span>Component: {part.description || part.code} </span>}
                                                            {n > 0 && needsAttention(d) && <span style={{ color: 'var(--red)' }}>· {n} suggestion{n > 1 ? 's' : ''}</span>}
                                                        </div>
                                                    );
                                                })()}
                                            </td>
                                            <td>{d.effect}</td>
                                            <td>{d.cause}</td>
                                            <td>{d.severity}</td>
                                            <td>{d.occurrence}</td>
                                            <td>{d.detection}</td>
                                            <td><span className={rpnClass(d.rpn)}>{d.rpn}</span></td>
                                            <td>{d.controls}</td>
                                            <td><span className={`badge ${badgeForStatus(d.status)} `}>{d.status}</span></td>
                                            <td>
                                                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => { setEditingDFMEA(d); setShowAddDFMEA(true); }}>
                                                    <Pencil size={13} />
                                                </button>
                                                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => deleteDFMEA(block.id, d.id)}>
                                                    <Trash2 size={13} />
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                    {block.dfmea.length === 0 && (
                                        <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24 }}>No DFMEA entries</td></tr>
                                    )}
                                </tbody>
                            </table>
                        </div>

                        {inheritedData.dfmeas.length > 0 && (
                            <>
                                <h4 style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <Link size={14} style={{ color: 'var(--sky)' }} />
                                    Inherited DFMEA ({inheritedData.dfmeas.length})
                                </h4>
                                <div className="table-wrap" style={{ marginTop: 8, opacity: 0.85 }}>
                                    <table>
                                        <thead>
                                            <tr><th>Failure Mode</th><th>Effect</th><th>S</th><th>O</th><th>D</th><th>RPN</th><th>Status</th><th>Source</th></tr>
                                        </thead>
                                        <tbody>
                                            {inheritedData.dfmeas.map((d, i) => (
                                                <tr key={`inh - ${i} `} className="inherited-row">
                                                    <td>{d.failureMode}</td>
                                                    <td>{d.effect}</td>
                                                    <td>{d.severity}</td>
                                                    <td>{d.occurrence}</td>
                                                    <td>{d.detection}</td>
                                                    <td><span className={rpnClass(d.rpn)}>{d.rpn}</span></td>
                                                    <td><span className={`badge ${badgeForStatus(d.status)} `}>{d.status}</span></td>
                                                    <td><span className="text-xs" style={{ color: 'var(--sky)' }}>{d.source}</span></td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </>
                        )}
                        <DFMEAModal
                            open={showAddDFMEA}
                            onClose={() => { setShowAddDFMEA(false); setEditingDFMEA(null); }}
                            blockId={block.id}
                            block={block}
                            addDFMEA={addDFMEA}
                            updateDFMEA={updateDFMEA}
                            initialValues={editingDFMEA}
                        />
                    </div>
                )
            }

            {/* ═══ BOM Tab — hardware parts of one instance ═══ */}
            {
                tab === 'bom' && !isLibrary && (
                    <div>
                        <div className="flex items-center justify-between mb-4">
                            <h4 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <Package size={16} /> Bill of Materials ({(block.bom || []).length} components)
                            </h4>
                            <button
                                className="btn btn-primary btn-sm"
                                onClick={() => update({
                                    bom: [...(block.bom || []), {
                                        id: generateId(), internalCode: '', code: '', description: '',
                                        manufacturer: '', type: 'Hardware' as BomItemType,
                                        quantity: 1, unit: 'pz', notes: '',
                                    }],
                                })}
                            >
                                <Plus size={14} /> Add Component
                            </button>
                        </div>
                        <p className="text-sm" style={{ color: 'var(--text-muted)', marginBottom: 12 }}>
                            Hardware components of <strong>a single instance</strong> of this entity. Quantities are multiplied by the number of instances in the assembly when the BOM is exported for purchasing.
                        </p>
                        {(block.bom || []).length === 0 ? (
                            <div className="empty-state-sm">
                                <Package size={28} />
                                <p>No components. Add the materials needed to build this entity.</p>
                            </div>
                        ) : (
                            <div className="table-wrap">
                                <table className="data-table">
                                    <thead>
                                        <tr>
                                            <th style={{ width: 120 }}>Internal Code</th>
                                            <th style={{ width: 130 }}>Supplier Code</th>
                                            <th>Description</th>
                                            <th style={{ width: 130 }}>Manufacturer</th>
                                            <th style={{ width: 105 }}>Type</th>
                                            <th style={{ width: 65 }}>Qty</th>
                                            <th style={{ width: 60 }}>Units</th>
                                            <th>Notes</th>
                                            <th style={{ width: 40 }}></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {(block.bom || []).map(part => {
                                            const patch = (updates: Partial<BomPart>) => update({
                                                bom: (block.bom || []).map(p => p.id === part.id ? { ...p, ...updates } : p),
                                            });
                                            const alts = part.alternatives || [];
                                            const setAlts = (next: NonNullable<BomPart['alternatives']>) => patch({ alternatives: next });
                                            return (
                                                <React.Fragment key={part.id}>
                                                <tr>
                                                    <td><input className="input input-sm mono" defaultValue={part.internalCode || ''} placeholder="e.g. TIR-00123" onBlur={e => patch({ internalCode: e.target.value })} /></td>
                                                    <td><input className="input input-sm mono" defaultValue={part.code} placeholder="e.g. 1734-IB8" onBlur={e => patch({ code: e.target.value })} /></td>
                                                    <td><input className="input input-sm" defaultValue={part.description} placeholder="Component description" onBlur={e => patch({ description: e.target.value })} /></td>
                                                    <td><input className="input input-sm" defaultValue={part.manufacturer} placeholder="e.g. Allen-Bradley" onBlur={e => patch({ manufacturer: e.target.value })} /></td>
                                                    <td>
                                                        <select className="input input-sm" defaultValue={part.type || 'Hardware'} onChange={e => patch({ type: e.target.value as BomItemType })}>
                                                            {BOM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                                                        </select>
                                                    </td>
                                                    <td><input className="input input-sm" type="number" min={0} defaultValue={part.quantity} onBlur={e => patch({ quantity: Math.max(0, Number(e.target.value) || 0) })} /></td>
                                                    <td><input className="input input-sm" defaultValue={part.unit || 'pz'} onBlur={e => patch({ unit: e.target.value })} /></td>
                                                    <td><input className="input input-sm" defaultValue={part.notes || ''} onBlur={e => patch({ notes: e.target.value })} /></td>
                                                    <td>
                                                        <button className="btn btn-ghost btn-sm" title="Delete" onClick={() => update({ bom: (block.bom || []).filter(p => p.id !== part.id) })}>
                                                            <Trash2 size={13} />
                                                        </button>
                                                    </td>
                                                </tr>
                                                <tr className="bom-alt-row">
                                                    <td colSpan={9}>
                                                        <div className="bom-alts">
                                                            <span className="bom-alts-label">Alternatives (best first)</span>
                                                            {alts.map((a, i) => (
                                                                <div key={a.id} className="bom-alt">
                                                                    <span className="bom-alt-rank">{i + 1}</span>
                                                                    <input className="input input-sm mono" style={{ width: 130 }} defaultValue={a.code} placeholder="Part number" onBlur={e => setAlts(alts.map(x => x.id === a.id ? { ...x, code: e.target.value } : x))} />
                                                                    <input className="input input-sm" style={{ width: 120 }} defaultValue={a.manufacturer} placeholder="Manufacturer" onBlur={e => setAlts(alts.map(x => x.id === a.id ? { ...x, manufacturer: e.target.value } : x))} />
                                                                    <input className="input input-sm" style={{ flex: 1, minWidth: 140 }} defaultValue={a.description} placeholder="Description" onBlur={e => setAlts(alts.map(x => x.id === a.id ? { ...x, description: e.target.value } : x))} />
                                                                    <input className="input input-sm" style={{ flex: 1, minWidth: 140 }} defaultValue={a.notes || ''} placeholder="When to prefer it" onBlur={e => setAlts(alts.map(x => x.id === a.id ? { ...x, notes: e.target.value } : x))} />
                                                                    <button className="btn btn-ghost btn-sm" title="Remove alternative" onClick={() => setAlts(alts.filter(x => x.id !== a.id))}><Trash2 size={12} /></button>
                                                                </div>
                                                            ))}
                                                            <button className="btn btn-secondary btn-sm" onClick={() => setAlts([...alts, { id: generateId(), code: '', manufacturer: '', description: '', notes: '' }])}>
                                                                <Plus size={12} /> Add alternative
                                                            </button>
                                                        </div>
                                                    </td>
                                                </tr>
                                                </React.Fragment>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                )
            }

            {/* ═══ Revisions Tab — Timeline ═══ */}
            {
                tab === 'revisions' && (
                    <div>
                        <div className="flex items-center justify-between mb-4">
                            <h4>Revision History ({block.revisions.length})</h4>
                            <button className="btn btn-primary btn-sm" onClick={() => {
                                setShowAddRevision(true);
                            }}>
                                <Plus size={14} /> New Revision
                            </button>
                        </div>

                        {block.revisions.length > 0 ? (
                            <div className="revision-timeline">
                                {[...block.revisions].reverse().map((r, i) => (
                                    <div key={i} className="revision-entry">
                                        <div className="revision-dot-col">
                                            <div className={`revision-dot ${i === 0 ? 'latest' : ''}`}>
                                                <GitCommit size={12} />
                                            </div>
                                            {i < block.revisions.length - 1 && <div className="revision-line" />}
                                        </div>
                                        <div className="revision-content">
                                            <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
                                                <span className="badge badge-un">{r.version}</span>
                                                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{r.date}</span>
                                                {i === 0 && <span className="badge badge-em" style={{ fontSize: '0.6rem' }}>Last</span>}
                                            </div>
                                            <div className="text-sm font-semibold">{r.notes}</div>
                                            <div className="text-xs" style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                                                of {r.author}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="empty-state" style={{ padding: '40px 0' }}>
                                <Clock size={32} style={{ opacity: 0.3, marginBottom: 8 }} />
                                <p>No revision history</p>
                                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Click "New Revision" to start tracking changes</p>
                            </div>
                        )}
                    </div>
                )
            }
            {/* Checklist Tab removed */}

            <Modal
                open={showAddRevision}
                onClose={() => { setShowAddRevision(false); setNewRevisionNotes(''); }}
                title="New Revision"
                footer={
                    <>
                        <button className="btn btn-secondary" onClick={() => { setShowAddRevision(false); setNewRevisionNotes(''); }}>Cancel</button>
                        <button className="btn btn-primary" disabled={!newRevisionNotes.trim()} onClick={() => {
                            const nextVer = (() => {
                                const parts = (block.currentVersion || '1.0').split('.').map(Number);
                                parts[parts.length - 1]++;
                                return parts.join('.');
                            })();
                            const rev: Revision = {
                                version: nextVer,
                                date: new Date().toISOString().slice(0, 10),
                                author: activeUser || 'Engineer',
                                notes: newRevisionNotes.trim(),
                            };
                            addRevision(block.id, rev);
                            update({ currentVersion: nextVer });
                            setShowAddRevision(false);
                            setNewRevisionNotes('');
                        }}>Create Revision</button>
                    </>
                }
            >
                <div className="form-group">
                    <label className="form-label">Revision notes</label>
                    <textarea
                        className="form-textarea"
                        value={newRevisionNotes}
                        onChange={e => setNewRevisionNotes(e.target.value)}
                        placeholder="Describe the changes made..."
                        autoFocus
                    />
                </div>
            </Modal>
            </div>{/* /entity-locked-content */}
        </div>
    );
};
// Checklist Modal removed

// ─── Variable Modal ─────────────────────────────────────────
const VariableModal: React.FC<{
    open: boolean; onClose: () => void;
    blockId: string;
    addVariable: (nodeId: string, v: Variable) => void;
    updateVariable: (nodeId: string, varId: string, updates: Partial<Variable>) => void;
    initialValues?: Variable | null;
}> = ({ open, onClose, blockId, addVariable, updateVariable, initialValues }) => {
    const [name, setName] = useState('');
    const [desc, setDesc] = useState('');
    const [dataType, setDataType] = useState<DataType>('BOOL');
    const [customDataType, setCustomDataType] = useState('');
    const [scope, setScope] = useState<VariableScope>('Input');
    const [address, setAddress] = useState('');

    useEffect(() => {
        if (open && initialValues) {
            setName(initialValues.name); setDesc(initialValues.description);
            setDataType(initialValues.dataType); setCustomDataType(initialValues.customDataType || ''); setScope(initialValues.scope);
            setAddress(initialValues.address || '');
        } else if (open) {
            setName(''); setDesc(''); setDataType('BOOL'); setCustomDataType(''); setScope('Input'); setAddress('');
        }
    }, [open, initialValues]);

    const handleSave = () => {
        if (!name) return;
        if (initialValues) {
            updateVariable(blockId, initialValues.id, { name, description: desc, dataType, customDataType, scope, address: address || undefined });
        } else {
            addVariable(blockId, { id: generateId(), name, description: desc, dataType, customDataType, scope, address: address || undefined });
        }
        onClose();
    };

    return (
        <Modal open={open} onClose={onClose} title={initialValues ? "Edit Variable" : "Add Variable"} footer={
            <><button className="btn btn-secondary" onClick={onClose}>Cancel</button>
                <button className="btn btn-primary" onClick={handleSave}>{initialValues ? 'Save' : 'Add'}</button></>
        }>
            <div className="form-group"><label className="form-label">Name</label><input className="form-input" value={name} onChange={e => setName(e.target.value)} placeholder="bMiaVariabile" /></div>
            <div className="form-row">
                <div className="form-group"><label className="form-label">Data Type</label>
                    <select className="form-select" value={dataType} onChange={e => setDataType(e.target.value as DataType)}>{DATA_TYPES.map(t => <option key={t}>{t}</option>)}</select>
                </div>
                {dataType === 'Other' && (
                    <div className="form-group"><label className="form-label">Type Name</label>
                        <input className="form-input" value={customDataType} onChange={e => setCustomDataType(e.target.value)} placeholder="Enter text..." />
                    </div>
                )}
                <div className="form-group"><label className="form-label">Scopo</label>
                    <select className="form-select" value={scope} onChange={e => setScope(e.target.value as VariableScope)}>{SCOPES.map(s => <option key={s}>{s}</option>)}</select>
                </div>
            </div>
            <div className="form-group"><label className="form-label">Address (optional)</label><input className="form-input" value={address} onChange={e => setAddress(e.target.value)} placeholder="%IX0.0" /></div>
            <div className="form-group"><label className="form-label">Description</label><input className="form-input" value={desc} onChange={e => setDesc(e.target.value)} /></div>
        </Modal>
    );
};

// ─── Alarm Modal ────────────────────────────────────────────
const AlarmModal: React.FC<{
    open: boolean; onClose: () => void;
    blockId: string;
    addAlarm: (nodeId: string, a: Alarm) => void;
    updateAlarm: (nodeId: string, id: string, updates: Partial<Alarm>) => void;
    initialValues?: Alarm | null;
}> = ({ open, onClose, blockId, addAlarm, updateAlarm, initialValues }) => {
    const [alarmId, setAlarmId] = useState('');
    const [message, setMessage] = useState('');
    const [level, setLevel] = useState<AlarmLevel>('Warning');
    const [trigger, setTrigger] = useState('');
    const [action, setAction] = useState<AlarmAction>('Log');
    const [possibleCauses, setPossibleCauses] = useState('');
    const [possibleSolutions, setPossibleSolutions] = useState('');

    useEffect(() => {
        if (open && initialValues) {
            setAlarmId(initialValues.alarmId); setMessage(initialValues.message);
            setLevel(initialValues.level); setTrigger(initialValues.triggerVariable); setAction(initialValues.action);
            setPossibleCauses(initialValues.possibleCauses || ''); setPossibleSolutions(initialValues.possibleSolutions || '');
        } else if (open) {
            setAlarmId(''); setMessage(''); setLevel('Warning'); setTrigger(''); setAction('Log');
            setPossibleCauses(''); setPossibleSolutions('');
        }
    }, [open, initialValues]);

    const handleSave = () => {
        if (!alarmId || !message) return;
        if (initialValues) {
            updateAlarm(blockId, initialValues.id, { alarmId, message, level, triggerVariable: trigger, action, possibleCauses, possibleSolutions });
        } else {
            addAlarm(blockId, { id: generateId(), alarmId, message, level, triggerVariable: trigger, action, linkedModules: [], possibleCauses, possibleSolutions });
        }
        onClose();
    };

    return (
        <Modal open={open} onClose={onClose} title={initialValues ? "Edit Alarm" : "Add Alarm"} footer={
            <><button className="btn btn-secondary" onClick={onClose}>Cancel</button>
                <button className="btn btn-primary" onClick={handleSave}>{initialValues ? 'Save' : 'Add'}</button></>
        }>
            <div className="form-row">
                <div className="form-group"><label className="form-label">Alarm ID</label><input className="form-input" value={alarmId} onChange={e => setAlarmId(e.target.value)} /></div>
                <div className="form-group"><label className="form-label">Level</label>
                    <select className="form-select" value={level} onChange={e => setLevel(e.target.value as AlarmLevel)}>{ALARM_LEVELS.map(l => <option key={l}>{l}</option>)}</select>
                </div>
            </div>
            <div className="form-group"><label className="form-label">Message</label><input className="form-input" value={message} onChange={e => setMessage(e.target.value)} /></div>
            <div className="form-row">
                <div className="form-group"><label className="form-label">Trigger Variable</label><input className="form-input" value={trigger} onChange={e => setTrigger(e.target.value)} /></div>
                <div className="form-group"><label className="form-label">Action</label>
                    <select className="form-select" value={action} onChange={e => setAction(e.target.value as AlarmAction)}>{ALARM_ACTIONS.map(a => <option key={a}>{a}</option>)}</select>
                </div>
            </div>
            <div className="form-group"><label className="form-label">Possible Causes</label>
                <textarea className="form-textarea" value={possibleCauses} onChange={e => setPossibleCauses(e.target.value)} placeholder="List the possible causes of the alarm..." rows={3} />
            </div>
            <div className="form-group"><label className="form-label">Possible Solutions</label>
                <textarea className="form-textarea" value={possibleSolutions} onChange={e => setPossibleSolutions(e.target.value)} placeholder="List the possible solutions to resolve the alarm..." rows={3} />
            </div>
        </Modal>
    );
};

// ─── IO Modal ───────────────────────────────────────────────
const IOModal: React.FC<{
    open: boolean; onClose: () => void;
    blockId: string;
    addIO: (nodeId: string, io: IOSignal) => void;
    updateIO: (nodeId: string, id: string, updates: Partial<IOSignal>) => void;
    initialValues?: IOSignal | null;
}> = ({ open, onClose, blockId, addIO, updateIO, initialValues }) => {
    const [signalId, setSignalId] = useState('');
    const [signalType, setSignalType] = useState<SignalType>('DI');
    const [address, setAddress] = useState('');
    const [variable, setVariable] = useState('');
    const [desc, setDesc] = useState('');
    const [dataType, setDataType] = useState<DataType>('BOOL');
    const [customDataType, setCustomDataType] = useState('');

    useEffect(() => {
        if (open && initialValues) {
            setSignalId(initialValues.signalId); setSignalType(initialValues.signalType);
            setAddress(initialValues.address); setVariable(initialValues.variable);
            setDesc(initialValues.description); setDataType(initialValues.dataType || 'BOOL');
            setCustomDataType(initialValues.customDataType || '');
        } else if (open) {
            setSignalId(''); setSignalType('DI'); setAddress(''); setVariable(''); setDesc(''); setDataType('BOOL'); setCustomDataType('');
        }
    }, [open, initialValues]);

    const handleSave = () => {
        if (!signalId) return;
        if (initialValues) {
            updateIO(blockId, initialValues.id, { signalId, signalType, address, variable, description: desc, dataType, customDataType });
        } else {
            addIO(blockId, { id: generateId(), signalId, signalType, address, variable, description: desc, dataType, customDataType });
        }
        onClose();
    };

    return (
        <Modal open={open} onClose={onClose} title={initialValues ? "Edit I/O Signal" : "Add I/O Signal"} footer={
            <><button className="btn btn-secondary" onClick={onClose}>Cancel</button>
                <button className="btn btn-primary" onClick={handleSave}>{initialValues ? 'Save' : 'Add'}</button></>
        }>
            <div className="form-row">
                <div className="form-group"><label className="form-label">Signal ID</label><input className="form-input" value={signalId} onChange={e => setSignalId(e.target.value)} /></div>
                <div className="form-group"><label className="form-label">Type</label>
                    <select className="form-select" value={signalType} onChange={e => setSignalType(e.target.value as SignalType)}>{SIGNAL_TYPES.map(t => <option key={t}>{t}</option>)}</select>
                </div>
            </div>
            <div className="form-row">
                <div className="form-group"><label className="form-label">PLC Address</label><input className="form-input" value={address} onChange={e => setAddress(e.target.value)} /></div>
                <div className="form-group"><label className="form-label">Data Type</label>
                    <select className="form-select" value={dataType} onChange={e => setDataType(e.target.value as DataType)}>{DATA_TYPES.map(t => <option key={t}>{t}</option>)}</select>
                </div>
            </div>
            {dataType === 'Other' && (
                <div className="form-row">
                    <div className="form-group"><label className="form-label">Type Name</label>
                        <input className="form-input" value={customDataType} onChange={e => setCustomDataType(e.target.value)} placeholder="Enter text..." />
                    </div>
                </div>
            )}
            <div className="form-group"><label className="form-label">Linked Variable</label><input className="form-input" value={variable} onChange={e => setVariable(e.target.value)} /></div>
            <div className="form-group"><label className="form-label">Description</label><input className="form-input" value={desc} onChange={e => setDesc(e.target.value)} /></div>
        </Modal>
    );
};

// ─── DFMEA Modal ────────────────────────────────────────────
const DFMEAModal: React.FC<{
    open: boolean; onClose: () => void;
    blockId: string;
    block: BlockBase;
    addDFMEA: (nodeId: string, d: DFMEAEntry) => void;
    updateDFMEA: (nodeId: string, id: string, updates: Partial<DFMEAEntry>) => void;
    initialValues?: DFMEAEntry | null;
}> = ({ open, onClose, blockId, block, addDFMEA, updateDFMEA, initialValues }) => {
    const [componentId, setComponentId] = useState('');
    const [alarmId, setAlarmId] = useState('');
    const [fm, setFM] = useState('');
    const [effect, setEffect] = useState('');
    const [cause, setCause] = useState('');
    const [s, setS] = useState(1);
    const [o, setO] = useState(1);
    const [d, setD] = useState(1);
    const [controls, setControls] = useState('');
    const [actions, setActions] = useState('');
    const [status, setStatus] = useState<DFMEAStatus>('To Do');

    useEffect(() => {
        if (open && initialValues) {
            setFM(initialValues.failureMode); setEffect(initialValues.effect); setCause(initialValues.cause);
            setS(initialValues.severity); setO(initialValues.occurrence); setD(initialValues.detection);
            setControls(initialValues.controls); setActions(initialValues.actions); setStatus(initialValues.status);
            setComponentId(initialValues.componentId || ''); setAlarmId(initialValues.alarmId || '');
        } else if (open) {
            setFM(''); setEffect(''); setCause(''); setS(1); setO(1); setD(1);
            setControls(''); setActions(''); setStatus('To Do');
            setComponentId(''); setAlarmId('');
        }
    }, [open, initialValues]);

    const handleSave = () => {
        if (!fm) return;
        if (initialValues) {
            updateDFMEA(blockId, initialValues.id, {
                failureMode: fm, effect, cause, severity: s, occurrence: o, detection: d,
                rpn: calculateRPN(s, o, d), controls, actions, status,
                componentId: componentId || undefined, alarmId: alarmId || undefined,
            });
        } else {
            addDFMEA(blockId, {
                id: generateId(), failureMode: fm, effect, cause,
                severity: s, occurrence: o, detection: d,
                rpn: calculateRPN(s, o, d), controls, actions, status,
                componentId: componentId || undefined, alarmId: alarmId || undefined,
            });
        }
        onClose();
    };

    const rpnClass = (rpn: number) => {
        if (rpn >= 200) return 'rpn-critical';
        if (rpn >= 100) return 'rpn-high';
        if (rpn >= 50) return 'rpn-medium';
        return 'rpn-low';
    };

    return (
        <Modal open={open} onClose={onClose} title={initialValues ? "Edit DFMEA Entry" : "Add DFMEA Entry"} footer={
            <><button className="btn btn-secondary" onClick={onClose}>Cancel</button>
                <button className="btn btn-primary" onClick={handleSave}>{initialValues ? 'Save' : 'Add'}</button></>
        }>
            <div className="form-group"><label className="form-label">Failure Mode</label><input className="form-input" value={fm} onChange={e => setFM(e.target.value)} /></div>
            <div className="form-group"><label className="form-label">Effect</label><input className="form-input" value={effect} onChange={e => setEffect(e.target.value)} /></div>
            <div className="form-group"><label className="form-label">Cause</label><input className="form-input" value={cause} onChange={e => setCause(e.target.value)} /></div>
            <div className="form-row">
                <div className="form-group"><label className="form-label">Severity (1-10)</label><input className="form-input" type="number" min={1} max={10} value={s} onChange={e => setS(Number(e.target.value))} /></div>
                <div className="form-group"><label className="form-label">Occurrence (1-10)</label><input className="form-input" type="number" min={1} max={10} value={o} onChange={e => setO(Number(e.target.value))} /></div>
                <div className="form-group"><label className="form-label">Detection (1-10)</label><input className="form-input" type="number" min={1} max={10} value={d} onChange={e => setD(Number(e.target.value))} /></div>
            </div>
            <div style={{ textAlign: 'center', fontWeight: 700, fontSize: '1.25rem' }}>
                RPN = <span className={rpnClass(s * o * d)}>{s * o * d}</span>
            </div>
            <div className="form-row">
                <div className="form-group">
                    <label className="form-label">Component involved</label>
                    <select className="form-select" value={componentId} onChange={e => setComponentId(e.target.value)}>
                        <option value="">— none —</option>
                        {(block.bom || []).map(p => <option key={p.id} value={p.id}>{p.description || p.code || 'Component'}{p.code ? ` (${p.code})` : ''}</option>)}
                    </select>
                </div>
                <div className="form-group">
                    <label className="form-label">Detected by alarm</label>
                    <select className="form-select" value={alarmId} onChange={e => setAlarmId(e.target.value)}>
                        <option value="">— none —</option>
                        {(block.alarms || []).map(a => <option key={a.id} value={a.id}>{a.alarmId} {a.message}</option>)}
                    </select>
                </div>
            </div>
            {(() => {
                const tips = suggestFor({ severity: s, occurrence: o, detection: d, componentId, alarmId, controls, actions }, block);
                if (!tips.length) return null;
                return (
                    <div className={`dfmea-tips band-${rpnBand(s * o * d)}`}>
                        <strong>Suggestions</strong>
                        <ul>{tips.map(t => <li key={t.id}>{t.text}</li>)}</ul>
                    </div>
                );
            })()}
            <div className="form-group"><label className="form-label">Controls</label><input className="form-input" value={controls} onChange={e => setControls(e.target.value)} /></div>
            <div className="form-group"><label className="form-label">Actions</label><input className="form-input" value={actions} onChange={e => setActions(e.target.value)} /></div>
            <div className="form-group"><label className="form-label">Status</label>
                <select className="form-select" value={status} onChange={e => setStatus(e.target.value as DFMEAStatus)}>{DFMEA_STATUSES.map(st => <option key={st}>{st}</option>)}</select>
            </div>
        </Modal>
    );
};
