// ============================================================
// AMA — SBOM editor: the bill of materials (hardware, software, network,
// services) of a machine or of the code base's reference hardware.
// Rows derived from the code base can be changed per machine (overrides);
// rows added by hand are fully editable.
// ============================================================
import React, { useState } from 'react';
import { HardDrive, Plus, Trash2, Pencil, Check, Link2, RotateCcw, Download } from 'lucide-react';
import { useStore } from '../lib/store';
import { newSbomItem } from '../lib/hardware';
import { hardwareFromCodebase } from '../lib/codebaseActions';
import type { BomItemType, HardwareItem } from '../types/machine';

export const SbomEditor: React.FC<{ machine: boolean }> = ({ machine }) => {
    const assembly = useStore(s => s.assembly);
    const codebase = useStore(s => s.codebase);
    const [editingSbomId, setEditingSbomId] = useState<string | null>(null);
    const addRow = (type: BomItemType) => {
        const item = newSbomItem(type);
        useStore.getState().updateAssemblySBOM([...(assembly.sbom || []), item]);
        setEditingSbomId(item.id);
    };
    return (
                <div style={{ padding: '16px 24px', background: 'var(--white)', flex: 1, overflowY: 'auto' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <h3 style={{ margin: 0, fontSize: '1.1rem', display: 'flex', alignItems: 'center', gap: 8 }}>
                            <HardDrive size={18} /> {machine ? 'Machine Bill of Materials (SBOM)' : 'Reference hardware and software (SBOM)'}
                        </h3>
                        <div style={{ display: 'flex', gap: 6 }}>
                            {machine && !!codebase?.path && (
                                <button className="btn btn-secondary btn-sm" onClick={hardwareFromCodebase} title="Add the hardware the code base lists that this machine does not have yet. Nothing you have is removed or replaced.">
                                    <Download size={14} /> From code base
                                </button>
                            )}
                            <button className="btn btn-primary btn-sm" onClick={() => addRow('Hardware')}><Plus size={14} /> Hardware</button>
                            <button className="btn btn-primary btn-sm" onClick={() => addRow('Software')}><Plus size={14} /> Software</button>
                            <button className="btn btn-secondary btn-sm" onClick={() => addRow('Network')}><Plus size={14} /> Network</button>
                        </div>
                    </div>
                    <p style={{ margin: '0 0 12px', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                        {machine ? (<>
                            Rows with <Link2 size={11} style={{ verticalAlign: -1 }} /> come from the code base (quantity = parts × assembled instances). This machine can differ: edit the quantity, code or name for a customer change, or take a part off; it is marked "machine change" and survives code base refreshes. Hardware and software you add here (a drive the customer asked for, a licence, a switch) are fully editable and go to the exported SBOM.
                        </>) : (<>
                            The standard hardware and software of this code base. A machine can start from it (<em>From code base</em>) and then change it for a customer. Import it from a PLC project (TIA Portal or Studio 5000) or add it by hand; save the code base to keep it.
                        </>)}
                    </p>
                    {(!assembly.sbom || assembly.sbom.length === 0) ? (
                        <div className="empty-state-sm">{machine ? 'No components. Fill in the entity bills of materials in Architecture and assemble the machine, or add items manually.' : 'No hardware yet. Import a TIA Portal or Studio 5000 project (ribbon) or add items here.'}</div>
                    ) : (
                        <table className="data-table" style={{ marginTop: 8 }}>
                            <thead>
                                <tr>
                                    <th style={{ width: 96 }}>Type</th>
                                    <th style={{ width: 130 }}>Code</th>
                                    <th>Component</th>
                                    <th style={{ width: 120 }}>IP / Config</th>
                                    <th style={{ width: 110 }}>Version / FW</th>
                                    <th style={{ width: 56 }}>Qty</th>
                                    <th style={{ width: 150 }}>Zone / VLAN</th>
                                    <th>Notes</th>
                                    <th style={{ width: 70 }}></th>
                                </tr>
                            </thead>
                            <tbody>
                                {assembly.sbom.map((item) => {
                                    const derived = !!item.sourcePartId;
                                    const patch = (updates: Partial<HardwareItem>) => {
                                        useStore.getState().updateAssemblySBOM(
                                            assembly.sbom.map(i => i.id === item.id ? { ...i, ...updates } : i)
                                        );
                                    };
                                    const editing = editingSbomId === item.id;
                                    // On a row derived from the code base, edits are machine-specific overrides
                                    const setField = (field: 'supplierCode' | 'hardware' | 'quantity', value: string | number) => {
                                        if (derived) useStore.getState().overrideSbomRow(item.id, { ...(item.overrides || {}), [field]: value });
                                        else patch({ [field]: value } as Partial<HardwareItem>);
                                    };
                                    const changed = derived && !!item.overrides && Object.keys(item.overrides).length > 0;
                                    return (
                                        <tr key={item.id}>
                                            <td>
                                                {editing && !derived ? (
                                                    <select className="input input-sm" defaultValue={item.type || 'Hardware'} onChange={e => patch({ type: e.target.value as any })}>
                                                        {['Hardware', 'Software', 'Network', 'Service', 'Security'].map(t => <option key={t} value={t}>{t}</option>)}
                                                    </select>
                                                ) : (
                                                    <span className={`badge badge-tipo-${(item.type || 'Hardware').toLowerCase()}`}>{item.type || 'Hardware'}</span>
                                                )}
                                            </td>
                                            <td>
                                                {editing ? (
                                                    <input className="input input-sm mono" defaultValue={item.supplierCode || ''} placeholder="Supplier code" onBlur={e => setField('supplierCode', e.target.value)} />
                                                ) : (
                                                    <div style={{ lineHeight: 1.3 }}>
                                                        {item.internalCode && <div className="mono" style={{ fontSize: '0.75rem' }}>{item.internalCode}</div>}
                                                        <div className="mono" style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{item.supplierCode || '-'}</div>
                                                    </div>
                                                )}
                                            </td>
                                            <td>
                                                {editing ? (
                                                    <input className="input input-sm" defaultValue={item.hardware} placeholder="Name / model" onBlur={e => setField('hardware', e.target.value)} />
                                                ) : (
                                                    <div style={{ lineHeight: 1.3 }}>
                                                        <div>
                                                            {derived && <Link2 size={11} style={{ verticalAlign: -1, marginRight: 5, color: 'var(--sky)' }} />}
                                                            {item.hardware || '-'}
                                                            {changed && <span className="badge badge-warning" style={{ marginLeft: 6, fontSize: '0.62rem', padding: '1px 5px' }} title="Different from the code base on purpose (customer change)">machine change</span>}
                                                        </div>
                                                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                                                            {[item.manufacturer, derived ? item.sourceEntity : null].filter(Boolean).join(' · ')}
                                                        </div>
                                                    </div>
                                                )}
                                            </td>
                                            <td>
                                                {editing ? (
                                                    <input className="input input-sm mono" defaultValue={item.ipAddress || ''} placeholder="192.168.1.x" onBlur={e => patch({ ipAddress: e.target.value })} />
                                                ) : <span className="mono" style={{ fontSize: '0.75rem' }}>{item.ipAddress || '-'}</span>}
                                            </td>
                                            <td>
                                                {editing ? (
                                                    <input className="input input-sm" defaultValue={item.firmware} placeholder="e.g. v7.001" onBlur={e => patch({ firmware: e.target.value })} />
                                                ) : (item.firmware || '-')}
                                            </td>
                                            <td style={{ textAlign: 'center' }}>
                                                {editing ? (
                                                    <input className="input input-sm" type="number" min={0} defaultValue={item.quantity} onBlur={e => setField('quantity', Math.max(0, parseInt(e.target.value) || 0))} />
                                                ) : `${item.quantity}${item.unit && item.unit !== 'pz' ? ` ${item.unit}` : ''}`}
                                            </td>
                                            <td>
                                                {editing ? (
                                                    <div style={{ display: 'flex', gap: 4 }}>
                                                        <input className="input input-sm" style={{ width: 78 }} placeholder="Zone" defaultValue={item.securityZone || ''} onBlur={e => patch({ securityZone: e.target.value })} />
                                                        <input className="input input-sm" style={{ width: 52 }} placeholder="VLAN" defaultValue={item.vlanId || ''} onBlur={e => patch({ vlanId: e.target.value })} />
                                                    </div>
                                                ) : (
                                                    item.securityZone || item.vlanId ? (
                                                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                                            {item.securityZone && <span className="badge badge-warning" style={{ fontSize: '0.65rem', padding: '2px 6px' }}>{item.securityZone}</span>}
                                                            {item.vlanId && <span className="badge badge-success" style={{ fontSize: '0.65rem', padding: '2px 6px' }}>VLAN {item.vlanId}</span>}
                                                        </div>
                                                    ) : '-'
                                                )}
                                            </td>
                                            <td>
                                                {editing ? (
                                                    <input className="input input-sm" defaultValue={item.notes} onBlur={e => patch({ notes: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') setEditingSbomId(null); }} />
                                                ) : (item.notes || '-')}
                                            </td>
                                            <td>
                                                <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                                                    {editing ? (
                                                        <button className="btn-icon" title="Done editing" onClick={() => setEditingSbomId(null)}><Check size={14} style={{ color: 'var(--green)' }} /></button>
                                                    ) : (
                                                        <button className="btn-icon" title={derived ? 'Edit firmware / IP / zone / notes' : 'Edit'} onClick={() => setEditingSbomId(item.id)}><Pencil size={14} /></button>
                                                    )}
                                                    {changed && !editing && (
                                                        <button className="btn-icon" title="Back to the code base values" onClick={() => useStore.getState().overrideSbomRow(item.id, null)}><RotateCcw size={14} /></button>
                                                    )}
                                                    {!editing && (
                                                        <button className="btn-icon" title={derived ? 'Take this part off this machine' : 'Delete'} onClick={() => {
                                                            if (derived) useStore.getState().removeSbomPart(item.id);
                                                            else useStore.getState().updateAssemblySBOM(assembly.sbom.filter(i => i.id !== item.id));
                                                        }}><Trash2 size={14} style={{ color: 'var(--red)' }} /></button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                    {(assembly.sbomRemoved || []).length > 0 && (
                        <div style={{ marginTop: 16 }}>
                            <h4 style={{ fontSize: '0.8rem', margin: '0 0 6px' }}>Taken off this machine ({assembly.sbomRemoved!.length})</h4>
                            {assembly.sbomRemoved!.map(r => (
                                <div key={r.partId} className="instance-param">
                                    <span style={{ flex: 1 }}>{r.label}</span>
                                    <button className="btn btn-secondary btn-sm" onClick={() => useStore.getState().restoreSbomPart(r.partId)}>Put back</button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
    );
};
