// ============================================================
// AMA — Export Page
// ============================================================
import React, { useMemo, useState, useEffect } from 'react';
import { useStore } from '../lib/store';
import {
    generateFDS, flattenAlarms, flattenIO, flattenVariables, flattenDFMEA, safeFileName,
    type EntityDB,
} from '../lib/helpers';
import { downloadAsZip, importGitZip } from '../lib/gitExport';
import { PROJECT_SCHEMA_VERSION } from '../lib/normalize';
import { downloadL5X } from '../lib/l5xExport';
import { exportTiaPackage } from '../lib/tiaExport';
import { compareArchitectures, type CompareReport } from '../lib/compare';
import { isElectron, openProjectFromFile, getOsUsername } from '../lib/persistence';
import { validateProject, type ValidationReport, type ValidationIssue } from '../lib/validation';
import { importL5X, type L5xImportResult } from '../lib/l5xImport';
import { useCommands } from '../lib/commands';
import { Modal } from '../components/Modal';
import { toast } from '../components/Toaster';
import {
    Download, FileJson, FileSpreadsheet, FileText, Code,
    Upload, Package, RefreshCw, FolderGit2, CheckSquare, Timer,
    Database, Server, ShieldAlert, Cpu, Share2, Layers, BookOpen, Trash2,
    AlertCircle, AlertTriangle, Info, CheckCircle, GitCommit, FolderOpen, History,
} from 'lucide-react';
import { saveAs } from 'file-saver';

