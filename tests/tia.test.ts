// Import from TIA Portal: invented SimaticML fixtures (no real project data).
import assert from 'node:assert/strict';
import { parseXml, find, renderScl, renderFlgNet } from '../lib/tiaXml';
import { importTia } from '../lib/tiaImport';

let n = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); n++; console.log('  ok  ' + name); }
    catch (e: any) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const doc = (body: string) => `<?xml version="1.0" encoding="utf-8"?>\n<Document>\n<Engineering version="V20" />\n${body}\n</Document>`;
const ml = (comp: string, text: string) => `<MultilingualText ID="1" CompositionName="${comp}"><ObjectList><MultilingualTextItem ID="2" CompositionName="Items"><AttributeList><Culture>en-GB</Culture><Text>${text}</Text></AttributeList></MultilingualTextItem></ObjectList></MultilingualText>`;
const glob = (uid: number, ...names: string[]) => `<Access Scope="GlobalVariable" UId="${uid}"><Symbol>${names.map(x => `<Component Name="${x}" />`).join('')}</Symbol></Access>`;

// Network: ( "Start" OR "Motor" ) AND NOT "Stop"  ->  coil "Motor";  then TON and a set coil
const LAD = `<FlgNet xmlns="http://www.siemens.com/automation/Openness/SW/NetworkSource/FlgNet/v5">
<Parts>
  ${glob(21, 'Start')}${glob(22, 'Motor')}${glob(23, 'Stop')}${glob(24, 'Motor')}${glob(25, 'Data', 'Alm_Jam')}
  <Access Scope="TypedConstant" UId="26"><Constant><ConstantValue>T#3S</ConstantValue></Constant></Access>
  <Part Name="Contact" UId="31" />
  <Part Name="Contact" UId="32" />
  <Part Name="O" UId="33"><TemplateValue Name="Card" Type="Cardinality">2</TemplateValue></Part>
  <Part Name="Contact" UId="34"><Negated Name="operand" /></Part>
  <Part Name="Coil" UId="35" />
  <Part Name="TON" Version="1.0" UId="36"><Instance Scope="GlobalVariable" UId="37"><Component Name="JamTimer" /></Instance></Part>
  <Part Name="SCoil" UId="38" />
</Parts>
<Wires>
  <Wire UId="41"><Powerrail /><NameCon UId="31" Name="in" /><NameCon UId="32" Name="in" /></Wire>
  <Wire UId="42"><IdentCon UId="21" /><NameCon UId="31" Name="operand" /></Wire>
  <Wire UId="43"><IdentCon UId="22" /><NameCon UId="32" Name="operand" /></Wire>
  <Wire UId="44"><NameCon UId="31" Name="out" /><NameCon UId="33" Name="in1" /></Wire>
  <Wire UId="45"><NameCon UId="32" Name="out" /><NameCon UId="33" Name="in2" /></Wire>
  <Wire UId="46"><NameCon UId="33" Name="out" /><NameCon UId="34" Name="in" /></Wire>
  <Wire UId="47"><IdentCon UId="23" /><NameCon UId="34" Name="operand" /></Wire>
  <Wire UId="48"><NameCon UId="34" Name="out" /><NameCon UId="35" Name="in" /></Wire>
  <Wire UId="49"><IdentCon UId="24" /><NameCon UId="35" Name="operand" /></Wire>
  <Wire UId="50"><NameCon UId="35" Name="out" /><NameCon UId="36" Name="IN" /></Wire>
  <Wire UId="51"><IdentCon UId="26" /><NameCon UId="36" Name="PT" /></Wire>
  <Wire UId="52"><NameCon UId="36" Name="Q" /><NameCon UId="38" Name="in" /></Wire>
  <Wire UId="53"><IdentCon UId="25" /><NameCon UId="38" Name="operand" /></Wire>
</Wires>
</FlgNet>`;

