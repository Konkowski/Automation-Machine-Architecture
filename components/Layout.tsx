// ============================================================
// AMA — App Shell
//   native menu (Electron) ─ app bar ─ nav rail ─ content ─ status bar
// ============================================================
import React, { useState, useEffect, useCallback } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
    Search, User, Save, Check, Users, Trash2, UserCheck, Plus, Hexagon, Keyboard,
} from 'lucide-react';
import { SearchOverlay } from './SearchOverlay';
import { Modal } from './Modal';
import { toast } from './Toaster';
import { useStore } from '../lib/store';
import {
    initAutosave, getAutosaveMeta, loadAutosave, getOsUsername,
    saveProjectToFile, openProjectFromFile, isElectron
} from '../lib/persistence';
import { importGitZip } from '../lib/gitExport';
import { emptyAssembly } from '../lib/normalize';
import { registerCommands, runCommandNow, runCommandWhenReady } from '../lib/commands';
import { Ribbon, Backstage } from './ribbon/Ribbon';
import { importL5X, type L5xImportResult } from '../lib/l5xImport';
import { importTia, type TiaImportResult } from '../lib/tiaImport';
import { addProjectToCodebase } from '../lib/codebaseImport';
import { ribbonTabs } from './ribbon/ribbonConfig';
import { openCodebase, saveCodebase, linkCodebase, refreshCodebase, hardwareFromCodebase } from '../lib/codebaseActions';


// ─── User management (persisted locally) ────────────────────
export const getUsers = (): string[] => {
    try { return JSON.parse(localStorage.getItem('ama_users') || '[]'); } catch { return []; }
};
export const saveUsers = (users: string[]) => {
    try { localStorage.setItem('ama_users', JSON.stringify(users)); } catch { /* ignore */ }
};
const initialsOf = (name: string) =>
    name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';

