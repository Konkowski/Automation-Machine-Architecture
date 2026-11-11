// ============================================================
// AMA — reading TIA Portal exports (SimaticML)
//
// A tiny XML reader (runs in the browser, in Electron and in Node tests) and
// the two code readers:
//   - SCL networks are stored as tokens: they are put back together as text;
//   - LAD/FBD networks are a graph of parts and wires: each network is turned
//     into the equivalent Structured Text, so the logic stays readable and
//     can be exported again.
// ============================================================

export interface XNode {
    tag: string;
    attrs: Record<string, string>;
    children: XNode[];
    text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string): string =>
    s.indexOf('&') < 0 ? s : s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
        if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
        return ENTITIES[e] ?? m;
    });

/** Parses an XML document into a plain tree. Throws on text that is not XML at all. */
export function parseXml(src: string): XNode {
    const root: XNode = { tag: '#root', attrs: {}, children: [], text: '' };
    const stack: XNode[] = [root];
    const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
        const top = stack[stack.length - 1];
        if (m[1] !== undefined) top.text += m[1];
        else if (m[2] !== undefined) { if (stack.length > 1) stack.pop(); }
        else if (m[3] !== undefined) {
            const node: XNode = { tag: m[3], attrs: {}, children: [], text: '' };
            if (m[4]) {
                const ar = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
                let a: RegExpExecArray | null;
                while ((a = ar.exec(m[4]))) node.attrs[a[1]] = decode(a[2] ?? a[3] ?? '');
            }
            top.children.push(node);
            if (!m[5]) stack.push(node);
        } else if (m[6] !== undefined && m[6].trim()) top.text += decode(m[6]);
    }
    if (!root.children.length) throw new Error('Not an XML document.');
    return root;
}

export const kids = (n: XNode | undefined | null, tag?: string): XNode[] =>
    !n ? [] : tag ? n.children.filter(c => c.tag === tag) : n.children;
export const kid = (n: XNode | undefined | null, tag: string): XNode | undefined => n?.children.find(c => c.tag === tag);
export function find(n: XNode | undefined | null, tag: string): XNode | undefined {
    if (!n) return undefined;
    for (const c of n.children) {
        if (c.tag === tag) return c;
        const r = find(c, tag);
        if (r) return r;
    }
    return undefined;
}
export function findAll(n: XNode | undefined | null, tag: string, out: XNode[] = []): XNode[] {
    if (!n) return out;
    for (const c of n.children) { if (c.tag === tag) out.push(c); findAll(c, tag, out); }
    return out;
}

/** Text of a <MultilingualText CompositionName="..."> child: English first, else any language. */
export function mlText(owner: XNode | undefined, composition: string): string {
    const objs = kid(owner, 'ObjectList');
    const ml = kids(objs, 'MultilingualText').find(x => x.attrs.CompositionName === composition);
    if (!ml) return '';
    const items = findAll(ml, 'MultilingualTextItem').map(i => {
        const al = kid(i, 'AttributeList');
        return { culture: kid(al, 'Culture')?.text || '', text: (kid(al, 'Text')?.text || '').trim() };
    }).filter(i => i.text);
    return (items.find(i => i.culture.startsWith('en')) || items[0])?.text || '';
}

// ─── Operands ──────────────────────────────────────────────
function renderComponent(c: XNode, render: (n: XNode) => string): string {
    let s = c.attrs.Name || '';
    const hasTokens = c.children.some(x => x.tag === 'Token');
    if (hasTokens) return s + c.children.map(render).join('');
    const idx = kids(c, 'Access').map(render);
    if (idx.length) s += `[${idx.join(', ')}]`;
    return s;
}

