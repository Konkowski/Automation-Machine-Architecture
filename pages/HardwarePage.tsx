// ============================================================
// AMA — Hardware of the code base (step 3 of the Code base workflow)
// The reference SBOM and network topology a machine starts from.
// Imported from TIA Portal / Studio 5000 or built by hand; saved with
// the code base (hardware.json).
// ============================================================
import React, { useState } from 'react';
import { HardDrive, Network } from 'lucide-react';
import { useStore } from '../lib/store';
import { SbomEditor } from '../components/SbomEditor';
import { NetworkTopology } from '../components/NetworkTopology';

export const HardwarePage: React.FC = () => {
    const sbom = useStore(s => s.assembly.sbom) || [];
    const [view, setView] = useState<'sbom' | 'topology'>('sbom');
    return (
        <div className="asm-page">
            <div className="asm-header">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                        <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>Hardware and software of the code base</h2>
                        <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                            {sbom.length} item(s). A machine starts from this list and can change it for a customer.
                        </p>
                    </div>
                    <div className="level-segmented" style={{ padding: 0 }}>
                        <button className={`segment ${view === 'sbom' ? 'active' : ''}`} onClick={() => setView('sbom')}><HardDrive size={14} /> <span>SBOM</span></button>
                        <button className={`segment ${view === 'topology' ? 'active' : ''}`} onClick={() => setView('topology')}><Network size={14} /> <span>Topology</span></button>
                    </div>
                </div>
            </div>
            {view === 'sbom'
                ? <SbomEditor machine={false} />
                : <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}><NetworkTopology sbom={sbom} /></div>}
        </div>
    );
};