const SCL = `<StructuredText xmlns="http://www.siemens.com/automation/Openness/SW/NetworkSource/StructuredText/v4">
<LineComment><Text> scale</Text></LineComment><NewLine Num="1" />
<Access Scope="LocalVariable"><Symbol><Component Name="Out" /></Symbol></Access><Blank Num="1" /><Token Text=":=" /><Blank Num="1" />
<Access Scope="GlobalVariable"><Symbol><Component Name="Data" /><Component Name="Raw"><Token Text="[" /><Access Scope="LiteralConstant"><Constant><ConstantValue>2</ConstantValue></Constant></Access><Token Text="]" /></Component></Symbol></Access>
<Blank Num="1" /><Token Text="*" /><Blank Num="1" /><Access Scope="LiteralConstant"><Constant><ConstantValue>0.5</ConstantValue></Constant></Access><Token Text=";" />
</StructuredText>`;

const block = (kind: string, name: string, lang: string, iface: string, units: string, extra = '') => doc(`<SW.Blocks.${kind} ID="0"><AttributeList>
<Interface><Sections xmlns="http://www.siemens.com/automation/Openness/SW/Interface/v5">${iface}</Sections></Interface>${extra}
<Name>${name}</Name><Number>1</Number><ProgrammingLanguage>${lang}</ProgrammingLanguage></AttributeList>
<ObjectList>${ml('Comment', '')}${units}</ObjectList></SW.Blocks.${kind}>`);
const unit = (lang: string, src: string, title: string) => `<SW.Blocks.CompileUnit ID="5" CompositionName="CompileUnits"><AttributeList><NetworkSource>${src}</NetworkSource><ProgrammingLanguage>${lang}</ProgrammingLanguage></AttributeList><ObjectList>${ml('Title', title)}</ObjectList></SW.Blocks.CompileUnit>`;

