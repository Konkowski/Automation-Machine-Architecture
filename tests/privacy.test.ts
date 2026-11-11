// Nothing private may ship: no personal names, e-mails, company or customer names.
// (The public GitHub account name, which appears in the README links and badges, is allowed on purpose.)
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const FORBIDDEN = [/tirelli/i, /thiago/i, /soldi/i, /voyant/i, /@gmail\./i, /@tirelli/i, /C:[\\/]Users[\\/]/i];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'tests', '.git', 'release', 'dist_electron']);
const SKIP_FILES = new Set(['package-lock.json']);
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|html|css|bat|txt|yml|yaml|cs|csproj)$/i;

const hits: string[] = [];
const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(full); continue; }
        if (SKIP_FILES.has(name) || !TEXT.test(name)) continue;
        const lines = readFileSync(full, 'utf8').split(/\r?\n/);
        lines.forEach((line, i) => { for (const re of FORBIDDEN) if (re.test(line)) hits.push(`${full}:${i + 1} ${re}`); });
    }
};
walk(process.cwd());
try {
    assert.deepEqual(hits, []);
    console.log('  ok  no private names, e-mails or company names in the source');
} catch (e: any) {
    console.error('FAIL  private text found:\n' + hits.slice(0, 20).join('\n'));
    process.exitCode = 1;
}