/** An <Access> (variable, constant, call) as text. */
export function renderAccess(a: XNode, render: (n: XNode) => string): string {
    const scope = a.attrs.Scope || '';
    const sym = kid(a, 'Symbol');
    if (sym) {
        const parts = kids(sym, 'Component').map(c => renderComponent(c, render));
        if (!parts.length) return '';
        if (scope === 'GlobalVariable' || scope === 'GlobalConstant') parts[0] = `"${parts[0]}"`;
        else if (scope === 'LocalVariable' || scope === 'LocalConstant') parts[0] = `#${parts[0]}`;
        return parts.join('.');
    }
    const c = kid(a, 'Constant');
    if (c) return kid(c, 'ConstantValue')?.text ?? (c.attrs.Name ? `"${c.attrs.Name}"` : '');
    const addr = kid(a, 'Address');
    if (addr) {
        const area = ({ Input: 'I', Output: 'Q', Memory: 'M', DB: 'DB' } as Record<string, string>)[addr.attrs.Area] || addr.attrs.Area || '';
        const bit = Number(addr.attrs.BitOffset || 0);
        return addr.attrs.Type === 'Bool' ? `%${area}${Math.floor(bit / 8)}.${bit % 8}` : `%${area}${Math.floor(bit / 8)}`;
    }
    return a.children.map(render).join('');   // Scope="Call" and others
}

// ─── SCL ───────────────────────────────────────────────────
/** Puts an SCL network (<StructuredText>) back together as text. */
export function renderScl(st: XNode): string {
    const render = (n: XNode): string => {
        switch (n.tag) {
            case 'Token': return n.attrs.Text || '';
            case 'Blank': return ' '.repeat(Number(n.attrs.Num || 1));
            case 'NewLine': return '\n'.repeat(Number(n.attrs.Num || 1));
            case 'Access': return renderAccess(n, render);
            case 'LineComment': return '//' + n.children.map(render).join('');
            case 'Comment': return '(*' + n.children.map(render).join('') + '*)';
            case 'Text': return n.text;
            case 'Parameter': return (n.attrs.Name || '') + n.children.map(render).join('');
            case 'Instruction': return (n.attrs.Name || '') + n.children.filter(c => c.tag !== 'TemplateValue').map(render).join('');
            case 'Instance': {
                const names = kids(n, 'Component').map(c => renderComponent(c, render));
                if (!names.length) return '';
                names[0] = n.attrs.Scope === 'LocalVariable' ? `#${names[0]}` : `"${names[0]}"`;
                return names.join('.');
            }
            case 'BooleanAttribute': case 'IntegerAttribute': case 'TemplateValue': return '';
            default: return n.children.map(render).join('');
        }
    };
    return st.children.map(render).join('').replace(/[ \t]+\n/g, '\n').trimEnd();
}

// ─── LAD / FBD ─────────────────────────────────────────────
type Src = { kind: 'rail' } | { kind: 'open' } | { kind: 'access'; uid: string } | { kind: 'pin'; uid: string; pin: string };

const CMP: Record<string, string> = { Eq: '=', Ne: '<>', Gt: '>', Ge: '>=', Lt: '<', Le: '<=' };
const MATH: Record<string, string> = { Add: '+', Sub: '-', Mul: '*', Div: '/', Mod: 'MOD' };
const PASS = new Set(['Contact', 'PContact', 'NContact', 'O', 'A', 'X', 'Not', 'PBox', 'NBox', 'Coil', 'SCoil', 'RCoil', 'PCoil', 'NCoil', ...Object.keys(CMP)]);

const paren = (s: string): string => (/\s(OR|XOR)\s/.test(s) && !/^\([^()]*\)$/.test(s) && !/^\(.*\)$/.test(s) ? `(${s})` : s);
const and = (a: string, b: string): string => (a === 'TRUE' ? b : b === 'TRUE' ? a : `${paren(a)} AND ${paren(b)}`);