export const ExportPage: React.FC = () => {
    const library = useStore(s => s.library);
    const units = useStore(s => s.units);
    const ems = useStore(s => s.equipmentModules);
    const cms = useStore(s => s.controlModules);
    const assembly = useStore(s => s.assembly);
    const codebase = useStore(s => s.codebase);
    const loadProject = useStore(s => s.loadProject);
    const loadArchitecture = useStore(s => s.loadArchitecture);
    const resetToDefaults = useStore(s => s.resetToDefaults);
    const clearWorkspace = useStore(s => s.clearWorkspace);

    const db: EntityDB = useMemo(() => ({
        library, units, equipmentModules: ems, controlModules: cms,
    }), [library, units, ems, cms]);

    // RFC 4180 CSV field: quote everything, double inner quotes
    const csv = (v: any): string => `"${String(v ?? '').replace(/"/g, '""')}"`;
    // download filenames derive from the project name — sanitized for the OS
    const fileBase = safeFileName(assembly.name);

    // ─── Pre-flight Validation ────────────────────────────────
    const [report, setReport] = useState<ValidationReport | null>(null);
    const [reportOpen, setReportOpen] = useState(false);

    // ─── Architecture / Library comparison ────────────────────
    const [compareReport, setCompareReport] = useState<CompareReport | null>(null);
    const [compareOpen, setCompareOpen] = useState(false);
    const [compareFileName, setCompareFileName] = useState('');

    const handleCompare = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,.zip';
        input.onchange = async (e: any) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                let data: any;
                if (file.name.toLowerCase().endsWith('.zip')) {
                    data = await importGitZip(file);
                } else {
                    data = JSON.parse(await file.text());
                }
                if (!data || !(data.library || data.units || data.equipmentModules || data.controlModules)) {
                    toast('The file contains no comparable architecture data.');
                    return;
                }
                setCompareFileName(file.name);
                setCompareReport(compareArchitectures(db, data));
                setCompareOpen(true);
            } catch {
                toast('Unable to read the selected file.');
            }
        };
        input.click();
    };

    const handleVerify = () => {
        setReport(validateProject(assembly, db, { requireReleased: !!codebase, codebase: codebase ?? null }));
        setReportOpen(true);
    };

    // Run validation before the Git ZIP export; block on errors unless confirmed
    const handleGitZip = async () => {
        const r = validateProject(assembly, db, { requireReleased: !!codebase, codebase: codebase ?? null });
        if (r.errors > 0) {
            setReport(r);
            setReportOpen(true);
            if (!confirm(`The project contains ${r.errors} ${r.errors === 1 ? 'error' : 'errors'} (see the report). The generated files may produce incorrect PLC code.

Export anyway?`)) {
                return;
            }
        }
        await downloadAsZip(assembly, db);
    };

    // ─── Native menu actions (File→Esporta…, Strumenti) land here ──
    const menuActionsRef = React.useRef<Record<string, () => void>>({});
    useEffect(() => {
        const handler = (e: Event) => {
            const action = (e as CustomEvent).detail as string;
            menuActionsRef.current[action]?.();
        };
        window.addEventListener('ama-export-action', handler);
        return () => window.removeEventListener('ama-export-action', handler);
    }, []);

    // IDs of entities actually placed in the assembly tree
    const assembledIds = useMemo(() => {
        const ids = new Set<string>();
        const walk = (nodes: any[]) => {
            for (const n of nodes) {
                if (n.refId) ids.add(n.refId);
                if (n.children) walk(n.children);
            }
        };
        walk(assembly.tree);
        return ids;
    }, [assembly.tree]);

    // ─── Export Handlers ──────────────────────────────────────
    const exportJSON = () => {
        const data = JSON.stringify({ schemaVersion: PROJECT_SCHEMA_VERSION, library, units, equipmentModules: ems, controlModules: cms, assembly }, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        saveAs(blob, `${fileBase}_project.json`);
    };

    // ─── TIA Portal (Openness): sources + hardware.json + C# builder ──
    const handleTia = async () => {
        if (!isElectron()) {
            toast('TIA Portal export is only available in the desktop app.');
            return;
        }
        try {
            const res = await exportTiaPackage(assembly, db);
            if (res.canceled) return;
            if (res.ok) toast(`TIA Openness package written (${res.count} files) in ${res.dir}`, 'success');
            else toast(res.error || 'TIA export failed.');
        } catch {
            toast('TIA export failed.');
        }
    };

    const exportVariablesCSV = () => {
        const vars = flattenVariables(db);
        let out = 'Name,DataType,Scope,Address,Description,Owner\n';
        vars.forEach(v => {
            out += [csv(v.name), csv(v.dataType), csv(v.scope), csv(v.address), csv(v.description), csv(v.owner)].join(',') + '\n';
        });
        saveAs(new Blob([out], { type: 'text/csv' }), `${fileBase}_variables.csv`);
    };

    const exportAlarmsCSV = () => {
        const alarms = flattenAlarms(db);
        let out = 'AlarmID,Message,Level,TriggerVariable,Action,PossibleCauses,PossibleSolutions,Owner\n';
        alarms.forEach(a => {
            out += [csv(a.alarmId), csv(a.message), csv(a.level), csv(a.triggerVariable), csv(a.action), csv((a as any).possibleCauses), csv((a as any).possibleSolutions), csv(a.owner)].join(',') + '\n';
        });
        saveAs(new Blob([out], { type: 'text/csv' }), `${fileBase}_alarms.csv`);
    };

    const exportIOCSV = () => {
        const io = flattenIO(db);
        let out = 'SignalID,Type,Address,Variable,DataType,Description,Owner\n';
        io.forEach(s => {
            out += [csv(s.signalId), csv(s.signalType), csv(s.address), csv(s.variable), csv(s.dataType), csv(s.description), csv(s.owner)].join(',') + '\n';
        });
        saveAs(new Blob([out], { type: 'text/csv' }), `${fileBase}_io.csv`);
    };

    const exportDFMEACSV = () => {
        const dfmea = flattenDFMEA(db);
        let out = 'FailureMode,Effect,Cause,Severity,Occurrence,Detection,RPN,Controls,Actions,Status,Owner\n';
        dfmea.forEach(d => {
            out += [csv(d.failureMode), csv(d.effect), csv(d.cause), d.severity, d.occurrence, d.detection, d.rpn, csv(d.controls), csv(d.actions), csv(d.status), csv(d.owner)].join(',') + '\n';
        });
        saveAs(new Blob([out], { type: 'text/csv' }), `${fileBase}_dfmea.csv`);
    };

    const exportFDS = () => {
        const md = generateFDS(assembly, db);
        saveAs(new Blob([md], { type: 'text/markdown' }), `${fileBase}_FDS.md`);
    };

    const exportSTCode = () => {
        // Only code from entities assembled on this machine; with an empty
        // assembly tree there is nothing to scope by, so export everything.
        const scoped = assembledIds.size > 0;
        const inScope = (e: { id: string }) => !scoped || assembledIds.has(e.id);
        let allCode = '';
        const allEntities = [...units, ...ems, ...cms].filter(inScope);
        for (const e of allEntities) {
            if (e.code) allCode += `// === ${e.name} ===\n${e.code}\n\n`;
        }
        for (const fb of library.filter(inScope)) {
            if (fb.code) allCode += `// === ${fb.name} (Library) ===\n${fb.code}\n\n`;
        }
        saveAs(new Blob([allCode], { type: 'text/plain' }), `${fileBase}_code.st`);
    };

    // ─── BOM Acquisti: the machine SBOM is the single source of truth ──
    // (rows derived from the Architecture entity BOMs are already there,
    // with quantities multiplied by the assembled instances)
    const exportProcurementBOM = () => {
        const sbom = assembly.sbom || [];
        if (sbom.length === 0) {
            toast('SBOM is empty: fill in the entity bills of materials in Architecture and assemble the machine, or add items to the SBOM manually.');
            return;
        }
        let out = 'InternalCode,SupplierCode,Description,Manufacturer,Type,Quantity,Unit,FWVersion,UsedIn,Notes';
        const sorted = [...sbom].sort((a, b) =>
            `${a.type || 'Hardware'}${a.supplierCode || a.hardware}`.localeCompare(`${b.type || 'Hardware'}${b.supplierCode || b.hardware}`));
        for (const r of sorted) {
            const supplierCode = r.supplierCode || (r.hardware.match(/\(([^)]+)\)/) || [])[1] || '';
            out += [
                csv(r.internalCode || ''), csv(supplierCode), csv(r.hardware), csv(r.manufacturer || ''),
                csv(r.type || 'Hardware'), r.quantity, csv(r.unit || 'pz'), csv(r.firmware || ''),
                csv(r.sourceEntity || 'Machine'), csv(r.notes || ''),
            ].join(',') + '\n';
        }
        saveAs(new Blob([out], { type: 'text/csv' }), `${fileBase}_purchasing_BOM.csv`);
    };

    const exportDevTimesTXT = () => {
        // Aggregate times from ASSEMBLED entities
        const usedEntityIds = new Set<string>();
        const traverse = (nodes: any[]) => {
            for (const node of nodes) {
                if (node.refId) usedEntityIds.add(node.refId);
                if (node.children) traverse(node.children);
            }
        };
        traverse(assembly.tree);

        const allEntities = [...units, ...ems, ...cms];
        let totalPLC = 0;
        let totalHMI = 0;
        let totalComm = 0;

        const details: any[] = [];

        allEntities.forEach(e => {
            if (usedEntityIds.has(e.id)) {
                const times = (e as any).devTimes || { plcHours: 0, hmiHours: 0, commissioningHours: 0 };
                // Only include if non-zero
                if (times.plcHours > 0 || times.hmiHours > 0 || times.commissioningHours > 0) {
                    totalPLC += times.plcHours || 0;
                    totalHMI += times.hmiHours || 0;
                    totalComm += times.commissioningHours || 0;
                    details.push({
                        name: e.name,
                        level: e.level,
                        plc: times.plcHours || 0,
                        hmi: times.hmiHours || 0,
                        commissioning: times.commissioningHours || 0
                    });
                }
            }
        });

        let txt = `DEV TIMES REPORT\n================\n`;
        txt += `Project:   ${assembly.name}\n`;
        txt += `Generated: ${new Date().toLocaleString()}\n\n`;

        txt += `TOTAL ESTIMATED HOURS\n---------------------\n`;
        txt += `PLC Software:  ${totalPLC} h\n`;
        txt += `HMI Software:  ${totalHMI} h\n`;
        txt += `Commissioning: ${totalComm} h\n`;
        txt += `TOTAL:         ${totalPLC + totalHMI + totalComm} h\n\n`;

        txt += `DETAILED BREAKDOWN\n------------------\n`;
        if (details.length === 0) {
            txt += `No timed entities found in assembly.\n`;
        } else {
            details.forEach(d => {
                txt += `[${d.level}] ${d.name}\n`;
                txt += `  PLC: ${d.plc}h | HMI: ${d.hmi}h | Comm: ${d.commissioning}h\n\n`;
            });
        }

        const blob = new Blob([txt], { type: 'text/plain' });
        saveAs(blob, `${fileBase}_dev_times.txt`);
    };

    // Ribbon commands (step 5)
    useCommands({
        'data:verify': handleVerify,
        'data:compare': handleCompare,
        'data:l5x': () => downloadL5X(assembly, db),
        'data:tia': handleTia,
        'data:st': exportSTCode,
        'data:json': exportJSON,
        'data:gitzip': handleGitZip,
        'data:bom': exportProcurementBOM,
        'data:fds': exportFDS,
        'data:dev-times': exportDevTimesTXT,
        'data:csv-vars': exportVariablesCSV,
        'data:csv-alarms': exportAlarmsCSV,
        'data:csv-io': exportIOCSV,
        'data:csv-dfmea': exportDFMEACSV,
    });

    // Keep the native-menu action map pointing at the latest handlers
    menuActionsRef.current = {
        'export:gitzip': handleGitZip,
        'export:l5x': () => downloadL5X(assembly, db),
        'export:bom': exportProcurementBOM,
        'export:fds': exportFDS,
        'tools:verify': handleVerify,
        'tools:compare': handleCompare,
    };

    // ─── Export Cards (grouped) ───────────────────────────────
    const exports = [
        { group: 'Project & Version Control', icon: <Database size={24} />, title: 'Full Project JSON', desc: 'Complete project data. Save/restore your work.', color: 'var(--sky)', bg: 'rgba(45, 212, 191, 0.1)', action: exportJSON },
        { group: 'Project & Version Control', icon: <FolderGit2 size={24} />, title: 'ZIP for Git', desc: 'One JSON per assembled entity + SCL scaffolding, PLC tags and HMI alarms. Re-importable.', color: 'var(--cm-color)', bg: 'var(--orange-bg)', action: handleGitZip },
        { group: 'Documentation & Analysis', icon: <BookOpen size={24} />, title: 'FDS Documentation', desc: 'FDS generated automatically from the Assembly tree.', color: 'var(--purple)', bg: 'var(--purple-bg)', action: exportFDS },
        { group: 'Documentation & Analysis', icon: <FileSpreadsheet size={24} />, title: 'Variables CSV', desc: 'All variables across the whole architecture.', color: 'var(--un-color)', bg: 'rgba(45, 212, 191, 0.1)', action: exportVariablesCSV },
        { group: 'Documentation & Analysis', icon: <ShieldAlert size={24} />, title: 'Alarms CSV', desc: 'All alarms with ID, levels, triggers.', color: 'var(--red)', bg: 'var(--red-bg)', action: exportAlarmsCSV },
        { group: 'Documentation & Analysis', icon: <Share2 size={24} />, title: 'I/O Signals CSV', desc: 'All I/O signals with addresses.', color: 'var(--em-color)', bg: 'var(--green-bg)', action: exportIOCSV },
        { group: 'Documentation & Analysis', icon: <FileText size={24} />, title: 'CSV DFMEA', desc: 'Full DFMEA matrix with RPN.', color: 'var(--yellow)', bg: 'var(--yellow-bg)', action: exportDFMEACSV },
        { group: 'PLC Code', icon: <Code size={24} />, title: 'Structured Text Package', desc: 'Structured Text code of the entities assembled on the machine.', color: 'var(--text)', bg: 'rgba(255,255,255,0.05)', action: exportSTCode },
        { group: 'PLC Code', icon: <Cpu size={24} />, title: 'L5X Studio 5000', desc: 'Controller project importable in Studio 5000: programs, tags, I/O aliases, AOIs and EtherNet/IP hardware.', color: 'var(--red)', bg: 'var(--red-bg)', action: () => downloadL5X(assembly, db) },
        { group: 'PLC Code', icon: <Cpu size={24} />, title: 'TIA Portal (Openness)', desc: 'Complete package: SCL/UDT sources, hardware with exact order numbers, tags and a C# TIA Openness builder that builds the project on the engineering PC. Blocks imported from TIA Portal go back as the original objects (LAD/FBD/SCL as they were).', color: 'var(--sky)', bg: 'rgba(45, 212, 191, 0.1)', action: handleTia },
        { group: 'Purchasing', icon: <Package size={24} />, title: 'Purchasing BOM (CSV)', desc: 'Machine bill of materials from the SBOM: internal/supplier codes, type, quantity and firmware. Ready for purchasing.', color: 'var(--green)', bg: 'var(--green-bg)', action: exportProcurementBOM },
    ];
    const exportGroups = ['PLC Code', 'Documentation & Analysis', 'Purchasing', 'Project & Version Control'];

    return (
        <div>
            <div className="page-header">
                <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Download size={24} style={{ color: 'var(--sky)' }} />
                    Verify and export
                </h1>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: 4 }}>
                    First use <strong>Verify project</strong> in the bar above, then generate what you need.
                </p>
            </div>

            <div className="export-grid">
                {exportGroups.map(group => (
                    <React.Fragment key={group}>
                        <div className="export-group-title">{group}</div>
                        {exports.filter(e => e.group === group).map((exp, i) => (
                            <div key={`${group}-${i}`} className="export-card">
                                <div className="export-icon" style={{ background: exp.bg, color: exp.color }}>
                                    {exp.icon}
                                </div>
                                <h3>{exp.title}</h3>
                                <p>{exp.desc}</p>
                                <button className="btn btn-secondary" onClick={exp.action}>
                                    <Download size={14} /> Download
                                </button>
                            </div>
                        ))}
                    </React.Fragment>
                ))}
            </div>

            <ValidationReportModal open={reportOpen} report={report} onClose={() => setReportOpen(false)} />
            <CompareReportModal open={compareOpen} report={compareReport} fileName={compareFileName} onClose={() => setCompareOpen(false)} />
        </div>
    );
};