const FILES: Record<string, string> = {
    'manifest.json': JSON.stringify({ project: 'DemoLine', errors: [] }),
    'hardware.json': JSON.stringify({ devices: [
        { name: 'PLC_1', type: 'System:Device.S71500', items: [
            { name: 'plc', depth: 0, type: 'OrderNumber:6ES7 000-0AA00-0AB0/V4.0', classification: 'CPU', addresses: [] },
            { name: 'PROFINET interface_1', depth: 1, type: '', classification: 'None', addresses: [], nodes: [{ ip: '192.168.0.1', mask: '255.255.255.0', pnName: 'plc', subnet: 'PN/IE_1' }] },
            { name: 'DI 16', depth: 0, type: 'OrderNumber:6ES7 111-1AA00-0AB0/V1.0', classification: 'None', addresses: [] },
            { name: 'DI 16_2', depth: 0, type: 'OrderNumber:6ES7 111-1AA00-0AB0/V1.0', classification: 'None', addresses: [] },
        ] },
        { name: 'Drive_1', type: 'System:Device.G120', items: [
            { name: 'drive', depth: 0, type: 'OrderNumber:6SL0000-0AA00-0AA0/4.7', classification: 'HM', addresses: [] },
            { name: 'PROFINET interface', depth: 1, type: '', classification: 'None', addresses: [], nodes: [{ ip: '192.168.0.5', mask: '255.255.255.0', pnName: 'drive_1', subnet: 'PN/IE_1' }] },
        ] },
    ] }),
    'plc/blocks/Main.xml': block('OB', 'Main', 'LAD', '', ''),
    'plc/blocks/Area_A/Unit_Line/EM_Conveyor/10_Conveyor.xml': block('FC', '10_Conveyor', 'LAD', '<Section Name="Temp"><Member Name="aux" Datatype="Bool" /></Section>', unit('LAD', LAD, 'Motor start/stop')),
    'plc/blocks/Area_A/Unit_Line/EM_Conveyor/Data.xml': block('GlobalDB', 'Data', 'DB',
        `<Section Name="Static"><Member Name="Alm_Jam" Datatype="Bool"><Comment><MultiLanguageText Lang="en-GB">Conveyor jammed</MultiLanguageText></Comment></Member>
         <Member Name="Raw" Datatype="Array[0..3] of Int" />
         <Member Name="Cfg" Datatype="Struct"><Member Name="Speed" Datatype="Real"><StartValue>1.5</StartValue></Member><Member Name="Wrn_Slow" Datatype="Bool" /></Member></Section>`, ''),
    'plc/blocks/Area_A/Unit_Line/EM_Conveyor/CM_Scale/Scale.xml': block('FC', 'Scale', 'SCL', '<Section Name="Output"><Member Name="Out" Datatype="Real" /></Section>', unit('SCL', SCL, '')),
    'plc/blocks/Lib/FB_Filter.xml': block('FB', 'FB_Filter', 'SCL', '<Section Name="Input"><Member Name="In" Datatype="Bool" /></Section><Section Name="Static"><Member Name="Count" Datatype="Int" /></Section>', unit('SCL', SCL, '')),
    'plc/blocks/Area_A/Unit_Line/EM_Conveyor/JamTimer.xml': block('InstanceDB', 'JamTimer', 'DB', '', '', '<InstanceOfName>FB_Filter</InstanceOfName>'),
    'plc/tags/IO.xml': doc(`<SW.Tags.PlcTagTable ID="0"><AttributeList><Name>IO</Name></AttributeList><ObjectList>
        ${['Start|Bool|%I0.0|Start button', 'Stop|Bool|%I0.1|', 'Motor|Bool|%Q0.0|Conveyor motor', 'Level|Int|%IW10|Tank level', 'Spare|Bool|%I5.0|', 'Flt_Drive|Bool|%M10.0|Drive fault'].map((t, i) => {
        const [name, type, addr, c] = t.split('|');
        return `<SW.Tags.PlcTag ID="${i + 1}" CompositionName="Tags"><AttributeList><DataTypeName>${type}</DataTypeName><LogicalAddress>${addr}</LogicalAddress><Name>${name}</Name></AttributeList><ObjectList>${ml('Comment', c)}</ObjectList></SW.Tags.PlcTag>`;
    }).join('')}</ObjectList></SW.Tags.PlcTagTable>`),
    'plc/types/typ_Recipe.xml': doc(`<SW.Types.PlcStruct ID="0"><AttributeList><Interface><Sections xmlns="x"><Section Name="None"><Member Name="Speed" Datatype="Real" /><Member Name="Name" Datatype="String[20]" /></Section></Sections></Interface><Name>typ_Recipe</Name></AttributeList><ObjectList>${ml('Comment', 'Recipe data')}</ObjectList></SW.Types.PlcStruct>`),
};

console.log('TIA: reading SimaticML');
test('XML reader handles attributes, entities and self-closing tags', () => {
    const x = parseXml('<?xml version="1.0"?><a n="1 &amp; 2"><b/><c>t &lt; u</c><!-- x --></a>');
    assert.equal(x.children[0].attrs.n, '1 & 2');
    assert.equal(find(x, 'c')!.text, 't < u');
    assert.equal(x.children[0].children.length, 2);
});
test('SCL network is put back together as text', () => {
    assert.equal(renderScl(find(parseXml(SCL), 'StructuredText')!), '// scale\n#Out := "Data".Raw[2] * 0.5;');
});
test('LAD network becomes the equivalent Structured Text', () => {
    const st = renderFlgNet(find(parseXml(LAD), 'FlgNet')!);
    assert.ok(st.includes('"Motor" := ("Start" OR "Motor") AND NOT "Stop";'), st);
    assert.ok(st.includes('"JamTimer"(IN := ("Start" OR "Motor") AND NOT "Stop", PT := T#3S);'), st);
    assert.ok(st.includes('IF "JamTimer".Q THEN\n    "Data".Alm_Jam := TRUE;\nEND_IF;'), st);
});

