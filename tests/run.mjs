// Runs tests/*.test.ts with no extra dependency: esbuild (already installed with Vite)
// bundles each file and Node executes it.   Usage: npm test
import { build } from 'esbuild';
import { readdirSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';

// "?raw" imports (text files bundled as strings), the way Vite does it
const rawPlugin = {
    name: 'raw',
    setup(b) {
        b.onResolve({ filter: /\?raw$/ }, a => ({ path: path.resolve(a.resolveDir, a.path.replace(/\?raw$/, '')), namespace: 'raw' }));
        b.onLoad({ filter: /.*/, namespace: 'raw' }, a => ({ contents: readFileSync(a.path, 'utf8'), loader: 'text' }));
    },
};

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '.out');
mkdirSync(out, { recursive: true });
let failed = 0;
for (const f of readdirSync(here).filter(n => n.endsWith('.test.ts'))) {
    const outfile = path.join(out, f.replace('.ts', '.mjs'));
    await build({ entryPoints: [path.join(here, f)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error', plugins: [rawPlugin] });
    const r = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
    if (r.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
