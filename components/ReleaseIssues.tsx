// ============================================================
// AMA — Release checks of one block: what is wrong, where it is, and
// how to accept it ("Release anyway") when the Product Owner disagrees.
// Used in the Release step and at the top of the block editor.
// ============================================================
import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, ShieldCheck, Undo2 } from 'lucide-react';
import { useStore } from '../lib/store';
import { releaseIssues, errorsOf, type Issue } from '../lib/releaseCheck';
import { releaseBlock, revokeAcceptance } from '../lib/releaseActions';
import { Modal } from './Modal';
import { toast } from './Toaster';
import type { BlockBase } from '../types/machine';

const TAB_LABEL: Record<string, string> = {
    info: 'Info', fbs: 'Sub-Items', variables: 'Variables', code: 'Code', alarms: 'Alarms', io: 'I/O', dfmea: 'DFMEA', bom: 'BOM',
};

export const ReleaseIssues: React.FC<{ block: BlockBase }> = ({ block }) => {
    const navigate = useNavigate();
    const library = useStore(s => s.library);
    const units = useStore(s => s.units);
    const ems = useStore(s => s.equipmentModules);
    const cms = useStore(s => s.controlModules);
    const [accepting, setAccepting] = useState(false);
    const [reason, setReason] = useState('');

    const lists = useMemo(() => ({ library, units, equipmentModules: ems, controlModules: cms }), [library, units, ems, cms]);
    const issues = useMemo(() => releaseIssues(block, lists), [block, lists]);
    const errors = errorsOf(issues);
    const released = block.status === 'Released';
    // a Released block only lists what was accepted when it was released
    const shown = released ? issues.filter(i => i.severity === 'accepted') : issues;
    if (shown.length === 0) return null;

    /** One click: select the block (or the one that is the real problem) and open the tab. */
    const go = (i: Issue) => {
        const all = [...units, ...ems, ...cms, ...library];
        const target = (i.targetId && all.find(x => x.id === i.targetId)) || block;
        useStore.setState({ archTab: target.level, selectedNodeId: target.id, selectedTab: i.tab || 'info', focusItem: i.itemId || null } as any);
        navigate('/');
    };

    const confirm = () => {
        if (!reason.trim()) { toast('Write why the block can be released with these checks.', 'error'); return; }
        const res = releaseBlock(block, reason);
        if (res.ok) { toast(`"${block.name}" released with ${res.blocking.length} accepted check(s).`, 'success'); setAccepting(false); setReason(''); }
    };

    return (
        <div className="release-issues-panel">
            <ul className="release-issues">
                {shown.map((i, k) => (
                    <li key={k} className={i.severity}>
                        <span className="release-issue-text">
                            {i.severity === 'error' ? 'Must fix: ' : i.severity === 'warning' ? 'Check: ' : 'Accepted: '}{i.text}
                            {i.severity === 'accepted' && <span className="release-issue-why"> — {i.by}, {i.date}: “{i.reason}”</span>}
                        </span>
                        {i.severity === 'accepted'
                            ? <button className="btn btn-ghost btn-sm" onClick={() => revokeAcceptance(block, i.text)} title="Stop accepting this check"><Undo2 size={12} /> Revoke</button>
                            : (i.tab || i.targetId) && (
                                <button className="btn btn-secondary btn-sm" onClick={() => go(i)} title="Open the place where it is">
                                    {i.targetId ? 'Open that block' : `Go to ${TAB_LABEL[i.tab!] || i.tab}`} <ArrowRight size={12} />
                                </button>
                            )}
                    </li>
                ))}
            </ul>
            {errors.length > 0 && !released && (
                <div className="release-issues-foot">
                    <span>Disagree with {errors.length > 1 ? 'these errors' : 'this error'}? You can release the block anyway; your reason is kept with it.</span>
                    <button className="btn btn-secondary btn-sm" onClick={() => setAccepting(true)}><ShieldCheck size={13} /> Release anyway…</button>
                </div>
            )}

            <Modal
                open={accepting}
                onClose={() => setAccepting(false)}
                title={`Release "${block.name}" with accepted checks`}
                footer={<>
                    <button className="btn btn-secondary" onClick={() => setAccepting(false)}>Cancel</button>
                    <button className="btn btn-primary" disabled={!reason.trim()} onClick={confirm}>Release anyway</button>
                </>}
            >
                <p style={{ marginTop: 0 }}>These checks will be <strong>accepted</strong>. They stay listed on the block with your name, the date and your reason, and are written to its revision history.</p>
                <ul className="release-issues">{errors.map((i, k) => <li key={k} className="error">{i.text}</li>)}</ul>
                <div className="form-group">
                    <label className="form-label">Why is it correct to release it? (required)</label>
                    <textarea className="form-textarea" autoFocus value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Tested on machine M1234; this block has no I/O by design." />
                </div>
            </Modal>
        </div>
    );
};
