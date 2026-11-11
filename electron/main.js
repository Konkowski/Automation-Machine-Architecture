import { app, BrowserWindow, ipcMain, dialog, screen, Menu } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileP = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Window state persistence (size / maximized) ───────────
const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
    try {
        return JSON.parse(fs.readFileSync(windowStateFile(), 'utf-8'));
    } catch {
        return null;
    }
}

function createWindow() {
    // Never open larger than the available work area (1280x800 hard-coded
    // used to push the bottom of the app off-screen on 768p laptops and
    // with 125% display scaling)
    const { workAreaSize } = screen.getPrimaryDisplay();
    const saved = loadWindowState();
    const width = Math.min(saved?.width || 1280, workAreaSize.width);
    const height = Math.min(saved?.height || 800, workAreaSize.height);

    const win = new BrowserWindow({
        width,
        height,
        minWidth: 900,
        minHeight: 560,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            nodeIntegration: false,
            contextIsolation: true,
        },
        title: "AMA — Automation Machine Architecture",
        autoHideMenuBar: true,
        backgroundColor: '#0b0f17',
    });

    // A page must never be able to veto closing the window (a stray
    // beforeunload handler left the app impossible to close)
    win.webContents.on('will-prevent-unload', e => e.preventDefault());

    // No native menu bar: all commands live in the app UI
    Menu.setApplicationMenu(null);

    if (saved ? saved.maximized : (workAreaSize.width <= 1440 || workAreaSize.height <= 900)) {
        win.maximize();
    }

    win.on('close', () => {
        try {
            const b = win.getBounds();
            fs.writeFileSync(windowStateFile(), JSON.stringify({
                width: b.width, height: b.height, maximized: win.isMaximized(),
            }));
        } catch {
            // best effort
        }
    });

    const isDev = !app.isPackaged;

    if (isDev) {
        win.loadURL('http://localhost:3000');
        win.webContents.openDevTools();
    } else {
        win.loadFile(path.join(__dirname, '../dist/index.html'));
    }
}

// Atomic write: write to a temp file, then rename over the target.
// A crash or full disk mid-write can no longer corrupt the project file.
async function writeFileAtomic(filePath, content) {
    const tmp = filePath + '.tmp';
    await fs.promises.writeFile(tmp, content, 'utf-8');
    await fs.promises.rename(tmp, filePath);
}

// ─── Native file persistence (project save/open) ───────────
// Saves to currentPath directly when known; otherwise prompts Save As.
ipcMain.on('ama:username', e => {
    try { e.returnValue = os.userInfo().username || ''; } catch { e.returnValue = ''; }
});

ipcMain.handle('ama:save-file', async (event, { content, defaultName, currentPath }) => {
    let filePath = currentPath;
    if (!filePath) {
        const win = BrowserWindow.fromWebContents(event.sender);
        const result = await dialog.showSaveDialog(win, {
            title: 'Save project',
            defaultPath: defaultName,
            filters: [{ name: 'AMA Project (JSON)', extensions: ['json'] }],
        });
        if (result.canceled || !result.filePath) return { canceled: true };
        filePath = result.filePath;
    }
    await writeFileAtomic(filePath, content);
    return { path: filePath };
});

// ─── Autosave on disk (crash recovery) ──────────────────────
// localStorage caps out around 5 MB and fails silently; real projects
// with embedded PLC code can exceed that. The desktop app snapshots to
// userData/autosave.json instead.
const autosaveFile = () => path.join(app.getPath('userData'), 'autosave.json');

ipcMain.handle('ama:autosave-write', async (event, { content }) => {
    try {
        await writeFileAtomic(autosaveFile(), content);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
    }
});

ipcMain.handle('ama:autosave-read', async () => {
    try {
        const content = await fs.promises.readFile(autosaveFile(), 'utf-8');
        return { ok: true, content };
    } catch {
        return { ok: false };   // no autosave yet
    }
});

ipcMain.handle('ama:autosave-clear', async () => {
    try { await fs.promises.unlink(autosaveFile()); } catch { /* already gone */ }
    return { ok: true };
});

ipcMain.handle('ama:open-file', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
        title: 'Open project',
        properties: ['openFile'],
        filters: [
            { name: 'AMA Project (JSON / Git ZIP)', extensions: ['json', 'zip'] },
            { name: 'All files', extensions: ['*'] },
        ],
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    const filePath = result.filePaths[0];
    const isZip = filePath.toLowerCase().endsWith('.zip');
    const content = await fs.promises.readFile(filePath, isZip ? 'base64' : 'utf-8');
    return { path: filePath, content, encoding: isZip ? 'base64' : 'utf8' };
});

