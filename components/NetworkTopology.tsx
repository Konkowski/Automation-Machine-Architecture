// ============================================================
// AMA — Network Topology Viewer (Pure React + SVG)
// No external graph library — works fully offline
// ============================================================
import React, { useCallback, useState, useRef, useEffect, useMemo } from 'react';
import { useStore } from '../lib/store';
import { HardwareItem } from '../types/machine';
import { Plus, Trash2, Cpu, HardDrive, Wifi, Server, MonitorSmartphone, Shield, Lock, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import { generateId } from '../lib/helpers';
import { newSbomItem } from '../lib/hardware';

// ─── Types ──────────────────────────────────────────────────
interface TopoNode {
    id: string;
    sbomId: string;
    x: number;
    y: number;
    label: string;
    ip: string;
    type: string;
    note: string;
}

interface TopoEdge {
    id: string;
    source: string;
    target: string;
    protocol?: string;
    customProtocol?: string;
    sourcePort?: string;
    targetPort?: string;
    subnetMask?: string;
    gateway?: string;
    isEncrypted?: boolean;
    isFirewalled?: boolean;
    iecSecurityLevel?: string;
}

interface NetworkTopologyProps {
    sbom: HardwareItem[];
}

// ─── Constants ──────────────────────────────────────────────
const NODE_W = 180;
const NODE_H = 90;
const GRID = 20;

const typeColor: Record<string, string> = {
    Hardware: '#0ea5e9',
    Software: '#a855f7',
    Network: '#22c55e',
    Service: '#f59e0b',
    Security: '#ef4444',
};

const typeIcon: Record<string, React.ReactNode> = {
    Hardware: <Cpu size={16} />,
    Software: <MonitorSmartphone size={16} />,
    Network: <Wifi size={16} />,
    Service: <Server size={16} />,
    Security: <Shield size={16} />,
};

const getProtocolAdvice = (protocol?: string) => {
    switch (protocol) {
        case 'OPC UA':
            return {
                desc: "Unified Architecture. M2M & SCADA standard. Supports native encryption.",
                defaultPort: "4840",
                type: "IP",
                securityAdvice: "IEC 62443: SL3 + Channel Encryption recommended for critical zones."
            };
        case 'PROFINET':
            return {
                desc: "Real-Time Industrial Ethernet (Siemens). Layer 2 RT/IRT (IO traffic without IP).",
                defaultPort: "34964",
                type: "Layer2_CBA",
                securityAdvice: "RT/IRT frames have no IP/ports. Port 34964 is used for CBA configuration."
            };
        case 'EtherNet/IP':
            return {
                desc: "Common Industrial Protocol su Ethernet. TCP 44818 (Explicit), UDP 2222 (Implicit).",
                defaultPort: "44818",
                type: "IP",
                securityAdvice: "Enable CIP Security for encryption. Configure IGMP snooping on the switches."
            };
        case 'EtherCAT':
            return {
                desc: "Ultra-fast real-time for motion control. Raw Ethernet frames (0x88A4, no IP/ports).",
                defaultPort: "N/A",
                type: "Layer2",
                securityAdvice: "Strict physical isolation. Requires unidirectional gateways towards external networks."
            };
        case 'Modbus TCP':
            return {
                desc: "Open, lightweight protocol. Default TCP port 502. No native security.",
                defaultPort: "502",
                type: "IP",
                securityAdvice: "Vulnerable. Must be isolated inside a conduit protected by a firewall."
            };
        case 'IO-Link':
            return {
                desc: "Point-to-point digital M12/M8 connection for sensors/actuators. No IP or network port.",
                defaultPort: "N/A",
                type: "Physical",
                securityAdvice: "Secured by physical location. Protect the cabinets from physical access."
            };
        default:
            return {
                desc: "Select a modern industrial protocol to see details and recommendations.",
                defaultPort: "",
                type: "IP",
                securityAdvice: ""
            };
    }
};

const protocolColors: Record<string, { stroke: string; glow: string; text: string }> = {
    'OPC UA': { stroke: '#06b6d4', glow: 'rgba(6, 182, 212, 0.3)', text: '#22d3ee' },      // Cyan
    'PROFINET': { stroke: '#10b981', glow: 'rgba(16, 185, 129, 0.3)', text: '#34d399' },    // Emerald Green
    'EtherNet/IP': { stroke: '#f97316', glow: 'rgba(249, 115, 22, 0.3)', text: '#fb923c' }, // Orange
    'EtherCAT': { stroke: '#eab308', glow: 'rgba(234, 179, 8, 0.3)', text: '#fde047' },    // Gold/Yellow
    'Modbus TCP': { stroke: '#ef4444', glow: 'rgba(239, 68, 68, 0.3)', text: '#fca5a5' },   // Red
    'IO-Link': { stroke: '#a855f7', glow: 'rgba(168, 85, 247, 0.3)', text: '#c084fc' },      // Purple
    'Other': { stroke: '#ec4899', glow: 'rgba(236, 72, 153, 0.3)', text: '#f472b6' },        // Pink
};

const getProtocolColors = (protocol?: string, isSelected?: boolean) => {
    if (isSelected) {
        return { stroke: '#4aa3f0', glow: 'rgba(74, 163, 240, 0.3)', text: '#4aa3f0' }; // Selected neon green glow
    }
    if (!protocol) {
        return { stroke: '#475569', glow: 'rgba(71, 85, 105, 0.1)', text: '#94a3b8' };  // Dotted grey for unconfigured
    }
    return protocolColors[protocol] || protocolColors['Other'];
};

// ─── Component ──────────────────────────────────────────────
export const NetworkTopology: React.FC<NetworkTopologyProps> = ({ sbom }) => {
    const assembly = useStore(s => s.assembly);
    const updateNetworkTopology = useStore(s => s.updateNetworkTopology);

    const svgRef = useRef<SVGSVGElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const [nodes, setNodes] = useState<TopoNode[]>([]);
    const [edges, setEdges] = useState<TopoEdge[]>([]);
    const [draggingId, setDraggingId] = useState<string | null>(null);
    const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
    const [connecting, setConnecting] = useState<string | null>(null);
    const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    
    // Protocol / Connection Selection states
    const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
    const [edgePopupPos, setEdgePopupPos] = useState<{ x: number; y: number } | null>(null);

    // Panning state
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [isPanning, setIsPanning] = useState(false);
    const [panStart, setPanStart] = useState({ x: 0, y: 0 });
    const [zoom, setZoom] = useState(1);

    const updateEdge = (edgeId: string, updates: Partial<TopoEdge>) => {
        const next = edges.map(ed => ed.id === edgeId ? { ...ed, ...updates } : ed);
        setEdges(next);
        persist(nodes, next);
    };

    // Load from store on mount
    useEffect(() => {
        if (assembly.networkNodes && assembly.networkNodes.length > 0) {
            setNodes(assembly.networkNodes as TopoNode[]);
            setEdges((assembly.networkEdges || []) as TopoEdge[]);
        }
    }, []);

    // Persist changes
    const persist = useCallback((n: TopoNode[], e: TopoEdge[]) => {
        updateNetworkTopology(n, e);
    }, [updateNetworkTopology]);

    // Helpers
    const screenToSvg = (clientX: number, clientY: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return { x: 0, y: 0 };
        return {
            x: (clientX - rect.left - pan.x) / zoom,
            y: (clientY - rect.top - pan.y) / zoom
        };
    };

    // ─── Wheel zoom at cursor (same model as the Albero diagram) ──
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
            setZoom(prev => {
                const next = Math.max(0.2, Math.min(3, prev * factor));
                const k = next / prev;
                setPan(p => ({ x: cx - (cx - p.x) * k, y: cy - (cy - p.y) * k }));
                return next;
            });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, []);

    // Zoom around the canvas centre (toolbar buttons)
    const zoomCenter = (factor: number) => {
        const el = containerRef.current;
        if (!el) return;
        const { width, height } = el.getBoundingClientRect();
        const cx = width / 2, cy = height / 2;
        setZoom(prev => {
            const next = Math.max(0.2, Math.min(3, prev * factor));
            const k = next / prev;
            setPan(p => ({ x: cx - (cx - p.x) * k, y: cy - (cy - p.y) * k }));
            return next;
        });
    };

    // ─── REAL-TIME SYNC HOOK ──────────────────────────────────
    // Resolves node properties dynamically from the matching SBOM item,
    // solving the synchronization bug where editing the SBOM table did
    // not update existing topology nodes.
    const resolvedNodes = useMemo(() => {
        return nodes.map(node => {
            const sbomItem = sbom.find(item => item.id === node.sbomId);
            if (sbomItem) {
                return {
                    ...node,
                    label: sbomItem.hardware || 'Unknown Device',
                    ip: sbomItem.ipAddress || '',
                    type: sbomItem.type || 'Hardware',
                    note: sbomItem.notes || '',
                };
            }
            return node;
        });
    }, [nodes, sbom]);

    // ─── Edge Helpers (Paths and Midpoints) ────────────────────
    
    // Connect preview and edges to circle handles
    const getEdgeCoords = (edge: TopoEdge) => {
        const src = resolvedNodes.find(n => n.id === edge.source);
        const tgt = resolvedNodes.find(n => n.id === edge.target);
        if (!src || !tgt) return null;
        
        const srcCx = src.x + NODE_W / 2;
        const tgtCx = tgt.x + NODE_W / 2;
        
        let sx: number, sy: number, tx: number, ty: number;
        if (srcCx <= tgtCx) {
            // Source is left of target: exit right handle, enter left handle
            sx = src.x + NODE_W;
            tx = tgt.x;
        } else {
            // Source is right of target: exit left handle, enter right handle
            sx = src.x;
            tx = tgt.x + NODE_W;
        }
        sy = src.y + NODE_H / 2;
        ty = tgt.y + NODE_H / 2;
        
        return { sx, sy, tx, ty };
    };

    const getEdgePath = (edge: TopoEdge) => {
        const coords = getEdgeCoords(edge);
        if (!coords) return '';
        const { sx, sy, tx, ty } = coords;
        const mx = (sx + tx) / 2;
        return `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`;
    };

    // Midpoint calculations for Edge popovers and protocol labels
    const getEdgeMidpoint = (edge: TopoEdge) => {
        const coords = getEdgeCoords(edge);
        if (!coords) return { x: 0, y: 0 };
        return {
            x: (coords.sx + coords.tx) / 2,
            y: (coords.sy + coords.ty) / 2
        };
    };

    // ─── Drag Nodes ──────────────────────────────────────────
    const handleNodeMouseDown = (e: React.MouseEvent, nodeId: string) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        const node = resolvedNodes.find(n => n.id === nodeId);
        if (!node) return;
        const pos = screenToSvg(e.clientX, e.clientY);
        setDraggingId(nodeId);
        setDragOffset({ x: pos.x - node.x, y: pos.y - node.y });
        setSelectedNodeId(nodeId);
        setSelectedEdgeId(null);
        setEdgePopupPos(null);
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        if (isPanning) {
            setPan({
                x: e.clientX - panStart.x,
                y: e.clientY - panStart.y,
            });
            return;
        }

        if (connecting) {
            setMousePos(screenToSvg(e.clientX, e.clientY));
            return;
        }

        if (draggingId) {
            const pos = screenToSvg(e.clientX, e.clientY);
            const nx = Math.round((pos.x - dragOffset.x) / GRID) * GRID;
            const ny = Math.round((pos.y - dragOffset.y) / GRID) * GRID;
            setNodes(prev => prev.map(n => n.id === draggingId ? { ...n, x: nx, y: ny } : n));
        }
    };

    const handleMouseUp = () => {
        if (draggingId) {
            // Use functional updater to bypass state delay and persist coordinates cleanly
            setNodes(currentNodes => {
                persist(currentNodes, edges);
                return currentNodes;
            });
            setDraggingId(null);
        }
        if (isPanning) {
            setIsPanning(false);
        }
    };

    // ─── Panning & Canvas Clicks ──────────────────────────────
    const handleCanvasMouseDown = (e: React.MouseEvent) => {
        if (e.target === svgRef.current || (e.target as SVGElement).classList?.contains('topo-bg')) {
            setSelectedNodeId(null);
            setSelectedEdgeId(null);
            setEdgePopupPos(null);
            if (e.button === 0) {
                setIsPanning(true);
                setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
            }
        }
    };

    // ─── Connections ──────────────────────────────────────────
    const startConnect = (e: React.MouseEvent, nodeId: string) => {
        e.stopPropagation();
        setConnecting(nodeId);
        setSelectedEdgeId(null);
        setEdgePopupPos(null);
        setMousePos(screenToSvg(e.clientX, e.clientY));
    };

    const endConnect = (e: React.MouseEvent, nodeId: string) => {
        e.stopPropagation();
        if (connecting && connecting !== nodeId) {
            const exists = edges.some(
                ed => (ed.source === connecting && ed.target === nodeId) ||
                    (ed.source === nodeId && ed.target === connecting)
            );
            if (!exists) {
                const newEdgeId = generateId();
                const newEdge = { id: newEdgeId, source: connecting, target: nodeId };
                const newEdges = [...edges, newEdge];
                setEdges(newEdges);
                persist(nodes, newEdges);

                // Automatically select and open the configuration popover at the connection midpoint
                setSelectedEdgeId(newEdgeId);
                setSelectedNodeId(null);
                const mid = getEdgeMidpoint(newEdge);
                setEdgePopupPos(mid);
            }
        }
        setConnecting(null);
    };

    const handleSvgMouseUp = () => {
        setConnecting(null);
        handleMouseUp();
    };

    // ─── Add / Remove ──────────────────────────────────────────
    const placedSbomIds = new Set(nodes.map(n => n.sbomId));
    const availableItems = sbom.filter(item => !placedSbomIds.has(item.id));

    const addNode = (item: HardwareItem) => {
        const newNode: TopoNode = {
            id: generateId(),
            sbomId: item.id,
            x: 80 + Math.random() * 300,
            y: 80 + Math.random() * 200,
            label: item.hardware || 'Unknown Device',
            ip: item.ipAddress || '',
            type: item.type || 'Hardware',
            note: item.notes || '',
        };
        const next = [...nodes, newNode];
        setNodes(next);
        persist(next, edges);
    };

    // new device (SBOM row + map node) and edit of the selected one
    const [creating, setCreating] = useState(false);
    const [draft, setDraft] = useState({ name: '', type: 'Hardware', ip: '' });
    const createDevice = () => {
        if (!draft.name.trim()) return;
        const item = newSbomItem(draft.type as any, { hardware: draft.name.trim(), ipAddress: draft.ip.trim() });
        useStore.getState().updateAssemblySBOM([...sbom, item]);
        addNode(item);
        setDraft({ name: '', type: 'Hardware', ip: '' });
        setCreating(false);
    };
    const selItem = selectedNodeId ? sbom.find(i => i.id === nodes.find(n => n.id === selectedNodeId)?.sbomId) : undefined;
    const patchItem = (u: Partial<HardwareItem>) => {
        if (selItem) useStore.getState().updateAssemblySBOM(sbom.map(i => i.id === selItem.id ? { ...i, ...u } : i));
    };
    const fieldStyle: React.CSSProperties = { fontSize: 12, padding: '5px 7px', background: '#1e293b', border: '1px solid #475569', color: '#f8fafc', borderRadius: 4, minWidth: 0, width: '100%' };
    const btnStyle: React.CSSProperties = { flex: 1, fontSize: 11, fontWeight: 600, padding: '6px 8px', background: '#334155', border: 'none', color: '#f8fafc', borderRadius: 4, cursor: 'pointer' };
    const panelBox: React.CSSProperties = { background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(14,165,233,0.25)', borderRadius: 6, padding: 10 };

    const removeNode = (nodeId: string) => {
        const nextNodes = nodes.filter(n => n.id !== nodeId);
        const nextEdges = edges.filter(e => e.source !== nodeId && e.target !== nodeId);
        setNodes(nextNodes);
        setEdges(nextEdges);
        persist(nextNodes, nextEdges);
        setSelectedNodeId(null);
    };

    const removeEdge = (edgeId: string) => {
        const nextEdges = edges.filter(e => e.id !== edgeId);
        setEdges(nextEdges);
        persist(nodes, nextEdges);
    };
    const centerCanvas = () => {
        if (resolvedNodes.length === 0) {
            setPan({ x: 0, y: 0 });
            setZoom(1);
            return;
        }

        // Calculate bounding box of all nodes
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;

        resolvedNodes.forEach(node => {
            if (node.x < minX) minX = node.x;
            if (node.x + NODE_W > maxX) maxX = node.x + NODE_W;
            if (node.y < minY) minY = node.y;
            if (node.y + NODE_H > maxY) maxY = node.y + NODE_H;
        });

        const bboxW = maxX - minX;
        const bboxH = maxY - minY;

        // Get container dimensions
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) {
            setPan({ x: 100, y: 100 });
            setZoom(1);
            return;
        }

        const viewW = rect.width;
        const viewH = rect.height;

        // Determine zoom to fit, with padding
        const padding = 60;
        const scaleX = (viewW - padding * 2) / bboxW;
        const scaleY = (viewH - padding * 2) / bboxH;
        let newZoom = Math.min(scaleX, scaleY);
        // Constrain zoom
        newZoom = Math.max(0.4, Math.min(1.5, newZoom));

        // Center point of the bounding box
        const bboxCenterX = minX + bboxW / 2;
        const bboxCenterY = minY + bboxH / 2;

        // Calculate translation (pan) to center the bbox in the viewport
        const newPanX = viewW / 2 - bboxCenterX * newZoom;
        const newPanY = viewH / 2 - bboxCenterY * newZoom;

        setZoom(newZoom);
        setPan({ x: newPanX, y: newPanY });
    };

    const handleEdgeClick = (e: React.MouseEvent, edge: TopoEdge) => {
        e.stopPropagation();
        setSelectedEdgeId(edge.id);
        setSelectedNodeId(null);
        const mid = getEdgeMidpoint(edge);
        setEdgePopupPos(mid);
    };

    return (
        <div style={{ width: '100%', height: '100%', display: 'flex' }}>
            {/* Canvas */}
            <div
                ref={containerRef}
                style={{
                    flex: 1, position: 'relative', overflow: 'hidden',
                    background: '#060c16',
                    backgroundImage: 'radial-gradient(circle, rgba(14,165,233,0.06) 1px, transparent 1px)',
                    backgroundSize: '20px 20px',
                    cursor: isPanning ? 'grabbing' : draggingId ? 'grabbing' : 'default',
                }}
                onMouseDown={handleCanvasMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleSvgMouseUp}
                onMouseLeave={handleSvgMouseUp}
            >
                <svg
                    ref={svgRef}
                    width="100%"
                    height="100%"
                    style={{ position: 'absolute', top: 0, left: 0 }}
                >
                    {/* Glow filter */}
                    <defs>
                        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
                            <feGaussianBlur stdDeviation="4" result="blur" />
                            <feMerge>
                                <feMergeNode in="blur" />
                                <feMergeNode in="SourceGraphic" />
                            </feMerge>
                        </filter>
                        <filter id="edgeGlow" x="-50%" y="-50%" width="200%" height="200%">
                            <feGaussianBlur stdDeviation="2" result="blur" />
                            <feMerge>
                                <feMergeNode in="blur" />
                                <feMergeNode in="SourceGraphic" />
                            </feMerge>
                        </filter>
                    </defs>

                    <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
                        {/* Background click target */}
                        <rect className="topo-bg" x="-5000" y="-5000" width="10000" height="10000" fill="transparent" />

                        {/* Edges */}
                        {edges.map(edge => {
                            const isEdgeSelected = selectedEdgeId === edge.id;
                            const mid = getEdgeMidpoint(edge);
                            const coords = getEdgeCoords(edge);
                            if (!coords) return null;

                            const colors = getProtocolColors(edge.protocol, isEdgeSelected);

                            // Construct a highly detailed description of connection data to show directly on the network line
                            const displayParts = [];
                            const protoName = edge.protocol === 'Other' ? (edge.customProtocol || 'Custom') : edge.protocol;
                            displayParts.push(protoName || 'Not Configured');
                            
                            if (edge.protocol) {
                                const advice = getProtocolAdvice(edge.protocol);
                                if (advice.type === 'IP' || advice.type === 'Layer2_CBA') {
                                    const sPort = edge.sourcePort || advice.defaultPort;
                                    const tPort = edge.targetPort || advice.defaultPort;
                                    displayParts.push(`(${sPort} → ${tPort})`);
                                } else if (advice.type === 'Layer2') {
                                    displayParts.push('(L2 Raw)');
                                } else if (advice.type === 'Physical') {
                                    displayParts.push('(M12)');
                                }
                            }

                            if (edge.isEncrypted) displayParts.push('🔒');
                            if (edge.isFirewalled) displayParts.push('🛡️');
                            if (edge.iecSecurityLevel && edge.iecSecurityLevel !== 'None') {
                                const slMatch = edge.iecSecurityLevel.match(/SL\d/);
                                displayParts.push(slMatch ? `[${slMatch[0]}]` : `[${edge.iecSecurityLevel}]`);
                            }
                            const displayStr = displayParts.join(' ');

                            const pillW = Math.max(80, displayStr.length * 6.2 + 16);
                            const pillH = 18;
                            const px = mid.x - pillW / 2;
                            const py = mid.y - pillH / 2;

                            return (
                                <g key={edge.id}>
                                    {/* Glow layer */}
                                    <path
                                        d={getEdgePath(edge)}
                                        fill="none"
                                        stroke={colors.glow}
                                        strokeWidth={isEdgeSelected ? 8 : 6}
                                        filter="url(#edgeGlow)"
                                    />
                                    {/* Main edge */}
                                    <path
                                        d={getEdgePath(edge)}
                                        fill="none"
                                        stroke={colors.stroke}
                                        strokeWidth={isEdgeSelected ? 3 : 2}
                                        strokeDasharray={edge.protocol ? undefined : "6,4"}
                                        style={{ cursor: 'pointer' }}
                                        onClick={(e) => handleEdgeClick(e, edge)}
                                    >
                                        <animate
                                            attributeName="stroke-dashoffset"
                                            from="10"
                                            to="0"
                                            dur="1.5s"
                                            repeatCount="indefinite"
                                        />
                                    </path>

                                    {/* Thick clickable overlay to capture touch/clicks easily */}
                                    <path
                                        d={getEdgePath(edge)}
                                        fill="none"
                                        stroke="transparent"
                                        strokeWidth={20}
                                        style={{ cursor: 'pointer' }}
                                        onClick={(e) => handleEdgeClick(e, edge)}
                                    />

                                    {/* Protocol Badge at Midpoint - ONLY show if selected to keep UI clean */}
                                    {isEdgeSelected && (
                                        <g style={{ cursor: 'pointer' }} onClick={(e) => handleEdgeClick(e, edge)}>
                                            <rect
                                                x={px}
                                                y={py}
                                                width={pillW}
                                                height={pillH}
                                                rx={pillH / 2}
                                                ry={pillH / 2}
                                                fill="rgba(9, 14, 23, 0.95)"
                                                stroke={colors.stroke}
                                                strokeWidth={1}
                                                filter="url(#glow)"
                                            />
                                            <text
                                                x={mid.x}
                                                y={mid.y + 4}
                                                textAnchor="middle"
                                                fill={colors.text}
                                                fontSize="9"
                                                fontWeight="700"
                                                fontFamily="'Rajdhani', sans-serif"
                                            >
                                                {displayStr}
                                            </text>
                                        </g>
                                    )}
                                </g>
                            );
                        })}

                        {/* Connection line preview */}
                        {connecting && (() => {
                            const src = resolvedNodes.find(n => n.id === connecting);
                            if (!src) return null;
                            // Connect preview from nearest handle
                            const srcCx = src.x + NODE_W / 2;
                            const previewX = mousePos.x >= srcCx ? src.x + NODE_W : src.x;
                            return (
                                <line
                                    x1={previewX}
                                    y1={src.y + NODE_H / 2}
                                    x2={mousePos.x}
                                    y2={mousePos.y}
                                    stroke="rgba(14, 165, 233, 0.5)"
                                    strokeWidth={2}
                                    strokeDasharray="4,4"
                                />
                            );
                        })()}

                        {/* Nodes */}
                        {resolvedNodes.map(node => {
                            const color = typeColor[node.type] || '#0ea5e9';
                            const isSelected = selectedNodeId === node.id;
                            return (
                                <g key={node.id} transform={`translate(${node.x}, ${node.y})`}>
                                    {/* Glow behind selected node */}
                                    {isSelected && (
                                        <rect
                                            x={-4} y={-4}
                                            width={NODE_W + 8} height={NODE_H + 8}
                                            rx={10} ry={10}
                                            fill="none"
                                            stroke={color}
                                            strokeWidth={2}
                                            opacity={0.4}
                                            filter="url(#glow)"
                                        />
                                    )}

                                    {/* Node body */}
                                    <rect
                                        x={0} y={0}
                                        width={NODE_W} height={NODE_H}
                                        rx={8} ry={8}
                                        fill="rgba(15, 23, 42, 0.85)"
                                        stroke={isSelected ? color : 'rgba(14, 165, 233, 0.25)'}
                                        strokeWidth={isSelected ? 2 : 1}
                                        style={{ cursor: 'grab' }}
                                        onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
                                    />

                                    {/* Color accent bar */}
                                    <rect
                                        x={0} y={0}
                                        width={4} height={NODE_H}
                                        rx={2} ry={2}
                                        fill={color}
                                    />

                                    {/* Label */}
                                    <text
                                        x={14} y={26}
                                        fill="#e2e8f0"
                                        fontSize="14"
                                        fontWeight="600"
                                        fontFamily="'Rajdhani', sans-serif"
                                        style={{ pointerEvents: 'none' }}
                                    >
                                        {node.label.length > 18 ? node.label.slice(0, 18) + '…' : node.label}
                                    </text>

                                    {/* IP */}
                                    <text
                                        x={14} y={44}
                                        fill={color}
                                        fontSize="11"
                                        fontFamily="'JetBrains Mono', monospace"
                                        opacity={0.9}
                                        style={{ pointerEvents: 'none' }}
                                    >
                                        {node.ip || 'No IP'}
                                    </text>

                                    {/* Note */}
                                    <text
                                        x={14} y={60}
                                        fill="#cbd5e1"
                                        fontSize="10"
                                        fontFamily="'Rajdhani', sans-serif"
                                        opacity={0.8}
                                        style={{ pointerEvents: 'none' }}
                                    >
                                        {node.note ? (node.note.length > 22 ? node.note.slice(0, 22) + '…' : node.note) : ''}
                                    </text>

                                    {/* Type badge */}
                                    <text
                                        x={14} y={76}
                                        fill="#94a3b8"
                                        fontSize="9"
                                        fontFamily="'Rajdhani', sans-serif"
                                        style={{ pointerEvents: 'none', textTransform: 'uppercase' }}
                                    >
                                        {node.type}
                                    </text>

                                    {/* Connect handle (right) */}
                                    <circle
                                        cx={NODE_W} cy={NODE_H / 2}
                                        r={6}
                                        fill={connecting ? '#0ea5e9' : '#0f172a'}
                                        stroke="#0ea5e9"
                                        strokeWidth={2}
                                        style={{ cursor: 'crosshair' }}
                                        onMouseDown={(e) => startConnect(e, node.id)}
                                        onMouseUp={(e) => endConnect(e, node.id)}
                                    />

                                    {/* Connect handle (left) */}
                                    <circle
                                        cx={0} cy={NODE_H / 2}
                                        r={6}
                                        fill={connecting ? '#0ea5e9' : '#0f172a'}
                                        stroke="#0ea5e9"
                                        strokeWidth={2}
                                        style={{ cursor: 'crosshair' }}
                                        onMouseDown={(e) => startConnect(e, node.id)}
                                        onMouseUp={(e) => endConnect(e, node.id)}
                                    />

                                    {/* Delete button (only if selected) */}
                                    {isSelected && (
                                        <g
                                            transform={`translate(${NODE_W - 18}, 4)`}
                                            style={{ cursor: 'pointer' }}
                                            onClick={(e) => { e.stopPropagation(); removeNode(node.id); }}
                                        >
                                            <circle cx={8} cy={8} r={10} fill="rgba(239,68,68,0.2)" />
                                            <line x1={4} y1={4} x2={12} y2={12} stroke="#ef4444" strokeWidth={2} />
                                            <line x1={12} y1={4} x2={4} y2={12} stroke="#ef4444" strokeWidth={2} />
                                        </g>
                                    )}
                                </g>
                            );
                        })}
                    </g>
                </svg>

                {/* Industrial Connection Protocol Popover */}
                {edgePopupPos && selectedEdgeId && (() => {
                    const edge = edges.find(e => e.id === selectedEdgeId);
                    if (!edge) return null;

                    const advice = getProtocolAdvice(edge.protocol);
                    const isIpBased = advice.type === 'IP' || advice.type === 'Layer2_CBA';

                    return (
                        <div
                            style={{
                                position: 'absolute',
                                left: '50%',
                                top: '50%',
                                transform: 'translate(-50%, -50%)',
                                background: 'rgba(9, 14, 23, 0.95)',
                                backdropFilter: 'blur(12px)',
                                WebkitBackdropFilter: 'blur(12px)',
                                border: '1px solid rgba(14, 165, 233, 0.35)',
                                boxShadow: '0 0 30px rgba(45, 212, 191, 0.35)',
                                borderRadius: '8px',
                                padding: '16px',
                                zIndex: 1000,
                                width: '340px',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '10px',
                                color: '#e2e8f0',
                                fontFamily: "'Rajdhani', sans-serif",
                            }}
                            onClick={e => e.stopPropagation()}
                        >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div style={{ fontSize: '11px', fontWeight: 700, color: '#38bdf8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                    Configure Connection
                                </div>
                                <span className="badge" style={{ background: isIpBased ? 'rgba(34,197,94,0.1)' : 'rgba(245,158,11,0.1)', color: isIpBased ? '#22c55e' : '#f59e0b', fontSize: '9px', border: '1px solid currentColor', padding: '2px 6px', borderRadius: '4px' }}>
                                    {advice.type === 'IP' ? 'Standard TCP/IP' : advice.type === 'Layer2_CBA' ? 'PROFINET CBA/RT' : advice.type === 'Layer2' ? 'Raw Layer 2' : 'Physical Point-to-Point'}
                                </span>
                            </div>

                            {/* Protocol Select */}
                            <div>
                                <label style={{ fontSize: '10px', color: '#94a3b8', display: 'block', marginBottom: '4px', fontWeight: 600 }}>Protocol</label>
                                <select
                                    className="form-select"
                                    style={{ fontSize: '12px', padding: '6px 8px', width: '100%', background: '#1e293b', border: '1px solid #475569', color: '#f8fafc', borderRadius: '4px' }}
                                    value={edge.protocol || ''}
                                    onChange={e => {
                                        const proto = e.target.value;
                                        const adv = getProtocolAdvice(proto);
                                        updateEdge(selectedEdgeId, {
                                            protocol: proto,
                                            customProtocol: '',
                                            sourcePort: adv.defaultPort !== "N/A" ? adv.defaultPort : "",
                                            targetPort: adv.defaultPort !== "N/A" ? adv.defaultPort : "",
                                            subnetMask: adv.defaultPort !== "N/A" ? "255.255.255.0" : "",
                                            gateway: adv.defaultPort !== "N/A" ? "192.168.1.1" : "",
                                        });
                                    }}
                                >
                                    <option value="">-- Select Protocol --</option>
                                    <option value="OPC UA">OPC UA (SCADA / M2M)</option>
                                    <option value="PROFINET">PROFINET (RT / IRT)</option>
                                    <option value="EtherNet/IP">EtherNet/IP (ODVA / CIP)</option>
                                    <option value="EtherCAT">EtherCAT (High-Speed Motion)</option>
                                    <option value="Modbus TCP">Modbus TCP</option>
                                    <option value="IO-Link">IO-Link (Sensors / Actuators)</option>
                                    <option value="Other">Other / Custom...</option>
                                </select>
                            </div>

                            {edge.protocol === 'Other' && (
                                <div>
                                    <input
                                        className="form-input"
                                        style={{ fontSize: '12px', padding: '6px 8px', width: '100%', background: '#1e293b', border: '1px solid #475569', color: '#f8fafc', borderRadius: '4px' }}
                                        placeholder="Specify custom protocol..."
                                        value={edge.customProtocol || ''}
                                        onChange={e => updateEdge(selectedEdgeId, { customProtocol: e.target.value })}
                                        autoFocus
                                    />
                                </div>
                            )}

                            {/* Dynamic Advice Box */}
                            <div style={{
                                padding: '8px 10px',
                                background: 'rgba(15, 23, 42, 0.6)',
                                border: '1px dashed rgba(14, 165, 233, 0.3)',
                                borderRadius: '4px',
                                fontSize: '10.5px',
                                lineHeight: '1.4',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '4px'
                            }}>
                                <span style={{ color: '#cbd5e1' }}>{advice.desc}</span>
                                {advice.securityAdvice && (
                                    <span style={{ color: '#f97316', fontWeight: 600, fontSize: '10px', display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }}>
                                        ⚠️ {advice.securityAdvice}
                                    </span>
                                )}
                            </div>

                            {/* Network Parameters Grid */}
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                                <div>
                                    <label style={{ fontSize: '10px', color: '#94a3b8', display: 'block', marginBottom: '2px' }}>Source Port</label>
                                    <input
                                        type="text"
                                        style={{
                                            fontSize: '11px', padding: '4px 6px', width: '100%',
                                            background: isIpBased ? '#1e293b' : 'rgba(30, 41, 59, 0.4)',
                                            border: '1px solid #475569',
                                            color: isIpBased ? '#f8fafc' : '#64748b',
                                            borderRadius: '4px',
                                            fontFamily: "'JetBrains Mono', monospace"
                                        }}
                                        disabled={!isIpBased}
                                        placeholder={isIpBased ? "Port" : "N/D (Layer 2)"}
                                        value={edge.sourcePort || ''}
                                        onChange={e => updateEdge(selectedEdgeId, { sourcePort: e.target.value })}
                                    />
                                </div>
                                <div>
                                    <label style={{ fontSize: '10px', color: '#94a3b8', display: 'block', marginBottom: '2px' }}>Destination Port</label>
                                    <input
                                        type="text"
                                        style={{
                                            fontSize: '11px', padding: '4px 6px', width: '100%',
                                            background: isIpBased ? '#1e293b' : 'rgba(30, 41, 59, 0.4)',
                                            border: '1px solid #475569',
                                            color: isIpBased ? '#f8fafc' : '#64748b',
                                            borderRadius: '4px',
                                            fontFamily: "'JetBrains Mono', monospace"
                                        }}
                                        disabled={!isIpBased}
                                        placeholder={isIpBased ? "Port" : "N/D (Layer 2)"}
                                        value={edge.targetPort || ''}
                                        onChange={e => updateEdge(selectedEdgeId, { targetPort: e.target.value })}
                                    />
                                </div>
                                <div>
                                    <label style={{ fontSize: '10px', color: '#94a3b8', display: 'block', marginBottom: '2px' }}>Subnet Mask</label>
                                    <input
                                        type="text"
                                        style={{
                                            fontSize: '11px', padding: '4px 6px', width: '100%',
                                            background: isIpBased ? '#1e293b' : 'rgba(30, 41, 59, 0.4)',
                                            border: '1px solid #475569',
                                            color: isIpBased ? '#f8fafc' : '#64748b',
                                            borderRadius: '4px',
                                            fontFamily: "'JetBrains Mono', monospace"
                                        }}
                                        disabled={!isIpBased}
                                        placeholder={isIpBased ? "255.255.255.0" : "N/D (Layer 2)"}
                                        value={edge.subnetMask || ''}
                                        onChange={e => updateEdge(selectedEdgeId, { subnetMask: e.target.value })}
                                    />
                                </div>
                                <div>
                                    <label style={{ fontSize: '10px', color: '#94a3b8', display: 'block', marginBottom: '2px' }}>Gateway</label>
                                    <input
                                        type="text"
                                        style={{
                                            fontSize: '11px', padding: '4px 6px', width: '100%',
                                            background: isIpBased ? '#1e293b' : 'rgba(30, 41, 59, 0.4)',
                                            border: '1px solid #475569',
                                            color: isIpBased ? '#f8fafc' : '#64748b',
                                            borderRadius: '4px',
                                            fontFamily: "'JetBrains Mono', monospace"
                                        }}
                                        disabled={!isIpBased}
                                        placeholder={isIpBased ? "192.168.1.1" : "N/D (Layer 2)"}
                                        value={edge.gateway || ''}
                                        onChange={e => updateEdge(selectedEdgeId, { gateway: e.target.value })}
                                    />
                                </div>
                            </div>

                            {/* IEC 62443 Security controls */}
                            <div style={{
                                borderTop: '1px solid rgba(148, 163, 184, 0.15)',
                                paddingTop: '8px',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '6px'
                            }}>
                                <span style={{ fontSize: '10px', fontWeight: 700, color: '#f43f5e', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: '2px' }}>
                                    Security Conduit (IEC 62443)
                                </span>

                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                    <span style={{ fontSize: '11px', color: '#cbd5e1' }}>Enable Channel Encryption</span>
                                    <input
                                        type="checkbox"
                                        checked={!!edge.isEncrypted}
                                        onChange={e => updateEdge(selectedEdgeId, { isEncrypted: e.target.checked })}
                                        style={{ cursor: 'pointer' }}
                                    />
                                </div>

                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                    <span style={{ fontSize: '11px', color: '#cbd5e1' }}>Firewall Isolation</span>
                                    <input
                                        type="checkbox"
                                        checked={!!edge.isFirewalled}
                                        onChange={e => updateEdge(selectedEdgeId, { isFirewalled: e.target.checked })}
                                        style={{ cursor: 'pointer' }}
                                    />
                                </div>

                                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '2px' }}>
                                    <label style={{ fontSize: '10px', color: '#cbd5e1' }}>Target Security Level (SL-T)</label>
                                    <select
                                        style={{ fontSize: '11px', padding: '4px', width: '100%', background: '#1e293b', border: '1px solid #475569', color: '#f8fafc', borderRadius: '4px' }}
                                        value={edge.iecSecurityLevel || 'None'}
                                        onChange={e => updateEdge(selectedEdgeId, { iecSecurityLevel: e.target.value })}
                                    >
                                        <option value="None">None (No measures)</option>
                                        <option value="SL1: Basic Protection">SL1: Protezione da abusi casuali</option>
                                        <option value="SL2: Protezione Media">SL2: Simple attacks (protected Modbus)</option>
                                        <option value="SL3: Protezione Avanzata">SL3: Attacchi sofisticati (Consigliato PLC)</option>
                                        <option value="SL4: Protezione Massima">SL4: Attacchi statali o mirati</option>
                                    </select>
                                </div>
                            </div>

                            {/* Action Buttons */}
                            <div style={{ display: 'flex', gap: '8px', marginTop: '6px', borderTop: '1px solid rgba(148, 163, 184, 0.15)', paddingTop: '10px' }}>
                                <button
                                    className="btn btn-secondary btn-sm"
                                    style={{ flex: 1, padding: '6px 8px', fontSize: '11px', background: '#334155', border: 'none', color: '#f8fafc', borderRadius: '4px', cursor: 'pointer', fontWeight: 600 }}
                                    onClick={() => {
                                        setSelectedEdgeId(null);
                                        setEdgePopupPos(null);
                                    }}
                                >
                                    Close
                                </button>
                                <button
                                    className="btn btn-danger btn-sm"
                                    style={{ flex: 1, padding: '6px 8px', fontSize: '11px', background: '#ef4444', border: 'none', color: '#ffffff', borderRadius: '4px', cursor: 'pointer', fontWeight: 600 }}
                                    onClick={() => {
                                        removeEdge(selectedEdgeId);
                                        setSelectedEdgeId(null);
                                        setEdgePopupPos(null);
                                    }}
                                >
                                    Remove
                                </button>
                            </div>
                        </div>
                    );
                })()}

                {/* Viewport controls — same as the Albero diagram */}
                <div className="diagram-toolbar">
                    <button className="btn-icon" title="Zoom in" onClick={() => zoomCenter(1.25)}><ZoomIn size={15} /></button>
                    <button className="btn-icon" title="Zoom indietro" onClick={() => zoomCenter(1 / 1.25)}><ZoomOut size={15} /></button>
                    <button className="btn-icon" title="Adatta e centra" onClick={centerCanvas}><Maximize2 size={15} /></button>
                    <span className="diagram-zoom-label">{Math.round(zoom * 100)}%</span>
                </div>
            </div>

            {/* Right palette panel */}
            <div style={{
                width: 240, borderLeft: '1px solid rgba(14,165,233,0.15)',
                background: 'rgba(9,14,23,0.95)',
                display: 'flex', flexDirection: 'column', flexShrink: 0,
            }}>
                <div style={{
                    padding: '12px 16px', borderBottom: '1px solid rgba(14,165,233,0.1)',
                    display: 'flex', alignItems: 'center', gap: 8,
                }}>
                    <HardDrive size={14} style={{ color: '#0ea5e9' }} />
                    <span style={{ fontWeight: 600, fontSize: '12px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        SBOM Devices
                    </span>
                </div>

                <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {/* New device: creates the SBOM row and puts it on the map in one step */}
                    {creating ? (
                        <div style={{ ...panelBox, display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <input autoFocus style={fieldStyle} placeholder="Name / model (e.g. Siemens G120 drive)" value={draft.name}
                                onChange={e => setDraft({ ...draft, name: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') createDevice(); }} />
                            <div style={{ display: 'flex', gap: 6 }}>
                                <select style={{ ...fieldStyle, flex: 1 }} value={draft.type} onChange={e => setDraft({ ...draft, type: e.target.value })}>
                                    {['Hardware', 'Software', 'Network', 'Service', 'Security'].map(t => <option key={t} value={t}>{t}</option>)}
                                </select>
                                <input style={{ ...fieldStyle, flex: 1 }} placeholder="IP" value={draft.ip} onChange={e => setDraft({ ...draft, ip: e.target.value })} />
                            </div>
                            <div style={{ display: 'flex', gap: 6 }}>
                                <button style={{ ...btnStyle, background: '#0ea5e9', color: '#0b1220' }} disabled={!draft.name.trim()} onClick={createDevice}>Add to map and SBOM</button>
                                <button style={btnStyle} onClick={() => setCreating(false)}>Cancel</button>
                            </div>
                        </div>
                    ) : (
                        <button style={{ ...btnStyle, flex: '0 0 auto', background: '#0ea5e9', color: '#0b1220' }} onClick={() => setCreating(true)}>+ New hardware / software</button>
                    )}

                    {/* The selected device: edit it here, the SBOM follows */}
                    {selItem && (
                        <div style={{ ...panelBox, display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: '#38bdf8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Selected device</div>
                            <input key={`n-${selItem.id}`} style={fieldStyle} defaultValue={selItem.hardware} placeholder="Name / model"
                                onBlur={e => selItem.sourcePartId
                                    ? useStore.getState().overrideSbomRow(selItem.id, { ...(selItem.overrides || {}), hardware: e.target.value })
                                    : patchItem({ hardware: e.target.value })} />
                            <div style={{ display: 'flex', gap: 6 }}>
                                <input key={`i-${selItem.id}`} style={{ ...fieldStyle, flex: 1 }} defaultValue={selItem.ipAddress || ''} placeholder="IP" onBlur={e => patchItem({ ipAddress: e.target.value })} />
                                <input key={`f-${selItem.id}`} style={{ ...fieldStyle, flex: 1 }} defaultValue={selItem.firmware || ''} placeholder="Version / FW" onBlur={e => patchItem({ firmware: e.target.value })} />
                            </div>
                            <input key={`t-${selItem.id}`} style={fieldStyle} defaultValue={selItem.notes || ''} placeholder="Notes" onBlur={e => patchItem({ notes: e.target.value })} />
                            <div style={{ fontSize: 9, color: '#64748b' }}>Remove it from the map with the red ✕ on the device; its SBOM row stays.</div>
                        </div>
                    )}

                    {availableItems.length === 0 ? (
                        <div style={{ fontSize: '12px', color: '#475569', textAlign: 'center', padding: '24px 8px' }}>
                            {sbom.length === 0
                                ? 'No devices yet: create one above or add rows in the SBOM.'
                                : 'All devices are already on the map.'
                            }
                        </div>
                    ) : (
                        availableItems.map(item => {
                            const color = typeColor[item.type || 'Hardware'] || '#0ea5e9';
                            return (
                                <button
                                    key={item.id}
                                    onClick={() => addNode(item)}
                                    style={{
                                        textAlign: 'left', background: 'rgba(15,23,42,0.6)',
                                        border: '1px solid rgba(14,165,233,0.15)', padding: '10px 12px',
                                        borderRadius: 6, cursor: 'pointer', color: '#e2e8f0',
                                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                        transition: 'all 0.15s ease',
                                    }}
                                    onMouseOver={(e) => {
                                        (e.currentTarget as HTMLElement).style.borderColor = color;
                                        (e.currentTarget as HTMLElement).style.boxShadow = `0 0 8px ${color}33`;
                                    }}
                                    onMouseOut={(e) => {
                                        (e.currentTarget as HTMLElement).style.borderColor = 'rgba(14,165,233,0.15)';
                                        (e.currentTarget as HTMLElement).style.boxShadow = 'none';
                                    }}
                                >
                                    <div>
                                        <div style={{ fontSize: '12px', fontWeight: 600 }}>{item.hardware || 'Unknown'}</div>
                                        <div style={{ fontSize: '10px', color: color, marginTop: 2 }}>{item.ipAddress || 'No IP'}</div>
                                        <div style={{ fontSize: '9px', color: '#475569', marginTop: 1 }}>{item.type || 'Hardware'}</div>
                                    </div>
                                    <div style={{
                                        fontSize: '16px', width: 24, height: 24,
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        background: `${color}22`, borderRadius: 4, color,
                                    }}>
                                        +
                                    </div>
                                </button>
                            );
                        })
                    )}
                </div>

                {/* Legend */}
                <div style={{
                    padding: '12px 16px', borderTop: '1px solid rgba(14,165,233,0.1)',
                    fontSize: '10px', color: '#475569',
                }}>
                    <div style={{ marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Legend</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {Object.entries(typeColor).map(([type, color]) => (
                            <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <div style={{ width: 10, height: 10, borderRadius: 2, background: color }} />
                                <span>{type}</span>
                            </div>
                        ))}
                    </div>
                    <div style={{ marginTop: 8, lineHeight: 1.5, color: '#334155' }}>
                        • Drag nodes to position them<br />
                        • Use the side circles to connect<br />
                        • Click an edge to configure or remove it
                    </div>
                </div>
            </div>
        </div>
    );
};
