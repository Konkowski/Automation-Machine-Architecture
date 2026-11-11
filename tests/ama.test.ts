import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultLibraryFBs, defaultUnits, defaultEMs, defaultCMs, defaultAssembly } from '../lib/defaults';
import { mergeFromCodebase, isAdjusted, isAssemblable, contentHash } from '../lib/deviation';
import { releaseIssues, errorsOf, bumpVersion } from '../lib/releaseCheck';
import { suggestFor, blockRisk, componentRisks, needsAttention, rpnBand } from '../lib/dfmeaGuide';
import { createEmptyBlock } from '../lib/helpers';
import { useStore } from '../lib/store';
import { stableStringify, buildCodebaseFiles, parseCodebaseFiles } from '../lib/codebase';

let n = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); n++; console.log('  ok  ' + name); }
    catch (e: any) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};
const empty = { library: [], units: [], equipmentModules: [], controlModules: [] } as any;
const dfmea = (over: any = {}) => ({ id: 'd' + Math.random(), failureMode: 'Jam', effect: '', cause: '', severity: 5, occurrence: 5, detection: 5, rpn: 125, controls: '', actions: '', status: 'To Do', ...over });

console.log('release checks');
test('empty CM cannot be released', () => {
    const cm = createEmptyBlock('CM', 'CM_A');
    const errs = errorsOf(releaseIssues(cm, empty)).map(i => i.text).join('|');
    assert.match(errs, /description/); assert.match(errs, /code/);
});
test('complete CM passes', () => {
    const cm = { ...createEmptyBlock('CM', 'CM_A'), description: 'Moves X', code: 'x := 1;' };
    assert.equal(errorsOf(releaseIssues(cm, empty)).length, 0);
});
test('parent needs Released children', () => {
    const fb = { ...createEmptyBlock('FB', 'FB_A'), description: 'd', code: 'c', status: 'In Review' };
    const cm = { ...createEmptyBlock('CM', 'CM_A'), description: 'd', code: 'c', assignedFBs: [fb.id] };
    assert.ok(errorsOf(releaseIssues(cm, { ...empty, library: [fb] })).some(i => /release it first/i.test(i.text)));
    assert.equal(errorsOf(releaseIssues(cm, { ...empty, library: [{ ...fb, status: 'Released' }] })).length, 0);
});
test('critical open DFMEA blocks release, implemented does not', () => {
    const base = { ...createEmptyBlock('CM', 'CM_A'), description: 'd', code: 'c' };
    const crit = { ...base, dfmea: [dfmea({ rpn: 250, severity: 10, occurrence: 5, detection: 5 })] };
    assert.ok(errorsOf(releaseIssues(crit, empty)).some(i => /critical/.test(i.text)));
    const done = { ...base, dfmea: [dfmea({ rpn: 250, status: 'Implemented' })] };
    assert.equal(errorsOf(releaseIssues(done, empty)).length, 0);
});
test('bumpVersion', () => { assert.equal(bumpVersion('1.0'), '1.1'); assert.equal(bumpVersion('2.3.9'), '2.3.10'); });

console.log('dfmea guidance');
test('bands', () => { assert.equal(rpnBand(250), 'critical'); assert.equal(rpnBand(100), 'high'); assert.equal(rpnBand(49), 'low'); });
test('severity 9 asks for a safety interlock', () => {
    const b = createEmptyBlock('CM', 'CM_A');
    assert.ok(suggestFor({ severity: 9, occurrence: 2, detection: 2 } as any, b).some(s => s.kind === 'safety'));
});
test('hard to detect sensor gets a plausibility hint and an alarm suggestion', () => {
    const b = { ...createEmptyBlock('CM', 'CM_S'), category: 'Sensor' };
    const tips = suggestFor({ severity: 6, occurrence: 4, detection: 8 } as any, b);
    assert.ok(tips.some(s => /plausibility/i.test(s.text)));
    assert.ok(tips.some(s => s.kind === 'alarm'));
});
test('component risk ranks by RPN and flags missing alternative', () => {
    const part = { id: 'p1', code: 'X', description: 'Motor', manufacturer: '', quantity: 1 };
    const b = { ...createEmptyBlock('CM', 'CM_M'), bom: [part], dfmea: [dfmea({ componentId: 'p1', rpn: 200, occurrence: 7 })] };
    const rows = componentRisks([b as any]);
    assert.equal(rows.length, 1); assert.match(rows[0].hint, /alternative/i);
    assert.equal(blockRisk(b as any).open, 1);
    assert.ok(needsAttention(b.dfmea[0] as any));
});