// ─── Git integration (write structure + init/add/commit/log) ──
ipcMain.handle('ama:pick-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
        title: 'Choose the Git repository folder',
        properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    return { dir: result.filePaths[0] };
});

ipcMain.handle('ama:git-commit', async (event, { dir, files, message, author }) => {
    try {
        // 1. Write the per-entity structure to disk
        for (const [rel, content] of Object.entries(files)) {
            const full = path.join(dir, rel);
            await fs.promises.mkdir(path.dirname(full), { recursive: true });
            await fs.promises.writeFile(full, content, 'utf-8');
        }
        const git = (args) => execFileP('git', args, { cwd: dir, windowsHide: true });

        // 2. Init the repo on first use (default branch "main")
        if (!fs.existsSync(path.join(dir, '.git'))) {
            await git(['init']);
            await git(['symbolic-ref', 'HEAD', 'refs/heads/main']).catch(() => {});
        }

        // 3. Commit identity = active AMA user (local to this repo)
        const who = (author && author.trim()) ? author.trim() : 'AMA';
        await git(['config', 'user.name', who]);
        await git(['config', 'user.email', `${who.replace(/\s+/g, '.').toLowerCase()}@ama.local`]);

        // 4. Stage everything, commit only if there are changes
        await git(['add', '-A']);
        const status = await git(['status', '--porcelain']);
        if (!status.stdout.trim()) {
            return { ok: true, committed: false, dir, message: 'No changes to commit.' };
        }
        await git(['commit', '-m', message || 'Update from AMA']);
        const hash = (await git(['rev-parse', '--short', 'HEAD'])).stdout.trim();
        return { ok: true, committed: true, dir, hash };
    } catch (e) {
        const msg = (e && e.message) || String(e);
        const noGit = /ENOENT|not found|not recognized|is not recognized/i.test(msg);
        return { ok: false, error: noGit ? 'Git not found on the system. Install Git and try again.' : msg };
    }
});

ipcMain.handle('ama:git-log', async (event, { dir }) => {
    try {
        const res = await execFileP('git', ['log', '--oneline', '--decorate', '-12'], { cwd: dir, windowsHide: true });
        return { ok: true, log: res.stdout };
    } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
    }
});

// Write the project structure to the repo folder without committing
ipcMain.handle('ama:git-write', async (event, { dir, files }) => {
    try {
        for (const [rel, content] of Object.entries(files)) {
            const full = path.join(dir, rel);
            await fs.promises.mkdir(path.dirname(full), { recursive: true });
            await fs.promises.writeFile(full, content, 'utf-8');
        }
        return { ok: true, count: Object.keys(files).length };
    } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
    }
});

// ─── Code base folders (one JSON file per entity) ──────────
// Read: codebase.json plus every .json in the given subfolders.
ipcMain.handle('ama:read-folder', async (event, { dir, subdirs }) => {
    try {
        const files = {};
        try { files['codebase.json'] = await fs.promises.readFile(path.join(dir, 'codebase.json'), 'utf-8'); } catch { /* optional */ }
        for (const sd of subdirs || []) {
            let names = [];
            try { names = await fs.promises.readdir(path.join(dir, sd)); } catch { continue; }
            for (const n of names) {
                if (!n.endsWith('.json')) continue;
                files[sd + '/' + n] = await fs.promises.readFile(path.join(dir, sd, n), 'utf-8');
            }
        }
        return { ok: true, files };
    } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
    }
});

// Write: removes the stale .json files of cleanDirs first, so an entity
// deleted in AMA disappears from the repository (and shows up in git status).
ipcMain.handle('ama:write-folder', async (event, { dir, files, cleanDirs }) => {
    try {
        for (const cd of cleanDirs || []) {
            let names = [];
            try { names = await fs.promises.readdir(path.join(dir, cd)); } catch { continue; }
            for (const n of names) if (n.endsWith('.json')) await fs.promises.unlink(path.join(dir, cd, n));
        }
        for (const [rel, content] of Object.entries(files)) {
            const full = path.join(dir, rel);
            await fs.promises.mkdir(path.dirname(full), { recursive: true });
            await fs.promises.writeFile(full, content, 'utf-8');
        }
        return { ok: true, count: Object.keys(files).length };
    } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
    }
});