console.log('TIA: building the machine');
const r = importTia(FILES, 'DemoLine.ap20');
const p = r.project;
const em = p.equipmentModules.find(e => e.name === 'EM_Conveyor')!;
test('folders become Unit / EM / CM; Area folders do not', () => {
    assert.deepEqual(p.units.map(u => u.name).sort(), ['UN_DemoLine', 'Unit_Line']);
    assert.ok(em); assert.ok(p.controlModules.find(c => c.name === 'CM_Scale'));
    const line = p.units.find(u => u.name === 'Unit_Line')!;
    assert.deepEqual(line.assignedEMs, [em.id]);
    assert.equal(p.assembly.tree.length, 2);
    assert.equal(p.assembly.name, 'DemoLine');
});
test('no variable is left out: DB members (structs flattened), instance DBs, memory tags', () => {
    const names = em.variables.map(v => v.name);
    for (const x of ['Data.Alm_Jam', 'Data.Raw', 'Data.Cfg.Speed', 'Data.Cfg.Wrn_Slow', 'JamTimer']) assert.ok(names.includes(x), x);
    assert.equal(em.variables.find(v => v.name === 'Data.Raw')!.dataType, 'ARRAY OF');
    assert.equal(em.variables.find(v => v.name === 'JamTimer')!.customDataType, 'FB_Filter');
    const all = [...p.units, ...p.equipmentModules, ...p.controlModules].flatMap(e => e.variables.map(v => v.name));
    assert.ok(all.includes('Flt_Drive'));
});
test('every I/O tag is imported and given to the entity that uses it; unused ones stay in the main unit', () => {
    assert.deepEqual(em.io.map(i => `${i.signalId}:${i.signalType}:${i.address}`).sort(), ['Motor:DO:%Q0.0', 'Start:DI:%I0.0', 'Stop:DI:%I0.1']);
    const root = p.units.find(u => u.name === 'UN_DemoLine')!;
    assert.deepEqual(root.io.map(i => `${i.signalId}:${i.signalType}`).sort(), ['Level:AI', 'Spare:DI']);
    assert.equal(r.stats.io, 5); assert.equal(r.stats.tags, 6);
});
test('alarms come from Bool names, with the comment as message', () => {
    const a = em.alarms.find(x => x.alarmId === 'Alm_Jam')!;
    assert.equal(a.message, 'Conveyor jammed'); assert.equal(a.triggerVariable, '"Data".Alm_Jam');
    assert.equal(em.alarms.find(x => x.alarmId === 'Wrn_Slow')!.level, 'Warning');
    const all = [...p.units, ...p.equipmentModules, ...p.controlModules].flatMap(e => e.alarms);
    assert.equal(all.find(x => x.alarmId === 'Flt_Drive')!.level, 'Fault');
    assert.equal(r.stats.alarms, 3);
});
test('code, function blocks and data types', () => {
    assert.ok(em.code.includes('// ===== FC "10_Conveyor" [FC1] (LAD) ====='));
    assert.ok(em.code.includes('Network 1: Motor start/stop'));
    assert.ok(em.code.includes('VAR_TEMP\n    aux : Bool;\nEND_VAR'));
    const fb = p.library.find(f => f.name === 'FB_Filter')!;
    assert.deepEqual(fb.variables.map(v => `${v.name}:${v.scope}`), ['In:Input', 'Count:Local']);
    assert.ok(em.assignedFBs.includes(fb.id));
    const udt = p.library.find(f => f.name === 'typ_Recipe')!;
    assert.ok(udt.description.startsWith('[UDT]')); assert.equal(udt.variables.length, 2);
});
test('hardware: SBOM rows, grouped modules and topology', () => {
    const s = p.assembly.sbom;
    assert.equal(s.find(x => x.ipAddress === '192.168.0.1')!.supplierCode, '6ES7 000-0AA00-0AB0');
    assert.equal(s.find(x => x.supplierCode === '6ES7 111-1AA00-0AB0')!.quantity, 2);
    assert.equal(p.assembly.networkNodes!.length, 2); assert.equal(p.assembly.networkEdges!.length, 1);
});
test('a folder with no TIA export is refused with a clear message', () => {
    assert.throws(() => importTia({ 'readme.json': '{}' }), /No TIA Portal export/);
});

console.log(`\n${n} TIA tests passed`);