console.log('store rules');
const reset = () => useStore.setState({ workspaceKind: 'codebase', units: [], equipmentModules: [], controlModules: [], library: [], activeUser: 'tester' } as any);
test('editing a Released block returns it to Draft with a new version and a revision', () => {
    reset();
    const cm = { ...createEmptyBlock('CM', 'CM_A'), description: 'd', code: 'c', status: 'Released' };
    useStore.setState({ controlModules: [cm] } as any);
    useStore.getState().updateEntity(cm.id, 'CM', { code: 'c2' });
    const after = useStore.getState().controlModules[0];
    assert.equal(after.status, 'Draft'); assert.equal(after.currentVersion, '1.1');
    assert.equal(after.revisions[after.revisions.length - 1].notes, 'Edited after release: back to Draft');
});
test('changing only the status of a Released block is not an edit', () => {
    reset();
    const cm = { ...createEmptyBlock('CM', 'CM_A'), status: 'Released' };
    useStore.setState({ controlModules: [cm] } as any);
    useStore.getState().updateEntity(cm.id, 'CM', { status: 'Deprecated' });
    assert.equal(useStore.getState().controlModules[0].status, 'Deprecated');
    assert.equal(useStore.getState().controlModules[0].currentVersion, '1.0');
});
test('machine assembly: copies, names and chosen alternative reach the SBOM', () => {
    reset();
    useStore.setState({ workspaceKind: 'machine', codebase: null } as any);
    const part = { id: 'p1', code: 'MOT-1', description: 'Motor', manufacturer: 'A', quantity: 2, alternatives: [{ id: 'a1', code: 'MOT-2', manufacturer: 'B', description: 'Motor B' }] };
    const cm = { ...createEmptyBlock('CM', 'CM_Head'), bom: [part] };
    useStore.setState({ controlModules: [cm] } as any);
    const st = () => useStore.getState();
    st().addToAssembly(null, cm.id, 'CM');
    const id = st().assembly.tree[0].id;
    st().duplicateAssemblyNode(id, 2);
    assert.deepEqual(st().assembly.tree.map(x => x.label), ['CM_Head 1', 'CM_Head 2', 'CM_Head 3']);
    assert.equal(st().assembly.sbom.find(r => r.supplierCode === 'MOT-1')!.quantity, 6);
    st().updateAssemblyNode(st().assembly.tree[2].id, { componentChoice: { p1: 'a1' } });
    const rows = st().assembly.sbom;
    assert.equal(rows.find(r => r.supplierCode === 'MOT-1')!.quantity, 4);
    assert.equal(rows.find(r => r.supplierCode === 'MOT-2')!.quantity, 2);
});

console.log('code base format');
test('new fields survive a code base round trip', () => {
    const part = { id: 'p1', code: 'X', description: 'Motor', manufacturer: '', quantity: 1, alternatives: [{ id: 'a1', code: 'Y', manufacturer: '', description: '' }] };
    const cm = { ...createEmptyBlock('CM', 'CM_A'), bom: [part], dfmea: [dfmea({ componentId: 'p1', alarmId: 'al1' })] };
    const info = { name: 'CB', version: '1.0.0', description: '', path: '' };
    const { files } = buildCodebaseFiles(info, { ...empty, controlModules: [cm] });
    const back = parseCodebaseFiles(files).lists.controlModules[0] as any;
    assert.equal(back.bom[0].alternatives[0].code, 'Y');
    assert.equal(back.dfmea[0].componentId, 'p1'); assert.equal(back.dfmea[0].alarmId, 'al1');
    assert.equal(stableStringify(back), stableStringify(cm));
});

console.log('machine SBOM and topology');
test('loading the demo machine keeps SBOM, topology nodes and edges', () => {
    const data = { library: defaultLibraryFBs, units: defaultUnits, equipmentModules: defaultEMs, controlModules: defaultCMs, assembly: defaultAssembly };
    useStore.getState().loadProject(JSON.parse(JSON.stringify(data)));
    const a = useStore.getState().assembly;
    assert.equal(a.sbom.length, defaultAssembly.sbom.length);
    assert.equal((a.networkNodes || []).length, defaultAssembly.networkNodes!.length);
    assert.equal((a.networkEdges || []).length, defaultAssembly.networkEdges!.length);
    assert.ok(a.sbom.length > 0 && a.tree.length > 0);
});
test('customer changes on a derived SBOM row survive re-sync; removed parts stay off', () => {
    reset();
    useStore.setState({ workspaceKind: 'machine', codebase: null } as any);
    const parts = [
        { id: 'p1', code: 'MOT-1', description: 'Motor', manufacturer: 'A', quantity: 2 },
        { id: 'p2', code: 'SEN-1', description: 'Sensor', manufacturer: 'A', quantity: 1 },
    ];
    const cm = { ...createEmptyBlock('CM', 'CM_X'), bom: parts };
    useStore.setState({ controlModules: [cm] } as any);
    const st = () => useStore.getState();
    st().addToAssembly(null, cm.id, 'CM');
    const row = (code: string) => st().assembly.sbom.find(r => r.supplierCode === code)!;
    st().overrideSbomRow(row('MOT-1').id, { quantity: 5, supplierCode: 'MOT-9' });
    assert.equal(st().assembly.sbom.find(r => r.supplierCode === 'MOT-9')!.quantity, 5);
    st().addToAssembly(null, cm.id, 'CM');   // any re-sync must keep the customer change
    assert.equal(st().assembly.sbom.find(r => r.supplierCode === 'MOT-9')!.quantity, 5);
    st().removeSbomPart(row('SEN-1').id);
    st().addToAssembly(null, cm.id, 'CM');
    assert.equal(st().assembly.sbom.some(r => r.supplierCode === 'SEN-1'), false);
    assert.equal(st().assembly.sbomRemoved!.length, 1);
    st().restoreSbomPart('p2');
    assert.ok(st().assembly.sbom.some(r => r.supplierCode === 'SEN-1'));
    const back = st().assembly.sbom.find(r => r.supplierCode === 'MOT-9')!;
    st().overrideSbomRow(back.id, null);
    assert.equal(st().assembly.sbom.find(r => r.supplierCode === 'MOT-1')!.quantity, 6);
});