export const Layout: React.FC = () => {
    const navigate = useNavigate();
    const assembly = useStore(s => s.assembly);
    const workspaceKind = useStore(s => s.workspaceKind);
    const codebase = useStore(s => s.codebase);
    const switchKind = useStore(s => s.switchWorkspaceKind);
    const tabs = ribbonTabs(workspaceKind);
    const activeUser = useStore(s => s.activeUser);
    const setActiveUser = useStore(s => s.setActiveUser);
    const workspaceLoaded = useStore(s => s.workspaceLoaded);
    const loadProject = useStore(s => s.loadProject);
    const clearWorkspace = useStore(s => s.clearWorkspace);
    const units = useStore(s => s.units);
    const ems = useStore(s => s.equipmentModules);
    const cms = useStore(s => s.controlModules);
    const library = useStore(s => s.library);

    const [searchOpen, setSearchOpen] = useState(false);
    const [justSaved, setJustSaved] = useState(false);
    const [userMenuOpen, setUserMenuOpen] = useState(false);
    const [usersOpen, setUsersOpen] = useState(false);
    const [usersList, setUsersList] = useState<string[]>(getUsers());
    const [newUserName, setNewUserName] = useState('');
    const [autosaveTime, setAutosaveTime] = useState<string>('');

    // Startup: adopt the OS user, then auto-open last session or a new project
    // (no welcome screen — the app lands straight in the workspace)
    useEffect(() => {
        if (!useStore.getState().activeUser) {
            const osUser = getOsUsername();
            if (osUser) setActiveUser(osUser);
        }
        if (!useStore.getState().workspaceLoaded) {
            (async () => {
                const recovered = await loadAutosave();
                // the user may have opened a file while we were reading
                if (useStore.getState().workspaceLoaded) return;
                if (recovered) {
                    loadProject(recovered);
                } else {
                    useStore.setState({
                        assembly: emptyAssembly('New Project', 'Empty project created locally.'),
                        workspaceLoaded: true,
                    });
                }
            })();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Keep the active user registered in the users list
    useEffect(() => {
        if (activeUser && !getUsers().includes(activeUser)) {
            const next = [...getUsers(), activeUser];
            saveUsers(next);
            setUsersList(next);
        }
    }, [activeUser]);

    const handleSave = useCallback(async (saveAsNew = false) => {
        const path = await saveProjectToFile(saveAsNew);
        if (path !== null || !isElectron()) {
            setJustSaved(true);
            setTimeout(() => setJustSaved(false), 2200);
        }
    }, []);

    // Autosave for crash recovery + status bar clock
    useEffect(() => {
        initAutosave();
        const tick = () => {
            const meta = getAutosaveMeta();
            setAutosaveTime(meta ? new Date(meta.savedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '');
        };
        tick();
        const t = setInterval(tick, 10000);
        return () => clearInterval(t);
    }, []);

    // Ctrl+K (search) / Ctrl+S (save) shortcuts — open, never toggle, so the
    // native menu accelerators firing in parallel stay harmless
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                setSearchOpen(true);
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                runCommandNow(e.shiftKey ? 'file:saveAs' : 'file:save');
            }
            // Ctrl+1…6: the workflow steps
            if ((e.ctrlKey || e.metaKey) && ['1', '2', '3', '4', '5', '6'].includes(e.key)) {
                e.preventDefault();
                const target = ribbonTabs(useStore.getState().workspaceKind)[Number(e.key) - 1];
                if (target) navigate(target.route);
            }
            if (e.ctrlKey && e.key === 'F1') { e.preventDefault(); runCommandNow('view:ribbon'); }
            if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) { e.preventDefault(); runCommandNow('view:zoomIn'); }
            if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); runCommandNow('view:zoomOut'); }
            if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); runCommandNow('view:zoomReset'); }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [navigate]);

    // Warn before closing with a loaded workspace (browser only)
    useEffect(() => {
        if (isElectron() || /Electron/i.test(navigator.userAgent)) return;
        const handler = (e: BeforeUnloadEvent) => {
            if (useStore.getState().workspaceLoaded) {
                e.preventDefault();
                e.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, []);

    const handleNewProject = useCallback(() => {
        if (useStore.getState().workspaceLoaded &&
            !confirm('Create a new project? Unsaved work stays in the autosave.')) return;
        clearWorkspace();
        useStore.setState({
            assembly: emptyAssembly('New Project', 'Empty project created locally.'),
            workspaceLoaded: true
        });
    }, [clearWorkspace]);

    const applyImportedData = (data: any): boolean => {
        // loadProject normalizes every shape (missing assembly, partial
        // lists, old files) — here we only reject files that clearly are
        // not AMA project data at all.
        if (data && (data.library || data.units || data.equipmentModules || data.controlModules || data.assembly)) {
            loadProject(data.assembly ? data : {
                ...data,
                assembly: emptyAssembly('Imported Project', 'Architecture imported.'),
            });
            return true;
        }
        toast('Invalid file format. The file must contain project or architecture data.');
        return false;
    };

    const handleImport = useCallback(async () => {
        if (isElectron()) {
            try {
                const data = await openProjectFromFile();
                if (data) applyImportedData(data);
            } catch {
                toast('Unable to import the file: unrecognized format.');
            }
            return;
        }
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,.zip';
        input.onchange = async (e: any) => {
            const file = e.target.files[0];
            if (!file) return;
            if (file.name.toLowerCase().endsWith('.zip')) {
                try {
                    const data = await importGitZip(file);
                    if (data) applyImportedData(data);
                    else toast('The ZIP file does not look like an AMA Git export.');
                } catch {
                    toast('Unable to read the ZIP file.');
                }
                return;
            }
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const data = JSON.parse(ev.target?.result as string);
                    applyImportedData(data);
                } catch {
                    toast('Unable to parse the JSON file.');
                }
            };
            reader.readAsText(file);
        };
        input.click();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loadProject]);

    const projectName = workspaceKind === 'codebase' ? (codebase?.name || 'New Code Base') : assembly.name;
    const projectVersion = workspaceKind === 'codebase' ? (codebase?.version || '1.0.0') : assembly.version;
    const projectDesc = workspaceKind === 'codebase' ? (codebase?.description || '') : (assembly.description || '');

    // ─── Ribbon state ───────────────────────────────────────
    const location = useLocation();
    const pathRef = React.useRef(location.pathname);
    pathRef.current = location.pathname;
    const skipTabSync = React.useRef(false);
    const [activeTab, setActiveTab] = useState('project');
    const [backstageOpen, setBackstageOpen] = useState(false);
    const [helpModal, setHelpModal] = useState<null | 'shortcuts' | 'about'>(null);

    // Land on step 1 (the start page) when the app opens without a route
    useEffect(() => {
        if (pathRef.current === '/') { skipTabSync.current = true; navigate('/project', { replace: true }); }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const [ribbonCollapsed, setRibbonCollapsed] = useState<boolean>(() => {
        try { return localStorage.getItem('ama_ribbon_collapsed_v2') === '1'; } catch { return false; }
    });
    const [zoom, setZoom] = useState<number>(() => {
        try { return Math.min(1.5, Math.max(0.7, Number(localStorage.getItem('ama_zoom')) || 1)); } catch { return 1; }
    });
    useEffect(() => { try { localStorage.setItem('ama_ribbon_collapsed_v2', ribbonCollapsed ? '1' : '0'); } catch { /* ignore */ } }, [ribbonCollapsed]);
    useEffect(() => { try { localStorage.setItem('ama_zoom', String(zoom)); } catch { /* ignore */ } }, [zoom]);

    // Opening a page from outside the ribbon (Ctrl+1…5, search) follows it with the tab
    useEffect(() => {
        if (skipTabSync.current) { skipTabSync.current = false; return; }
        const t = tabs.find(x => x.route === location.pathname);
        if (t) setActiveTab(t.id);
    }, [location.pathname]);

    /** Flip between the Code base and Machine workspaces; each keeps its own content. */
    const switchMode = (kind: 'codebase' | 'machine') => {
        if (kind === workspaceKind) return;
        switchKind(kind);
        setActiveTab('project');
        if (pathRef.current !== '/project') { skipTabSync.current = true; navigate('/project'); }
    };

    const selectTab = useCallback((id: string) => {
        setActiveTab(id);
        const t = tabs.find(x => x.id === id);
        if (t && pathRef.current !== t.route) { skipTabSync.current = true; navigate(t.route); }
    }, [navigate, tabs]);

    /** Ribbon / backstage entry point: navigate to the owning page first when needed. */
    const execute = useCallback((cmd: { id: string; route?: string }) => {
        if (cmd.id.startsWith('nav:')) { navigate(cmd.id.slice(4)); return; }
        if (cmd.route && pathRef.current !== cmd.route) {
            skipTabSync.current = true;
            navigate(cmd.route);
            runCommandWhenReady(cmd.id);
            return;
        }
        if (!runCommandNow(cmd.id)) runCommandWhenReady(cmd.id);
    }, [navigate]);

    // ─── Import from Studio 5000 / architecture-only import ─
    const loadArchitecture = useStore(s => s.loadArchitecture);
    const [l5x, setL5x] = useState<{ fileName: string; result: L5xImportResult } | null>(null);
    const pickFile = (accept: string, onFile: (f: File) => void) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.onchange = (e: any) => { const f: File | undefined = e.target.files?.[0]; if (f) onFile(f); };
        input.click();
    };
    const handleImportL5X = () => pickFile('.l5x,.L5X,.xml', async file => {
        try {
            setL5x({ fileName: file.name, result: importL5X(await file.text(), file.name, getOsUsername() || 'Studio 5000') });
        } catch (err: any) {
            toast(err?.message || 'Unable to read the L5X file.');
        }
    });
    // ─── Import from TIA Portal ─────────────────────────────
    // 'choose' = pick how; 'busy' = TIA Portal is exporting; result = preview before replacing the workspace
    const [tia, setTia] = useState<null | { step: 'choose' | 'busy' } | { step: 'result'; source: string; result: TiaImportResult }>(null);
    const showTia = (files: Record<string, string>, source: string) => {
        try { setTia({ step: 'result', source, result: importTia(files, source, getOsUsername() || 'TIA Portal') }); }
        catch (err: any) { setTia(null); toast(err?.message || 'Unable to read the TIA Portal export.'); }
    };
    const [tiaProgress, setTiaProgress] = useState<{ done?: number; total?: number; text: string }>({ text: '' });
    const tiaFromProject = async () => {
        const ipc = (window as any).amaIpc;
        if (!ipc) { toast('Reading a TIA project directly is only available in the desktop app.'); return; }
        setTiaProgress({ text: 'Choose the TIA Portal project' });
        setTia({ step: 'busy' });
        const off = ipc.on('ama:tia-progress', (p: any) => setTiaProgress(prev => ({ ...prev, ...p, text: p?.text ?? prev.text })));
        let res: any;
        try { res = await ipc.invoke('ama:tia-extract'); } finally { off(); }
        if (res?.canceled) { setTia({ step: 'choose' }); return; }
        if (!res?.ok) { setTia({ step: 'choose' }); toast(res?.error || 'The TIA Portal export failed.'); return; }
        showTia(res.files, String(res.project).split(/[\\/]/).pop() || 'TIA Portal');
    };
    const tiaFromFolder = async () => {
        const ipc = (window as any).amaIpc;
        if (ipc) {
            const picked = await ipc.invoke('ama:pick-folder');
            if (!picked?.dir) return;
            const res = await ipc.invoke('ama:read-tree', { dir: picked.dir });
            if (!res?.ok) { toast(res?.error || 'Unable to read the folder.'); return; }
            showTia(res.files, String(picked.dir).split(/[\\/]/).pop() || 'TIA export');
            return;
        }
        const input = document.createElement('input');
        input.type = 'file';
        (input as any).webkitdirectory = true;
        input.onchange = async (e: any) => {
            const list: File[] = Array.from(e.target.files || []);
            const files: Record<string, string> = {};
            for (const f of list) {
                if (!/\.(xml|json)$/i.test(f.name)) continue;
                const rel = ((f as any).webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name;
                files[rel] = await f.text();
            }
            showTia(files, ((list[0] as any)?.webkitRelativePath || 'TIA export').split('/')[0]);
        };
        input.click();
    };
    const confirmImportTia = () => {
        if (!tia || tia.step !== 'result') return;
        const s = tia.result.stats;
        const p = tia.result.project;
        if (useStore.getState().workspaceKind === 'codebase') {
            // Code base: the blocks are ADDED as Draft and the hardware joins the reference hardware; nothing there is replaced
            const r = addProjectToCodebase(p);
            toast(`${r.added} block(s) and ${r.hardwareAdded} hardware / software row(s) from ${tia.source} added to the code base${r.skipped ? `; ${r.skipped} block(s) skipped (same name already exists)` : ''}. Save the code base to keep them.`, 'success');
            setTia(null);
            selectTab('arch');
            return;
        }
        loadProject(p);
        toast(`Project created from ${tia.source}: ${s.blocks} blocks, ${s.variables} variables, ${s.io} I/O, ${s.alarms} alarms.`, 'success');
        setTia(null);
        selectTab('project');
    };

    const confirmImportL5X = () => {
        if (!l5x) return;
        if (useStore.getState().workspaceKind === 'codebase') {
            const r = addProjectToCodebase(l5x.result.project);
            toast(`${r.added} block(s) and ${r.hardwareAdded} hardware row(s) from ${l5x.fileName} added to the code base${r.skipped ? `; ${r.skipped} block(s) skipped (same name already exists)` : ''}. Save the code base to keep them.`, 'success');
            setL5x(null);
            selectTab('arch');
            return;
        }
        loadProject(l5x.result.project);
        toast(`Project created from ${l5x.fileName}: ${l5x.result.stats.programs} programs, ${l5x.result.stats.aois} AOIs.`, 'success');
        setL5x(null);
        selectTab('project');
    };
    const handleImportArchitecture = () => pickFile('.json', async file => {
        try {
            const data = JSON.parse(await file.text());
            if (data.library || data.units || data.equipmentModules || data.controlModules) {
                loadArchitecture(data);
                toast('Architecture imported: current assembly unchanged', 'success');
            } else toast('Invalid architecture file format.');
        } catch {
            toast('Unable to parse the JSON file.');
        }
    });
    const handleClear = () => {
        if (confirm('Completely clear the workspace? All unsaved data will be lost.')) clearWorkspace();
    };

    const stepZoom = (d: number) => setZoom(z => Math.min(1.5, Math.max(0.7, Math.round((z + d) * 100) / 100)));

    // Global commands (everything else is registered by the page that owns it)
    useEffect(() => registerCommands({
        'file:new': handleNewProject,
        'file:open': handleImport,
        'file:save': () => {
            if (useStore.getState().workspaceKind === 'codebase') saveCodebase(false);
            else if (useStore.getState().workspaceLoaded) handleSave(false);
        },
        'file:saveAs': () => {
            if (useStore.getState().workspaceKind === 'codebase') saveCodebase(true);
            else if (useStore.getState().workspaceLoaded) handleSave(true);
        },
        'codebase:open': openCodebase,
        'codebase:save': () => saveCodebase(false),
        'codebase:save-as': () => saveCodebase(true),
        'machine:link-codebase': linkCodebase,
        'machine:refresh-codebase': refreshCodebase,
        'machine:hardware-from-codebase': hardwareFromCodebase,
        'data:import-l5x': handleImportL5X,
        'data:import-tia': () => setTia({ step: 'choose' }),
        'data:import-arch': handleImportArchitecture,
        'file:clear': handleClear,
        'view:search': () => setSearchOpen(true),
        'view:zoomIn': () => stepZoom(0.1),
        'view:zoomOut': () => stepZoom(-0.1),
        'view:zoomReset': () => setZoom(1),
        'view:ribbon': () => setRibbonCollapsed(v => !v),
        'settings:users': () => setUsersOpen(true),
        'help:shortcuts': () => setHelpModal('shortcuts'),
        'help:about': () => setHelpModal('about'),
    }), [handleNewProject, handleImport, handleSave, loadProject, loadArchitecture]);

    // ─── Command runner: command palette + (legacy) IPC bridge ──
    const runAction = useCallback((action: string) => {
        if (action.startsWith('nav:')) { navigate(action.slice(4)); return; }
        if (runCommandNow(action)) return;
        // export:* / tools:* live on the Export page
        if (action.startsWith('export:') || action.startsWith('tools:')) {
            navigate('/export');
            setTimeout(() => window.dispatchEvent(new CustomEvent('ama-export-action', { detail: action })), 350);
        }
    }, [navigate]);

    useEffect(() => {
        const cmdHandler = (e: Event) => runAction((e as CustomEvent).detail as string);
        window.addEventListener('ama-command', cmdHandler);
        if (isElectron()) {
            const off = (window as any).amaIpc.on('ama:menu', (action: string) => runAction(action));
            return () => {
                window.removeEventListener('ama-command', cmdHandler);
                off();
            };
        }
        return () => window.removeEventListener('ama-command', cmdHandler);
    }, [runAction]);

    // ─── Users modal handlers ───────────────────────────────
    const addUser = () => {
        const name = newUserName.trim();
        if (!name) return;
        if (!usersList.includes(name)) {
            const next = [...usersList, name];
            saveUsers(next);
            setUsersList(next);
        }
        setNewUserName('');
    };
    const removeUser = (name: string) => {
        const next = usersList.filter(u => u !== name);
        saveUsers(next);
        setUsersList(next);
    };

    const usersModal = (
        <Modal open={usersOpen} onClose={() => setUsersOpen(false)} title="User Management">
            <p className="text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 14 }}>
                The active user automatically signs every change and every entity revision.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
                {usersList.length === 0 && (
                    <div className="empty-state-sm"><p>No users registered.</p></div>
                )}
                {usersList.map(u => (
                    <div key={u} style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                        borderRadius: 8, background: u === activeUser ? 'rgba(14,165,233,0.1)' : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${u === activeUser ? 'rgba(14,165,233,0.4)' : 'var(--border)'}`,
                    }}>
                        <span className="user-avatar" style={{ width: 28, height: 28, fontSize: '0.7rem' }}>{initialsOf(u)}</span>
                        <span style={{ flex: 1, fontWeight: u === activeUser ? 600 : 400 }}>{u}</span>
                        {u === activeUser ? (
                            <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.72rem', color: 'var(--sky-light)' }}>
                                <UserCheck size={13} /> active
                            </span>
                        ) : (
                            <>
                                <button className="btn btn-secondary btn-sm" onClick={() => { setActiveUser(u); }}>Activate</button>
                                <button className="btn btn-ghost btn-sm" title="Delete user" onClick={() => removeUser(u)}>
                                    <Trash2 size={13} />
                                </button>
                            </>
                        )}
                    </div>
                ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
                <input
                    className="input"
                    placeholder="New user name (e.g. J. Smith)"
                    value={newUserName}
                    onChange={e => setNewUserName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') addUser(); }}
                />
                <button className="btn btn-primary" onClick={addUser} disabled={!newUserName.trim()}>
                    <Plus size={14} /> Add
                </button>
            </div>
        </Modal>
    );


    return (
        <div className="app-shell-v2" style={{ zoom, height: `${100 / zoom}vh` } as React.CSSProperties}>
            {usersModal}

            {/* ═══ Title bar: identity · project · search · user ═══ */}
            <header className="app-topbar">
                <div className="topbar-brand" title="AMA — Automation Machine Architecture">
                    <Hexagon size={20} style={{ color: 'var(--sky)' }} />
                    <span>AMA</span>
                </div>
                <button
                    className={`qa-btn ${justSaved ? 'saved' : ''}`}
                    onClick={() => runCommandNow('file:save')}
                    title={useStore.getState().projectFilePath
                        ? `Save to: ${useStore.getState().projectFilePath}`
                        : 'Save project (Ctrl+S)'}
                >
                    {justSaved ? <Check size={15} /> : <Save size={15} />}
                </button>
                <div className="mode-switch" role="tablist" title="Two workspaces: the reusable code base, and the machines assembled from it">
                    <button className={workspaceKind === 'codebase' ? 'active' : ''} onClick={() => switchMode('codebase')}>Code base</button>
                    <button className={workspaceKind === 'machine' ? 'active' : ''} onClick={() => switchMode('machine')}>Machine</button>
                </div>
                <div className="topbar-project" title={`${projectName} — ${projectDesc}`}>
                    <span className="topbar-project-name">{projectName}</span>
                    <span className="topbar-project-version">v{projectVersion}</span>
                    {justSaved && <span className="topbar-project-version">· saved</span>}
                </div>
                <div style={{ flex: 1 }} />
                <button className="title-search" onClick={() => setSearchOpen(true)} title="Search (Ctrl+K)">
                    <Search size={14} /> <span>Search</span>
                    <kbd className="topbar-kbd">Ctrl+K</kbd>
                </button>
                <div style={{ flex: 1 }} />
                <div style={{ position: 'relative' }}>
                    <button className="user-avatar" onClick={() => setUserMenuOpen(v => !v)} title={activeUser || 'User'}>
                        {initialsOf(activeUser || '?')}
                    </button>
                    {userMenuOpen && (
                        <>
                            <div className="user-menu-backdrop" onClick={() => setUserMenuOpen(false)} />
                            <div className="user-menu">
                                <div className="user-menu-header">
                                    <span className="user-avatar" style={{ width: 34, height: 34 }}>{initialsOf(activeUser || '?')}</span>
                                    <div>
                                        <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{activeUser || 'No user'}</div>
                                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>active user</div>
                                    </div>
                                </div>
                                {usersList.filter(u => u !== activeUser).length > 0 && (
                                    <div className="user-menu-section">Switch user</div>
                                )}
                                {usersList.filter(u => u !== activeUser).map(u => (
                                    <button key={u} className="user-menu-item" onClick={() => { setActiveUser(u); setUserMenuOpen(false); }}>
                                        <span className="user-avatar" style={{ width: 22, height: 22, fontSize: '0.6rem' }}>{initialsOf(u)}</span>
                                        {u}
                                    </button>
                                ))}
                                <div className="user-menu-sep" />
                                <button className="user-menu-item" onClick={() => { setUsersOpen(true); setUserMenuOpen(false); }}>
                                    <Users size={14} /> Manage users…
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </header>

            {/* ═══ Ribbon: tabs + command groups ═══ */}
            <Ribbon
                tabs={tabs}
                activeTab={activeTab}
                onTab={selectTab}
                collapsed={ribbonCollapsed}
                onToggleCollapsed={() => setRibbonCollapsed(v => !v)}
                onRun={execute}
                backstageOpen={backstageOpen}
                onBackstage={setBackstageOpen}
                onHelp={() => setHelpModal('shortcuts')}
            />

            <div className="app-body">
                <main className="main-content">
                    <Outlet />
                </main>
                <Backstage kind={workspaceKind} open={backstageOpen} onClose={() => setBackstageOpen(false)} onRun={execute} />
            </div>

            {/* ═══ Status bar ═══ */}
            {(
                <footer className="app-statusbar">
                    <span className="statusbar-item" title="Active project">{assembly.name} · v{assembly.version}</span>
                    <span className="statusbar-sep" />
                    <span className="statusbar-item">{units.length} UN · {ems.length} EM · {cms.length} CM · {library.length} FB</span>
                    <span style={{ flex: 1 }} />
                    {autosaveTime && (
                        <span className="statusbar-item" title="Last autosave">
                            autosave {autosaveTime}
                        </span>
                    )}
                    <span className="statusbar-sep" />
                    <span className="statusbar-item" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <User size={11} /> {activeUser || '—'}
                    </span>
                    <span className="statusbar-sep" />
                    <span className="statusbar-zoom">
                        <button onClick={() => runCommandNow('view:zoomOut')} title="Riduci (Ctrl −)">−</button>
                        <button onClick={() => runCommandNow('view:zoomReset')} title="Zoom al 100% (Ctrl 0)">{Math.round(zoom * 100)}%</button>
                        <button onClick={() => runCommandNow('view:zoomIn')} title="Ingrandisci (Ctrl +)">+</button>
                    </span>
                </footer>
            )}

            <Modal
                open={!!l5x}
                onClose={() => setL5x(null)}
                title={`Import from Studio 5000 — ${l5x?.fileName ?? ''}`}
                footer={<>
                    <button className="btn btn-secondary" onClick={() => setL5x(null)}>Cancel</button>
                    <button className="btn btn-primary" onClick={confirmImportL5X}>{workspaceKind === 'codebase' ? 'Add to the code base (blocks as Draft, hardware to the SBOM)' : 'Create project (replaces the workspace)'}</button>
                </>}
            >
                {l5x && (
                    <div style={{ maxHeight: '60vh', overflowY: 'auto', fontSize: '0.85rem' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 14 }}>
                            {([
                                ['Programs', l5x.result.stats.programs], ['AOIs', l5x.result.stats.aois], ['UDT', l5x.result.stats.udts],
                                ['Variables', l5x.result.stats.tags], ['I/O Signals', l5x.result.stats.io], ['Alarms', l5x.result.stats.alarms],
                                ['Rung RLL', l5x.result.stats.rungs], ['Routine ST', l5x.result.stats.stRoutines], ['Hardware modules', l5x.result.stats.modules],
                            ] as [string, number][]).map(([k, v]) => (
                                <div key={k} style={{ padding: '6px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.05)' }}>
                                    <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>{v}</div>
                                    <div style={{ opacity: 0.7 }}>{k}</div>
                                </div>
                            ))}
                        </div>
                        <div style={{ fontWeight: 600, marginBottom: 6 }}>To check after the import</div>
                        <ul style={{ margin: 0, paddingLeft: 18 }}>
                            {l5x.result.warnings.map((w, i) => <li key={i} style={{ marginBottom: 4 }}>{w}</li>)}
                        </ul>
                    </div>
                )}
            </Modal>

            <Modal
                open={!!tia}
                onClose={() => { if (tia?.step !== 'busy') setTia(null); }}
                title={tia?.step === 'result' ? `Import from TIA Portal — ${tia.source}` : 'Import from TIA Portal'}
                footer={tia?.step === 'result' ? <>
                    <button className="btn btn-secondary" onClick={() => setTia(null)}>Cancel</button>
                    <button className="btn btn-primary" onClick={confirmImportTia}>{workspaceKind === 'codebase' ? 'Add the blocks to the code base' : 'Create project (replaces the workspace)'}</button>
                </> : tia?.step === 'choose' ? <button className="btn btn-secondary" onClick={() => setTia(null)}>Cancel</button> : undefined}
            >
                {tia?.step === 'choose' && (
                    <div style={{ fontSize: '0.85rem' }}>
                        <p style={{ marginTop: 0 }}>AMA reads the blocks, PLC tags, data types and hardware of a TIA Portal project and {workspaceKind === 'codebase' ? 'adds the blocks to the code base as Draft and the hardware to its reference SBOM and topology (a machine can start from them and change them)' : 'builds the machine from them'}. The TIA project is only read, never changed.</p>
                        <div className="start-cards" style={{ gridTemplateColumns: '1fr 1fr' }}>
                            <button className="start-card" onClick={tiaFromProject}>
                                <h3>Read a TIA project</h3>
                                <p>Pick the .ap file. AMA starts TIA Portal in the background and exports everything (a few minutes). Needs TIA Portal with Openness and the .NET SDK on this PC; close the project in TIA first.</p>
                            </button>
                            <button className="start-card" onClick={tiaFromFolder}>
                                <h3>Open an export folder</h3>
                                <p>A folder already exported by the AMA extractor (tools/tia-extractor), or any folder with the XML exports of blocks and PLC tags.</p>
                            </button>
                        </div>
                    </div>
                )}
                {tia?.step === 'busy' && (() => {
                    const known = !!tiaProgress.total;
                    const pct = known ? Math.round(100 * (tiaProgress.done || 0) / tiaProgress.total!) : 0;
                    return (
                        <div style={{ fontSize: '0.88rem' }}>
                            <div className={`progress-bar ${known ? '' : 'indeterminate'}`}><div className="progress-fill" style={known ? { width: `${pct}%` } : undefined} /></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 8 }}>
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tiaProgress.text || 'Working'}</span>
                                <span style={{ opacity: 0.7, whiteSpace: 'nowrap' }}>{known ? `${tiaProgress.done} / ${tiaProgress.total} (${pct}%)` : ''}</span>
                            </div>
                            <p style={{ opacity: 0.7, marginBottom: 0 }}>TIA Portal works in the background; the project is only read. If TIA Portal asks whether to grant access to "TiaExtractor", answer Yes.</p>
                        </div>
                    );
                })()}
                {tia?.step === 'result' && (
                    <div style={{ maxHeight: '60vh', overflowY: 'auto', fontSize: '0.85rem' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 14 }}>
                            {([
                                ['Blocks', tia.result.stats.blocks], ['Code blocks', tia.result.stats.codeBlocks], ['Networks', tia.result.stats.networks], ['Data blocks', tia.result.stats.dbs],
                                ['Function blocks', tia.result.stats.fbs], ['Data types (UDT)', tia.result.stats.udts], ['Variables', tia.result.stats.variables], ['PLC tags', tia.result.stats.tags],
                                ['I/O signals', tia.result.stats.io], ['Alarms', tia.result.stats.alarms], ['Devices', tia.result.stats.devices],
                                ['Units / EM / CM', `${tia.result.project.units.length} / ${tia.result.project.equipmentModules.length} / ${tia.result.project.controlModules.length}`],
                            ] as [string, number | string][]).map(([k, v]) => (
                                <div key={k} style={{ padding: '6px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.05)' }}>
                                    <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>{v}</div>
                                    <div style={{ opacity: 0.7 }}>{k}</div>
                                </div>
                            ))}
                        </div>
                        <div style={{ fontWeight: 600, marginBottom: 6 }}>To check after the import</div>
                        <ul style={{ margin: 0, paddingLeft: 18 }}>
                            {tia.result.warnings.map((w, i) => <li key={i} style={{ marginBottom: 4 }}>{w}</li>)}
                        </ul>
                    </div>
                )}
            </Modal>

            <Modal open={helpModal === 'shortcuts'} onClose={() => setHelpModal(null)} title="Keyboard shortcuts">
                <table className="shortcut-table">
                    <tbody>
                        {[
                            ['Ctrl+S', 'Save the project'],
                            ['Ctrl+Shift+S', 'Save as'],
                            ['Ctrl+K', 'Search entities and commands'],
                            ['Ctrl+1 … 5', 'Architecture, Assembly, Dashboard, Data, Version'],
                            ['Ctrl+F1', 'Collapse or expand the ribbon'],
                            ['Ctrl + +  /  Ctrl + −', 'Ingrandisci o riduci'],
                            ['Ctrl+0', 'Zoom al 100%'],
                        ].map(([k, d]) => (
                            <tr key={k}><td><kbd className="topbar-kbd">{k}</kbd></td><td>{d}</td></tr>
                        ))}
                    </tbody>
                </table>
            </Modal>
            <Modal open={helpModal === 'about'} onClose={() => setHelpModal(null)} title="About AMA">
                <p style={{ marginBottom: 8 }}><strong>AMA — Automation Machine Architecture</strong></p>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                    Software architecture design of a machine according to ISA-88 (UN, EM, CM, FB), with import from Studio 5000 and export to Studio 5000 (L5X) and TIA Portal (Openness).
                </p>
            </Modal>

            <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} />
        </div>
    );
};