// ─── Architecture Comparison Modal ────────────────────────────
const DIFF_STYLE: Record<string, { color: string; label: string }> = {
    'modificata': { color: 'var(--yellow)', label: 'Modificata' },
    'solo-corrente': { color: 'var(--sky)', label: 'Only in the current project' },
    'solo-file': { color: 'var(--purple)', label: 'Only in the file' },
};

const CompareReportModal: React.FC<{
    open: boolean;
    report: CompareReport | null;
    fileName: string;
    onClose: () => void;
}> = ({ open, report, fileName, onClose }) => {
    if (!report) return null;
    return (
        <Modal open={open} onClose={onClose} title={`Architecture Comparison — ${fileName}`}>
            <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
                <div style={{ display: 'flex', gap: 16, marginBottom: 16, fontSize: '0.85rem' }}>
                    <span style={{ color: 'var(--green)', fontWeight: 600 }}>
                        <CheckCircle size={14} style={{ verticalAlign: -2 }} /> {report.identical} identiche
                    </span>
                    <span style={{ color: 'var(--yellow)', fontWeight: 600 }}>
                        {report.diffs.filter(d => d.status === 'modificata').length} modificate
                    </span>
                    <span style={{ color: 'var(--text-muted)' }}>
                        {report.totalCurrent} current entities · {report.totalOther} in the file
                    </span>
                </div>
                {report.diffs.length === 0 ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 16, borderRadius: 8, background: 'var(--green-bg)', color: 'var(--green)' }}>
                        <CheckCircle size={20} />
                        <span>The two architectures are identical.</span>
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {report.diffs.map((d, i) => {
                            const sty = DIFF_STYLE[d.status];
                            return (
                                <div key={i} style={{
                                    display: 'flex', alignItems: 'flex-start', gap: 10,
                                    padding: '10px 12px', borderRadius: 6,
                                    background: 'rgba(255,255,255,0.03)',
                                    borderLeft: `3px solid ${sty.color}`,
                                }}>
                                    <div style={{ fontSize: '0.85rem', width: '100%' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                                            <span className={`badge badge-${d.level.toLowerCase()}`} style={{ fontSize: '0.65rem', padding: '1px 5px' }}>{d.level}</span>
                                            <strong>{d.name}</strong>
                                            <span style={{ color: sty.color, fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', marginLeft: 'auto' }}>{sty.label}</span>
                                        </div>
                                        {d.notes.length > 0 && (
                                            <ul style={{ margin: '4px 0 0 16px', color: 'var(--text-secondary)' }}>
                                                {d.notes.map((n, j) => <li key={j}>{n}</li>)}
                                            </ul>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </Modal>
    );
};

// ─── Validation Report Modal ──────────────────────────────────
const SEVERITY_STYLE: Record<ValidationIssue['severity'], { icon: React.ReactNode; color: string; label: string }> = {
    error: { icon: <AlertCircle size={15} />, color: 'var(--red)', label: 'Error' },
    warning: { icon: <AlertTriangle size={15} />, color: 'var(--yellow)', label: 'Warning' },
    info: { icon: <Info size={15} />, color: 'var(--text-muted)', label: 'Info' },
};

const ValidationReportModal: React.FC<{
    open: boolean;
    report: ValidationReport | null;
    onClose: () => void;
}> = ({ open, report, onClose }) => {
    if (!report) return null;
    const order: ValidationIssue['severity'][] = ['error', 'warning', 'info'];
    const sorted = [...report.issues].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));

    return (
        <Modal open={open} onClose={onClose} title="Project Verification — Pre-Export Report">
            <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 12 }}>
                    {report.scope === 'assembly'
                        ? `Verificate ${report.checkedEntities} entities assembled on the machine (plus SBOM and network).`
                        : `Assembly tree is empty: the whole database was checked (${report.checkedEntities} entities).`}
                </p>

                <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--red)', fontWeight: 600 }}>
                        <AlertCircle size={16} /> {report.errors} errors
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--yellow)', fontWeight: 600 }}>
                        <AlertTriangle size={16} /> {report.warnings} avvisi
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontWeight: 600 }}>
                        <Info size={16} /> {report.infos} info
                    </span>
                </div>

                {sorted.length === 0 ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 16, borderRadius: 8, background: 'var(--green-bg)', color: 'var(--green)' }}>
                        <CheckCircle size={20} />
                        <span>No problems found. The project is ready to export.</span>
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {sorted.map((issue, i) => {
                            const sty = SEVERITY_STYLE[issue.severity];
                            return (
                                <div key={i} style={{
                                    display: 'flex', alignItems: 'flex-start', gap: 10,
                                    padding: '10px 12px', borderRadius: 6,
                                    background: 'rgba(255,255,255,0.03)',
                                    borderLeft: `3px solid ${sty.color}`,
                                }}>
                                    <span style={{ color: sty.color, marginTop: 2, flexShrink: 0 }}>{sty.icon}</span>
                                    <div style={{ fontSize: '0.85rem' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                                            <span style={{ color: sty.color, fontWeight: 600, fontSize: '0.7rem', textTransform: 'uppercase' }}>{sty.label}</span>
                                            <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>· {issue.category}</span>
                                            {issue.entityName && (
                                                <span className={`badge badge-${String(issue.entityLevel || '').toLowerCase()}`} style={{ fontSize: '0.65rem', padding: '1px 5px' }}>
                                                    {issue.entityLevel} {issue.entityName}
                                                </span>
                                            )}
                                        </div>
                                        <div style={{ color: 'var(--text-secondary)' }}>{issue.message}</div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </Modal>
    );
};
