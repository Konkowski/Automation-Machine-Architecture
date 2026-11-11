// ============================================================
// AMA — Assembly Page (Project Builder)
// Drag entities from Architecture into a project tree
// ============================================================
import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom'; // For "Edit in Architecture"
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { useStore } from '../lib/store';
import { useCommands } from '../lib/commands';
import { isAssemblable } from '../lib/deviation';
import {
    GitBranch, Plus, Trash2, ChevronRight, ChevronDown,
    Box, Cpu, Settings, BookOpen, Pencil, Check, X,
    Search, GripVertical, Eye, ArrowUpRight,
    LayoutGrid, List, Download, HardDrive, RefreshCw, Link2,
    PanelLeftClose, PanelRightClose, Library as LibraryIcon, Workflow, RotateCcw
} from 'lucide-react';
import type { AssemblyNode, EntityLevel, BlockBase, HardwareItem } from '../types/machine';
import { findEntityById, getAssemblyBreadcrumb, type EntityDB, generateId } from '../lib/helpers';
import { saveAs } from 'file-saver';
import { MachineDiagramView } from '../components/MachineDiagramView';
import { NetworkTopology } from '../components/NetworkTopology';
import { SbomEditor } from '../components/SbomEditor';
import { Network } from 'lucide-react';

export const AssemblyPage: React.FC = () => {
    const navigate = useNavigate();
    const assembly = useStore(s => s.assembly);
    const library = useStore(s => s.library);
    const units = useStore(s => s.units);
    const ems = useStore(s => s.equipmentModules);
    const cms = useStore(s => s.controlModules);
    const addToAssembly = useStore(s => s.addToAssembly);
    const removeFromAssembly = useStore(s => s.removeFromAssembly);
    const refreshAssemblyNode = useStore(s => s.refreshAssemblyNode);
    const updateAssemblyMeta = useStore(s => s.updateAssemblyMeta);
    const findEntity = useStore(s => s.findEntityById);
    const updateAssemblyNode = useStore(s => s.updateAssemblyNode);
    const duplicateAssemblyNode = useStore(s => s.duplicateAssemblyNode);
    const workspaceKind = useStore(s => s.workspaceKind);
    const [copies, setCopies] = useState(1);

    const [editingMeta, setEditingMeta] = useState(false);
    const [metaName, setMetaName] = useState(assembly.name);
    const [metaDesc, setMetaDesc] = useState(assembly.description);
    const [metaSecDesc, setMetaSecDesc] = useState(assembly.secondaryDescription || '');
    const [selectedAsmNodeId, setSelectedAsmNodeId] = useState<string | null>(null);
    const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set(assembly.tree.map(n => n.id)));
    const [viewMode, setViewMode] = useState<'tree' | 'topology'>('tree');

    // SBOM State
    const [showSbom, setShowSbom] = useState(false);

    // Library Panel State
    const [libFilter, setLibFilter] = useState('');
    const [libTab, setLibTab] = useState<'UN' | 'EM' | 'CM' | 'FB'>('UN');

    // Collapsible panels (Library → Tree → Mind Map, left to right)
    const [panels, setPanels] = useState({ lib: true, tree: true, mind: true });
    const togglePanel = (k: 'lib' | 'tree' | 'mind') => setPanels(p => ({ ...p, [k]: !p[k] }));
    useCommands({
        'asm:view:tree': () => { setViewMode('tree'); setShowSbom(false); },
        'asm:view:topology': () => { setViewMode('topology'); setShowSbom(false); },
        'asm:view:sbom': () => setShowSbom(true),
        'asm:panel:lib': () => togglePanel('lib'),
        'asm:panel:tree': () => togglePanel('tree'),
        'asm:panel:mind': () => togglePanel('mind'),
    });

    const db: EntityDB = useMemo(() => ({ library, units, equipmentModules: ems, controlModules: cms }), [library, units, ems, cms]);

    // Find the selected assembly node and resolve its entity
    const selectedAsmNode = useMemo(() => {
        if (!selectedAsmNodeId) return null;
        const findNode = (nodes: AssemblyNode[]): AssemblyNode | null => {
            for (const n of nodes) {
                if (n.id === selectedAsmNodeId) return n;
                const found = findNode(n.children);
                if (found) return found;
            }
            return null;
        };
        return findNode(assembly.tree);
    }, [selectedAsmNodeId, assembly.tree]);

    const selectedEntity = selectedAsmNode ? findEntity(selectedAsmNode.refId) : null;
    const breadcrumb = selectedAsmNodeId ? getAssemblyBreadcrumb(assembly.tree, selectedAsmNodeId, db) : [];

    const handleSaveMeta = () => {
        updateAssemblyMeta({ name: metaName, description: metaDesc, secondaryDescription: metaSecDesc });
        setEditingMeta(false);
    };

    const toggleExpand = (id: string) => {
        setExpandedNodes(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const handleExportJSON = () => {
        const data = JSON.stringify({ library, units, equipmentModules: ems, controlModules: cms, assembly }, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        saveAs(blob, `${assembly.name}_project.json`);
    };

    // Filtered Library Items
    const codebase = useStore(s => s.codebase);
    const hiddenCount = useMemo(() => {
        if (!codebase) return 0;
        const src = libTab === 'UN' ? units : libTab === 'EM' ? ems : libTab === 'CM' ? cms : library;
        return src.filter(e => !isAssemblable(e)).length;
    }, [codebase, libTab, units, ems, cms, library]);
    const libraryItems = useMemo(() => {
        let list: BlockBase[] = [];
        if (libTab === 'UN') list = units;
        else if (libTab === 'EM') list = ems;
        else if (libTab === 'CM') list = cms;
        else if (libTab === 'FB') list = library;
        if (codebase) list = list.filter(isAssemblable);

        if (libFilter) {
            const q = libFilter.toLowerCase();
            return list.filter(e => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
        }
        return list;
    }, [libTab, libFilter, units, ems, cms, library, codebase]);

    const levelIcon = (level: EntityLevel) => {
        if (level === 'UN') return <Box size={14} />;
        if (level === 'EM') return <Cpu size={14} />;
        if (level === 'CM') return <Settings size={14} />;
        return <BookOpen size={14} />;
    };

    // Render assembly tree node
    const renderNode = (node: AssemblyNode, depth: number = 0) => {
        const entity = findEntity(node.refId);
        if (!entity) return null;
        const isExpanded = expandedNodes.has(node.id);
        const isSelected = selectedAsmNodeId === node.id;

        return (
            <div key={node.id}>
                <DroppableNode
                    node={node}
                    entity={entity}
                    depth={depth}
                    isSelected={isSelected}
                    isExpanded={isExpanded}
                    onToggle={() => toggleExpand(node.id)}
                    onSelect={() => setSelectedAsmNodeId(node.id)}
                    onRemove={() => {
                        removeFromAssembly(node.id);
                        if (selectedAsmNodeId === node.id) setSelectedAsmNodeId(null);
                    }}
                />
                {isExpanded && node.children.map(child => renderNode(child, depth + 1))}
            </div>
        );
    };

    return (
        <div className="asm-page">
            {workspaceKind === 'machine' && !codebase && (
                <div className="asm-free-banner">
                    <strong>Free mode.</strong> No code base is linked, so any block can be used and nothing guarantees this machine can be rebuilt.
                    <button className="btn btn-secondary btn-sm" onClick={() => navigate('/project')}>Link a code base</button>
                </div>
            )}
            {/* Project Header */}
            <div className="asm-header">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    {editingMeta ? (
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexDirection: 'column' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <input
                                    className="input"
                                    value={metaName}
                                    onChange={e => setMetaName(e.target.value)}
                                    placeholder="Project name"
                                    autoFocus
                                    style={{ width: 200 }}
                                />
                                <input
                                    className="input"
                                    value={metaDesc}
                                    onChange={e => setMetaDesc(e.target.value)}
                                    placeholder="Project description"
                                    style={{ width: 300 }}
                                />
                                <button className="btn btn-primary btn-sm" onClick={handleSaveMeta}>
                                    <Check size={14} />
                                </button>
                                <button className="btn btn-secondary btn-sm" onClick={() => { setEditingMeta(false); setMetaSecDesc(assembly.secondaryDescription || ''); }}>
                                    <X size={14} />
                                </button>
                            </div>
                            <input
                                className="input"
                                value={metaSecDesc}
                                onChange={e => setMetaSecDesc(e.target.value)}
                                placeholder="Secondary description"
                                style={{ width: 508 }}
                            />
                        </div>
                    ) : (
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
                            <div style={{ padding: 8, background: 'rgba(26, 115, 232, 0.1)', borderRadius: 8, color: 'var(--sky)' }}>
                                <GitBranch size={24} />
                            </div>
                            <div>
                                <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
                                    {assembly.name}
                                    <span className="badge badge-un" style={{ fontSize: '0.75rem' }}>v{assembly.version}</span>
                                    <button className="btn btn-ghost btn-xs" style={{ color: 'var(--text-muted)' }} onClick={() => { setMetaName(assembly.name); setMetaDesc(assembly.description); setMetaSecDesc(assembly.secondaryDescription || ''); setEditingMeta(true); }}>
                                        <Pencil size={12} />
                                    </button>
                                </h2>
                                <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                                    {assembly.description || 'No description'}
                                </p>
                                {assembly.secondaryDescription && (
                                    <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                        {assembly.secondaryDescription}
                                    </p>
                                )}
                            </div>
                        </div>
                    )}
                    <div className="level-segmented" style={{ padding: 0 }}>
                        <button className={`segment ${viewMode === 'tree' && !showSbom ? 'active' : ''}`} onClick={() => { setViewMode('tree'); setShowSbom(false); }}>
                            <GitBranch size={14} /> <span>Tree</span>
                        </button>
                        <button className={`segment ${viewMode === 'topology' && !showSbom ? 'active' : ''}`} onClick={() => { setViewMode('topology'); setShowSbom(false); }}>
                            <Network size={14} /> <span>Topology</span>
                        </button>
                        <button className={`segment ${showSbom ? 'active' : ''}`} onClick={() => setShowSbom(true)}>
                            <HardDrive size={14} /> <span>SBOM</span>
                        </button>
                    </div>
                </div>
            </div>

            {showSbom && <SbomEditor machine />}

            {showSbom ? null : viewMode === 'topology' ? (
                <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
                    <NetworkTopology sbom={assembly.sbom || []} />
                </div>
            ) : (
                <div className="asm-content">
                    {/* ── 1. Library (drag source) ── */}
                    {panels.lib ? (
                        <div className="asm-lib-panel">
                            <div className="asm-panel-head">
                                <span className="asm-panel-title"><LibraryIcon size={14} /> Library</span>
                                <div className="lib-level-toggle">
                                    {(['UN', 'EM', 'CM', 'FB'] as const).map(lvl => (
                                        <button key={lvl} className={`lib-lv ${libTab === lvl ? 'active' : ''}`} onClick={() => setLibTab(lvl)}>{lvl}</button>
                                    ))}
                                </div>
                                <button className="btn-icon asm-collapse-btn" title="Collapse Library" onClick={() => togglePanel('lib')}><PanelLeftClose size={15} /></button>
                            </div>
                            <div className="asm-panel-search">
                                <Search size={14} />
                                <input placeholder="Search the library..." value={libFilter} onChange={e => setLibFilter(e.target.value)} />
                            </div>
                            <div className="asm-lib-list">
                                {codebase && hiddenCount > 0 && (
                                    <p className="asm-empty-text" style={{ marginBottom: 6 }}>{hiddenCount} {libTab} block(s) hidden: not Released in the code base (adjust or release them to use them).</p>
                                )}
                                {libraryItems.length === 0 ? (
                                    <p className="asm-empty-text">No items found.</p>
                                ) : (
                                    libraryItems.map(item => <DraggableEntity key={item.id} entity={item} />)
                                )}
                            </div>
                        </div>
                    ) : (
                        <PanelRail label="Library" icon={LibraryIcon} onExpand={() => togglePanel('lib')} />
                    )}

                    {/* ── 2. Albero (drop target) ── */}
                    {panels.tree ? (
                        <div className="asm-tree-panel">
                            <div className="asm-panel-head">
                                <span className="asm-panel-title"><GitBranch size={14} /> Tree</span>
                                <span className="badge badge-secondary" style={{ marginLeft: 'auto' }}>{assembly.tree.length} root nodes</span>
                                <button className="btn-icon asm-collapse-btn" title="Collapse Tree" onClick={() => togglePanel('tree')}><PanelLeftClose size={15} /></button>
                            </div>
                            <div className="asm-tree-list">
                                {assembly.tree.length === 0 ? (
                                    <div className="empty-state-sm" style={{ border: '2px dashed var(--border)', borderRadius: 8, margin: 12 }}>
                                        <GitBranch size={24} />
                                        <p>Drag units from the Library to start building</p>
                                    </div>
                                ) : (
                                    assembly.tree.map(node => renderNode(node))
                                )}
                                <RootDropZone />
                            </div>
                        </div>
                    ) : (
                        <PanelRail label="Tree" icon={GitBranch} onExpand={() => togglePanel('tree')} />
                    )}

                    {/* ── 3. Mind Map / Detail ── */}
                    {panels.mind ? (
                        <div className="asm-detail-panel">
                            <div className="asm-panel-head">
                                <span className="asm-panel-title"><Workflow size={14} /> {selectedEntity ? 'Node details' : 'Mind Map'}</span>
                                {selectedEntity && (
                                    <button className="btn btn-ghost btn-xs" style={{ marginLeft: 8 }} onClick={() => setSelectedAsmNodeId(null)}>
                                        <X size={12} /> Mind Map
                                    </button>
                                )}
                                <button className="btn-icon asm-collapse-btn" style={{ marginLeft: 'auto' }} title="Collapse" onClick={() => togglePanel('mind')}><PanelRightClose size={15} /></button>
                            </div>
                            <div className="asm-detail-body">
                    {selectedEntity ? (
                        <div className="asm-detail-content" style={{ maxWidth: 800, margin: '0 auto' }}>
                            {/* Breadcrumb */}
                            <div className="breadcrumb">
                                <GitBranch size={14} style={{ marginRight: 4 }} />
                                {breadcrumb.map((item, i) => (
                                    <React.Fragment key={i}>
                                        {i > 0 && <ChevronRight size={12} className="breadcrumb-sep" />}
                                        <span className={i === breadcrumb.length - 1 ? 'breadcrumb-current' : ''}>
                                            {item}
                                        </span>
                                    </React.Fragment>
                                ))}
                            </div>

                            {/* Header */}
                            <div className="card" style={{ marginBottom: 24 }}>
                                <div className="card-body">
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                            <div style={{
                                                padding: 10, borderRadius: 8,
                                                background: `rgba(var(--${selectedEntity.level === 'UN' ? 'un' : selectedEntity.level === 'EM' ? 'em' : 'cm'}-color-rgb), 0.1)`,
                                                color: `var(--${selectedEntity.level === 'UN' ? 'un' : selectedEntity.level === 'EM' ? 'em' : 'cm'}-color)`
                                            }}>
                                                {levelIcon(selectedEntity.level)}
                                            </div>
                                            <div>
                                                <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>{selectedEntity.name}</h1>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                                                    <span className={`badge badge-${selectedEntity.level.toLowerCase()}`}>{selectedEntity.level}</span>
                                                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>v{selectedEntity.currentVersion}</span>
                                                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>• {selectedEntity.lastModifiedBy || 'Unknown Author'}</span>
                                                </div>
                                            </div>
                                        </div>
                                        <button
                                            className="btn btn-secondary btn-sm"
                                            title="Rebuilds the child nodes from the EM/CM/FB currently assigned in Architecture (assignments changed after dragging do not propagate on their own)"
                                            onClick={() => {
                                                if (confirm('Rebuild the child nodes of this item from the current Architecture assignments? Any manual additions under this node will be replaced.')) {
                                                    refreshAssemblyNode(selectedAsmNode!.id);
                                                }
                                            }}
                                        >
                                            <RefreshCw size={14} /> Refresh from Architecture
                                        </button>
                                    </div>
                                    <p style={{ color: 'var(--text-secondary)' }}>{selectedEntity.description || 'No description provided.'}</p>
                                </div>
                            </div>

                            {/* This instance: name, parameters, copies, component choices */}
                            {selectedAsmNode && (
                                <div className="card" style={{ marginBottom: 24 }}>
                                    <div className="card-header"><h3>This instance</h3></div>
                                    <div className="card-body">
                                        <p className="asm-empty-text" style={{ marginTop: 0 }}>
                                            The block is the reusable type; this is one use of it on the machine (for example head 3 of 6).
                                            Name and parameters belong to the machine, not to the code base.
                                        </p>
                                        <div className="instance-row">
                                            <label>Instance name
                                                <input
                                                    key={selectedAsmNode.id + '-label'} className="input input-sm"
                                                    defaultValue={selectedAsmNode.label || ''} placeholder={selectedEntity.name}
                                                    onBlur={e => updateAssemblyNode(selectedAsmNode.id, { label: e.target.value.trim() || undefined })}
                                                />
                                            </label>
                                            <div className="instance-dup">
                                                <label>Copies
                                                    <input className="input input-sm" type="number" min={1} max={50} value={copies} onChange={e => setCopies(Math.max(1, Number(e.target.value) || 1))} style={{ width: 70 }} />
                                                </label>
                                                <button className="btn btn-secondary btn-sm" onClick={() => duplicateAssemblyNode(selectedAsmNode.id, copies)}>
                                                    <Plus size={13} /> Add {copies} cop{copies > 1 ? 'ies' : 'y'}
                                                </button>
                                            </div>
                                        </div>

                                        <h4 className="instance-sub">Parameters</h4>
                                        {(selectedAsmNode.params || []).map(p => (
                                            <div key={p.id} className="instance-param">
                                                <input className="input input-sm" defaultValue={p.name} placeholder="Name, e.g. TorqueSetpoint" onBlur={e => updateAssemblyNode(selectedAsmNode.id, { params: (selectedAsmNode.params || []).map(x => x.id === p.id ? { ...x, name: e.target.value } : x) })} />
                                                <input className="input input-sm" defaultValue={p.value} placeholder="Value" onBlur={e => updateAssemblyNode(selectedAsmNode.id, { params: (selectedAsmNode.params || []).map(x => x.id === p.id ? { ...x, value: e.target.value } : x) })} />
                                                <input className="input input-sm" style={{ width: 70 }} defaultValue={p.unit || ''} placeholder="Unit" onBlur={e => updateAssemblyNode(selectedAsmNode.id, { params: (selectedAsmNode.params || []).map(x => x.id === p.id ? { ...x, unit: e.target.value } : x) })} />
                                                <button className="btn btn-ghost btn-sm" title="Remove" onClick={() => updateAssemblyNode(selectedAsmNode.id, { params: (selectedAsmNode.params || []).filter(x => x.id !== p.id) })}><Trash2 size={12} /></button>
                                            </div>
                                        ))}
                                        <button className="btn btn-secondary btn-sm" onClick={() => updateAssemblyNode(selectedAsmNode.id, { params: [...(selectedAsmNode.params || []), { id: generateId(), name: '', value: '', unit: '' }] })}>
                                            <Plus size={13} /> Add parameter
                                        </button>

                                        {((selectedEntity as any).bom || []).some((p: any) => (p.alternatives || []).length > 0) && (
                                            <>
                                                <h4 className="instance-sub">Components</h4>
                                                {((selectedEntity as any).bom as any[]).filter(p => (p.alternatives || []).length > 0).map(p => (
                                                    <div key={p.id} className="instance-param">
                                                        <span style={{ flex: 1 }}>{p.description || p.code}</span>
                                                        <select
                                                            className="input input-sm" style={{ flex: 2 }}
                                                            value={selectedAsmNode.componentChoice?.[p.id] || ''}
                                                            onChange={e => {
                                                                const next = { ...(selectedAsmNode.componentChoice || {}) };
                                                                if (e.target.value) next[p.id] = e.target.value; else delete next[p.id];
                                                                updateAssemblyNode(selectedAsmNode.id, { componentChoice: next });
                                                            }}
                                                        >
                                                            <option value="">Preferred: {p.code || p.description}</option>
                                                            {(p.alternatives as any[]).map((a, i) => <option key={a.id} value={a.id}>Alternative {i + 1}: {a.code} {a.manufacturer}{a.notes ? ` (${a.notes})` : ''}</option>)}
                                                        </select>
                                                    </div>
                                                ))}
                                            </>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* FBs */}
                            {'assignedFBs' in selectedEntity && (
                                <div className="card" style={{ marginBottom: 24 }}>
                                    <div className="card-header">
                                        <h3>Assigned Function Blocks</h3>
                                    </div>
                                    <div className="card-body">
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                            {((selectedEntity as any).assignedFBs || []).length > 0 ? (
                                                ((selectedEntity as any).assignedFBs as string[]).map(fbId => {
                                                    const fb = library.find(f => f.id === fbId);
                                                    return fb ? (
                                                        <div key={fbId} className="badge badge-fb" style={{ padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
                                                            <BookOpen size={12} /> {fb.name}
                                                        </div>
                                                    ) : null;
                                                })
                                            ) : (
                                                <div style={{ fontStyle: 'italic', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                                                    No FB assigned. Drag library FBs onto this node.
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Details */}
                            <EntityReadonlyView entity={selectedEntity} />
                        </div>
                    ) : (
                        <MachineDiagramView tree={assembly.tree} db={db} onSelectNode={setSelectedAsmNodeId} />
                    )}
                            </div>
                        </div>
                    ) : (
                        <PanelRail label="Mind Map" icon={Workflow} onExpand={() => togglePanel('mind')} />
                    )}
                </div>
            )}
        </div>
    );
};

// ─── Collapsed panel rail (click to expand) ─────────────────
const PanelRail: React.FC<{ label: string; icon: React.ComponentType<any>; onExpand: () => void }> = ({ label, icon: Icon, onExpand }) => (
    <div className="asm-rail" onClick={onExpand} title={`Expand ${label}`}>
        <Icon size={16} />
        <span className="asm-rail-text">{label}</span>
        <ChevronRight size={13} className="asm-rail-chev" />
    </div>
);

// ─── Drag & Drop Components ─────────────────────────────────

const DraggableEntity: React.FC<{ entity: BlockBase }> = ({ entity }) => {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: `lib-${entity.id}`,
        data: { type: 'arch-entity', entityId: entity.id, level: entity.level, name: entity.name }
    });

    const Icon = entity.level === 'UN' ? Box : entity.level === 'EM' ? Cpu : entity.level === 'CM' ? Settings : BookOpen;
    const levelColor = entity.level === 'UN' ? 'var(--un-color)' : entity.level === 'EM' ? 'var(--em-color)' : entity.level === 'CM' ? 'var(--cm-color)' : 'var(--fb-color)';

    return (
        <div
            ref={setNodeRef}
            {...listeners}
            {...attributes}
            style={{
                padding: '10px 12px', borderRadius: 6, border: '1px solid var(--border)',
                background: 'var(--white)', cursor: 'grab', display: 'flex', alignItems: 'center', gap: 10,
                opacity: isDragging ? 0.5 : 1, transition: 'all 0.15s ease'
            }}
            className="hover:bg-bg-alt"
        >
            <div style={{ color: levelColor }}>
                <Icon size={16} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entity.name}</div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entity.description}</div>
            </div>
            <GripVertical size={12} style={{ color: 'var(--text-muted)' }} />
        </div>
    );
};

const DroppableNode: React.FC<{
    node: AssemblyNode; entity: BlockBase; depth: number;
    isSelected: boolean; isExpanded: boolean;
    onToggle: () => void; onSelect: () => void; onRemove: () => void;
}> = ({ node, entity, depth, isSelected, isExpanded, onToggle, onSelect, onRemove }) => {
    const { setNodeRef, isOver } = useDroppable({
        id: `node-${node.id}`,
        data: { type: 'asm-node', nodeId: node.id, nodeLevel: node.level }
    });

    const hasChildren = node.children.length > 0;
    const canAcceptChildren = node.level !== 'FB';
    const Icon = node.level === 'UN' ? Box : node.level === 'EM' ? Cpu : node.level === 'CM' ? Settings : BookOpen;
    const levelColor = node.level === 'UN' ? 'var(--un-color)' : node.level === 'EM' ? 'var(--em-color)' : node.level === 'CM' ? 'var(--cm-color)' : 'var(--fb-color)';

    return (
        <div
            ref={canAcceptChildren ? setNodeRef : null}
            className={`asm-tree-node ${isSelected ? 'selected' : ''}`}
            style={{
                paddingLeft: 12 + depth * 16,
                background: isOver && canAcceptChildren ? 'rgba(26, 115, 232, 0.1)' : undefined
            }}
            onClick={onSelect}
        >
            <div style={{ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: 4 }} onClick={e => { e.stopPropagation(); onToggle(); }}>
                {(hasChildren || canAcceptChildren) && (
                    <button style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--text-muted)', display: 'flex' }}>
                        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                )}
            </div>

            <Icon size={14} style={{ color: levelColor, marginRight: 8 }} />

            <span className="asm-tree-name">
                {node.label || entity.name}
                {node.label && node.label !== entity.name && <span className="asm-tree-type"> {entity.name}</span>}
            </span>

            {isSelected && (
                <button
                    className="btn-icon"
                    onClick={e => { e.stopPropagation(); onRemove(); }}
                    title="Remove"
                    style={{ color: 'var(--red)', width: 24, height: 24, padding: 4 }}
                >
                    <Trash2 size={12} />
                </button>
            )}
        </div>
    );
};

const RootDropZone: React.FC = () => {
    const { setNodeRef, isOver } = useDroppable({
        id: 'asm-root',
        data: { type: 'asm-root' } // Special drop zone for root UNs
    });

    return (
        <div
            ref={setNodeRef}
            style={{
                marginTop: 8, padding: 12, border: '2px dashed var(--border)', borderRadius: 8,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                fontSize: '0.8rem', color: isOver ? 'var(--sky)' : 'var(--text-muted)',
                borderColor: isOver ? 'var(--sky)' : 'var(--border)',
                background: isOver ? 'rgba(26, 115, 232, 0.05)' : 'transparent',
                transition: 'all 0.2s ease'
            }}
        >
            <Plus size={14} />
            <span>Drop Units here</span>
        </div>
    );
};

// ─── Read-only Detail View ──────────────────────────────

const EntityReadonlyView: React.FC<{ entity: BlockBase }> = ({ entity }) => {
    const [tab, setTab] = useState<'variables' | 'alarms' | 'io' | 'dfmea' | 'code'>('variables');

    return (
        <div>
            <div className="tab-bar" style={{ marginBottom: 12 }}>
                {(['variables', 'alarms', 'io', 'dfmea', 'code'] as const).map(t => (
                    <button
                        key={t}
                        className={`tab-btn ${tab === t ? 'active' : ''}`}
                        onClick={() => setTab(t)}
                    >
                        {t === 'variables' ? `Variables (${entity.variables.length})` :
                            t === 'alarms' ? `Alarms (${entity.alarms.length})` :
                                t === 'io' ? `I/O (${entity.io.length})` :
                                    t === 'dfmea' ? `DFMEA (${entity.dfmea.length})` :
                                        'Code'}
                    </button>
                ))}
            </div>

            {tab === 'variables' && (
                entity.variables.length > 0 ? (
                    <table className="data-table">
                        <thead><tr><th>Name</th><th>Type</th><th>Scope</th><th>Description</th></tr></thead>
                        <tbody>
                            {entity.variables.map(v => (
                                <tr key={v.id}><td><code>{v.name}</code></td><td>{v.dataType}</td><td>{v.scope}</td><td>{v.description}</td></tr>
                            ))}
                        </tbody>
                    </table>
                ) : <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No variables.</p>
            )}
            {tab === 'alarms' && (
                entity.alarms.length > 0 ? (
                    <table className="data-table">
                        <thead><tr><th>ID</th><th>Message</th><th>Level</th><th>Action</th><th>Possible Causes</th><th>Possible Solutions</th></tr></thead>
                        <tbody>
                            {entity.alarms.map(a => (
                                <tr key={a.id}><td><code>{a.alarmId}</code></td><td>{a.message}</td><td><span className={`badge badge-${a.level.toLowerCase()}`}>{a.level}</span></td><td>{a.action}</td><td style={{ color: 'var(--text-secondary)' }}>{a.possibleCauses || '—'}</td><td style={{ color: 'var(--text-secondary)' }}>{a.possibleSolutions || '—'}</td></tr>
                            ))}
                        </tbody>
                    </table>
                ) : <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No alarms.</p>
            )}
            {tab === 'io' && (
                entity.io.length > 0 ? (
                    <table className="data-table">
                        <thead><tr><th>Signal ID</th><th>Type</th><th>Address</th><th>Variable</th><th>Description</th></tr></thead>
                        <tbody>
                            {entity.io.map(io => (
                                <tr key={io.id}><td><code>{io.signalId}</code></td><td><span className={`badge badge-${io.signalType.toLowerCase()}`}>{io.signalType}</span></td><td><code>{io.address}</code></td><td>{io.variable}</td><td>{io.description}</td></tr>
                            ))}
                        </tbody>
                    </table>
                ) : <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No I/O signals.</p>
            )}
            {tab === 'dfmea' && (
                entity.dfmea.length > 0 ? (
                    <table className="data-table">
                        <thead><tr><th>Failure Mode</th><th>Effect</th><th>S</th><th>O</th><th>D</th><th>RPN</th><th>Status</th></tr></thead>
                        <tbody>
                            {entity.dfmea.map(d => (
                                <tr key={d.id}>
                                    <td>{d.failureMode}</td><td>{d.effect}</td>
                                    <td>{d.severity}</td><td>{d.occurrence}</td><td>{d.detection}</td>
                                    <td><strong style={{ color: d.rpn >= 100 ? 'var(--color-danger)' : d.rpn >= 50 ? 'var(--color-warning)' : 'var(--color-success)' }}>{d.rpn}</strong></td>
                                    <td><span className={`badge badge-${d.status === 'Verified' ? 'un' : d.status === 'Implemented' ? 'em' : 'cm'}`}>{d.status}</span></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No DFMEA entries.</p>
            )}
            {tab === 'code' && (
                <pre className="code-block" style={{ whiteSpace: 'pre-wrap', background: 'var(--bg-surface)', padding: 16, borderRadius: 8, fontSize: '0.85rem', maxHeight: 400, overflow: 'auto' }}>
                    {entity.code || '// No code defined'}
                </pre>
            )}
        </div>
    );
};