/** Turns one LAD/FBD network (<FlgNet>) into the equivalent Structured Text statements. */
export function renderFlgNet(net: XNode): string {
    const rAccess = (n: XNode): string => renderAccess(n, rAccess);
    const partsEl = kid(net, 'Parts');
    const access = new Map<string, string>();
    const parts = new Map<string, XNode>();
    const order: XNode[] = [];
    for (const p of kids(partsEl)) {
        if (p.tag === 'Access') access.set(p.attrs.UId, rAccess(p));
        else if (p.tag === 'Part' || p.tag === 'Call') { parts.set(p.attrs.UId, p); order.push(p); }
    }

    const source = new Map<string, Src>();                 // input pin  -> where its value comes from
    const sinks = new Map<string, string[]>();             // output pin -> operands it writes
    const fed = new Set<string>();                         // output pins wired into another part
    for (const w of kids(kid(net, 'Wires'), 'Wire')) {
        const [first, ...rest] = w.children;
        if (!first) continue;
        const src: Src = first.tag === 'Powerrail' ? { kind: 'rail' }
            : first.tag === 'IdentCon' ? { kind: 'access', uid: first.attrs.UId }
                : first.tag === 'NameCon' ? { kind: 'pin', uid: first.attrs.UId, pin: first.attrs.Name }
                    : { kind: 'open' };
        for (const t of rest) {
            if (t.tag === 'NameCon') {
                source.set(`${t.attrs.UId}|${t.attrs.Name}`, src);
                if (src.kind === 'pin') fed.add(`${src.uid}|${src.pin}`);
            } else if (t.tag === 'IdentCon' && src.kind === 'pin') {
                const from = src as { kind: 'pin'; uid: string; pin: string };
                const k = `${from.uid}|${from.pin}`;
                sinks.set(k, [...(sinks.get(k) || []), access.get(t.attrs.UId) || '?']);
            }
        }
    }

    const nameOf = (p: XNode): string => {
        if (p.tag === 'Call') {
            const ci = kid(p, 'CallInfo');
            const inst = kid(ci, 'Instance');
            const instName = inst ? kids(inst, 'Component').map(c => c.attrs.Name).join('.') : '';
            if (instName) return inst!.attrs.Scope === 'LocalVariable' ? `#${instName}` : `"${instName}"`;
            return `"${ci?.attrs.Name || 'Call'}"`;
        }
        const inst = kid(p, 'Instance');
        if (inst) {
            const n = kids(inst, 'Component').map(c => c.attrs.Name).join('.');
            return inst.attrs.Scope === 'LocalVariable' ? `#${n}` : `"${n}"`;
        }
        return p.attrs.Name;
    };
    const negated = (p: XNode, pin: string): boolean => kids(p, 'Negated').some(n => n.attrs.Name === pin);

    const memo = new Map<string, string>();
    const busy = new Set<string>();
    const input = (uid: string, pin: string): string | null => {
        const s = source.get(`${uid}|${pin}`);
        if (!s || s.kind === 'open') return null;
        if (s.kind === 'rail') return 'TRUE';
        if (s.kind === 'access') return access.get(s.uid) ?? '?';
        return output(s.uid, s.pin);
    };
    const inputsNamed = (uid: string, prefix: string): string[] => {
        const out: string[] = [];
        for (const k of source.keys()) {
            const [u, pin] = k.split('|');
            if (u === uid && pin.startsWith(prefix) && /^\d*$/.test(pin.slice(prefix.length))) {
                const v = input(uid, pin);
                if (v !== null) out.push(v);
            }
        }
        return out;
    };
    function output(uid: string, pin: string): string {
        const key = `${uid}|${pin}`;
        if (memo.has(key)) return memo.get(key)!;
        if (busy.has(key)) return 'TRUE';
        busy.add(key);
        const p = parts.get(uid);
        let r: string;
        const name = p?.attrs.Name || '';
        const pre = (pinName: string) => input(uid, pinName) ?? 'TRUE';
        const op = () => input(uid, 'operand') ?? '?';
        if (!p) r = '?';
        else if (p.tag === 'Call') r = pin === 'eno' ? pre('en') : `${nameOf(p)}.${pin}`;
        else if (name === 'Contact') r = and(pre('in'), negated(p, 'operand') ? `NOT ${op()}` : op());
        else if (name === 'PContact') r = and(pre('in'), `R_EDGE(${op()})`);
        else if (name === 'NContact') r = and(pre('in'), `F_EDGE(${op()})`);
        else if (name === 'O') r = `(${inputsNamed(uid, 'in').join(' OR ') || 'FALSE'})`;
        else if (name === 'A') r = inputsNamed(uid, 'in').map(paren).join(' AND ') || 'TRUE';
        else if (name === 'X') r = `(${inputsNamed(uid, 'in').join(' XOR ') || 'FALSE'})`;
        else if (name === 'Not') r = `NOT ${paren(pre('in'))}`;
        else if (name === 'PBox') r = `R_EDGE(${pre('in')})`;
        else if (name === 'NBox') r = `F_EDGE(${pre('in')})`;
        else if (CMP[name]) r = and(pre('pre'), `(${input(uid, 'in1') ?? '?'} ${CMP[name]} ${input(uid, 'in2') ?? '?'})`);
        else if (/Coil$/.test(name)) r = pre('in');
        else if (pin === 'eno' || pin === 'ENO') r = pre('en');
        else r = /^(TON|TOF|TP|TONR|CTU|CTD|CTUD)$/.test(name) || kid(p, 'Instance') ? `${nameOf(p)}.${pin}` : `${name}.${pin}`;
        busy.delete(key);
        memo.set(key, r);
        return r;
    }

    const lines: string[] = [];
    const guarded = (cond: string, stmt: string) => lines.push(cond === 'TRUE' ? stmt : `IF ${cond} THEN\n    ${stmt.replace(/\n/g, '\n    ')}\nEND_IF;`);
    for (const p of order) {
        const uid = p.attrs.UId;
        const name = p.attrs.Name || '';
        if (p.tag === 'Part' && PASS.has(name)) {
            const cond = input(uid, 'in') ?? 'TRUE';
            const op = input(uid, 'operand') ?? '?';
            if (name === 'Coil') lines.push(`${op} := ${negated(p, 'operand') ? `NOT ${paren(cond)}` : cond};`);
            else if (name === 'SCoil') guarded(cond, `${op} := TRUE;`);
            else if (name === 'RCoil') guarded(cond, `${op} := FALSE;`);
            else if (name === 'PCoil') lines.push(`${op} := R_EDGE(${cond});`);
            else if (name === 'NCoil') lines.push(`${op} := F_EDGE(${cond});`);
            continue;
        }
        // a box: instruction, timer, counter or block call
        const en = input(uid, 'en') ?? 'TRUE';
        const ins: [string, string][] = [];
        for (const k of source.keys()) {
            const [u, pin] = k.split('|');
            if (u !== uid || pin === 'en') continue;
            const v = input(uid, pin);
            if (v !== null) ins.push([pin, v]);
        }
        const outs: [string, string][] = [];
        for (const [k, targets] of sinks) {
            const [u, pin] = k.split('|');
            if (u === uid) for (const t of targets) outs.push([pin, t]);
        }
        const get = (pin: string) => ins.find(i => i[0].toLowerCase() === pin)?.[1];
        let stmt: string;
        if (name === 'Move' && get('in') !== undefined && outs.length) stmt = outs.map(o => `${o[1]} := ${get('in')};`).join('\n');
        else if (MATH[name] && outs.length && ins.length >= 2) stmt = outs.map(o => `${o[1]} := ${ins.filter(i => /^in\d+$/i.test(i[0])).map(i => i[1]).join(` ${MATH[name]} `)};`).join('\n');
        else if ((name === 'Inc' || name === 'Dec') && outs.length + ins.length > 0) {
            const target = outs[0]?.[1] ?? ins[0]?.[1] ?? '?';
            stmt = `${target} := ${target} ${name === 'Inc' ? '+' : '-'} 1;`;
        } else {
            const args = [...ins.map(i => `${i[0]} := ${i[1]}`), ...outs.map(o => `${o[0]} => ${o[1]}`)];
            stmt = `${nameOf(p)}(${args.join(', ')});`;
        }
        guarded(en, stmt);
    }
    return lines.join('\n');
}