console.log('machine keeps its own blocks when a code base is linked');
test('merge never deletes: adjusted and machine-only blocks survive, untouched ones update', () => {
    const mk = (name: string, code: string) => ({ ...createEmptyBlock('CM', name), description: 'd', code });
    const a = mk('CM_A', 'a1'), b = mk('CM_B', 'b1'), local = mk('CM_Local', 'x');
    const cb1 = { ...empty, controlModules: [a, b] };
    // first link: everything new
    const first = mergeFromCodebase({ ...empty, controlModules: [local] }, cb1);
    assert.equal(first.summary.added, 2); assert.equal(first.summary.machineOnly, 1);
    const cur = first.lists.controlModules as any[];
    assert.equal(cur.length, 3);
    assert.equal(cur.find(e => e.name === 'CM_Local').origin, 'machine');
    // the machine adjusts CM_A (alarms, code...)
    const adj = cur.map(e => (e.name === 'CM_A' ? { ...e, code: 'a-adjusted' } : e));
    assert.ok(isAdjusted(adj.find(e => e.name === 'CM_A')));
    assert.equal(isAdjusted(adj.find(e => e.name === 'CM_B')), false);
    // the code base changes both A and B, and drops nothing; refresh
    const cb2 = { ...empty, controlModules: [{ ...a, code: 'a2' }, { ...b, code: 'b2' }] };
    const second = mergeFromCodebase({ ...empty, controlModules: adj }, cb2);
    const out = second.lists.controlModules as any[];
    assert.equal(out.find(e => e.name === 'CM_A').code, 'a-adjusted');   // kept
    assert.equal(out.find(e => e.name === 'CM_B').code, 'b2');           // updated
    assert.equal(out.find(e => e.name === 'CM_Local').code, 'x');        // kept
    assert.equal(second.summary.keptAdjusted, 1); assert.equal(second.summary.adjustedNewer, 1);
    // the code base drops CM_B: the machine keeps it as its own
    const third = mergeFromCodebase({ ...empty, controlModules: out }, { ...empty, controlModules: [{ ...a, code: 'a2' }] });
    assert.equal((third.lists.controlModules as any[]).find(e => e.name === 'CM_B').origin, 'machine');
    assert.equal(third.lists.controlModules.length, 3);
});
test('assembling: a code base block must be Released unless adjusted; machine-only is free', () => {
    const base = { ...createEmptyBlock('CM', 'CM_A'), description: 'd', code: 'c' } as any;
    assert.equal(isAssemblable({ ...base, origin: 'codebase', baseline: contentHash(base), status: 'Draft' }), false);
    assert.equal(isAssemblable({ ...base, origin: 'codebase', baseline: contentHash(base), status: 'Released' }), true);
    assert.equal(isAssemblable({ ...base, origin: 'codebase', baseline: contentHash(base), code: 'changed', status: 'Draft' }), true);
    assert.equal(isAssemblable({ ...base, origin: 'machine', status: 'Draft' }), true);
});

console.log('opening a code base folder');
test('reads the current layout and the older Git-export layout', () => {
    const cm = { ...createEmptyBlock('CM', 'CM_A'), description: 'd', code: 'c' };
    const { files } = buildCodebaseFiles({ name: 'CB', version: '2.0.0', description: '', path: '' }, { ...empty, controlModules: [cm] });
    const now = parseCodebaseFiles(files);
    assert.equal(now.recognized, 1); assert.equal(now.info.version, '2.0.0'); assert.equal(now.lists.controlModules.length, 1);
    const legacy = parseCodebaseFiles({ 'physical_hierarchy/control_modules/CM_A.json': JSON.stringify(cm), 'software_library/function_blocks/FB_X.json': JSON.stringify(createEmptyBlock('FB', 'FB_X')) });
    assert.equal(legacy.recognized, 2); assert.equal(legacy.lists.library.length, 1); assert.equal(legacy.lists.controlModules.length, 1);
    assert.equal(parseCodebaseFiles({}).recognized, 0);
});

console.log(`\n${n} tests passed`);