// Generic git runner — the Git management page composes any command
ipcMain.handle('ama:git-run', async (event, { dir, args }) => {
    try {
        const res = await execFileP('git', args, { cwd: dir, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
        return { ok: true, stdout: res.stdout || '', stderr: res.stderr || '' };
    } catch (e) {
        const msg = (e && e.message) || String(e);
        const noGit = /ENOENT|not recognized|is not recognized|not found/i.test(msg);
        return {
            ok: false,
            error: noGit ? 'Git not found on the system. Install Git and try again.' : (e.stderr || e.stdout || msg),
            stdout: e.stdout || '', stderr: e.stderr || '',
        };
    }
});

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// ─── Import from TIA Portal ────────────────────────────────
// Reads every .xml / .json below a folder (a TIA export) into { relative path: text }.
async function readTree(dir) {
    const files = {};
    const walk = async (d, rel) => {
        for (const ent of await fs.promises.readdir(d, { withFileTypes: true })) {
            const full = path.join(d, ent.name);
            const r = rel ? rel + '/' + ent.name : ent.name;
            if (ent.isDirectory()) { if (!/^(bin|obj)$/i.test(ent.name)) await walk(full, r); }
            else if (/\.(xml|json)$/i.test(ent.name)) files[r] = await fs.promises.readFile(full, 'utf-8');
        }
    };
    await walk(dir, '');
    return files;
}

ipcMain.handle('ama:read-tree', async (event, { dir }) => {
    try { return { ok: true, files: await readTree(dir) }; }
    catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

// Picks a TIA project, runs the read-only extractor (tools/tia-extractor, TIA Openness)
// and returns the exported files. TIA Portal with Openness and the .NET SDK are required.
ipcMain.handle('ama:tia-extract', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const picked = await dialog.showOpenDialog(win, {
        title: 'Choose the TIA Portal project',
        properties: ['openFile'],
        filters: [{ name: 'TIA Portal project', extensions: ['ap15', 'ap15_1', 'ap16', 'ap17', 'ap18', 'ap19', 'ap20', 'ap21', 'ap22'] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };
    const project = picked.filePaths[0];
    try {
        // the tool is built next to its sources: work on a copy in the user's data folder
        const src = path.join(__dirname, '..', 'tools', 'tia-extractor');
        const work = path.join(app.getPath('userData'), 'tia-extractor');
        await fs.promises.mkdir(work, { recursive: true });
        for (const f of ['Program.cs', 'TiaExtractor.csproj', 'RUN.bat']) await fs.promises.copyFile(path.join(src, f), path.join(work, f));
        const out = path.join(app.getPath('userData'), 'tia-exports', path.basename(project).replace(/\.[^.]+$/, '') + '_' + Date.now());
        await fs.promises.mkdir(out, { recursive: true });
        // The tool prints "##STATUS text" and "##PROGRESS done total text": forwarded to the window as it runs.
        let log = '';
        const send = (p) => { try { if (!event.sender.isDestroyed()) event.sender.send('ama:tia-progress', p); } catch { /* window closed */ } };
        send({ text: 'Preparing the TIA Portal reader' });
        const code = await new Promise((resolve) => {
            // quoted by hand: project paths often contain spaces
            const child = spawn('cmd.exe', ['/d', '/s', '/c', `""${path.join(work, 'RUN.bat')}" "${project}" "${out}""`],
                { cwd: work, windowsHide: true, windowsVerbatimArguments: true });
            let pending = '';
            const onData = (buf) => {
                pending += buf.toString();
                const lines = pending.split(/\r?\n/);
                pending = lines.pop() || '';
                for (const line of lines) {
                    log += line + '\n';
                    const st = /^##STATUS (.*)$/.exec(line);
                    const pr = /^##PROGRESS (\d+) (\d+) (.*)$/.exec(line);
                    if (st) send({ text: st[1] });
                    else if (pr) send({ done: Number(pr[1]), total: Number(pr[2]), text: pr[3] });
                }
            };
            child.stdout.on('data', onData);
            child.stderr.on('data', onData);
            child.on('error', (e) => { log += String((e && e.message) || e); resolve(1); });
            child.on('close', (c) => { log += pending; resolve(c); });
        });
        if (code !== 0) {
            const lines = log.trim().split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('##'));
            return { ok: false, error: lines.filter(l => /ERROR|FATAL/.test(l)).join(' ') || lines.slice(-2).join(' ') || 'The TIA Portal export failed.', log, project };
        }
        send({ text: 'Reading the exported files' });
        return { ok: true, project, dir: out, log, files: await readTree(out) };
    } catch (e) {
        return { ok: false, error: (e && e.message) || String(e), project };
    }
});
