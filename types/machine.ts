// ============================================================
// AMA — Core Type Definitions (ISA-88 Physical Model)
// ============================================================

// --- Enums ---
export type DataType = 'BOOL' | 'INT' | 'DINT' | 'REAL' | 'LREAL' | 'STRING' | 'TIME' | 'WORD' | 'DWORD' | 'System' | 'UINT' | 'ARRAY OF' | 'Union OF' | 'Other';
export type VariableScope = 'Input' | 'Output' | 'InOut' | 'Local';
export type AlarmLevel = 'Warning' | 'Alarm' | 'Fault' | 'Safety';
export type AlarmAction = 'Stop' | 'AutoReset' | 'EmergencyStop' | 'Log';
export type SignalType = 'DI' | 'DO' | 'AI' | 'AO' | 'Frequency';
export type DFMEAStatus = 'To Do' | 'In Progress' | 'Implemented' | 'Verified';
export type EntityLevel = 'UN' | 'EM' | 'CM' | 'FB';
// Library lifecycle (governance): Released blocks are locked from edits.
export type EntityStatus = 'Draft' | 'In Review' | 'Released' | 'Deprecated';
export type FBCategory = 'Motion' | 'Valve' | 'Sensor' | 'Communication' | 'Safety' | 'Logic' | 'HMI' | 'Other';

export type BomItemType = 'Hardware' | 'Software' | 'Network' | 'Service' | 'Security';

export interface HardwareItem {
  id: string;
  type: BomItemType;
  hardware: string; // Used for name/model/software name
  firmware: string; // Used for version
  quantity: number;
  notes: string;
  ipAddress?: string;
  macAddress?: string;
  config?: string;
  securityZone?: string; // IEC 62443 Security Zone
  vlanId?: string;       // VLAN Identification
  // — fields synced from the Architecture entity BOMs —
  internalCode?: string;   // codice interno aziendale
  supplierCode?: string;   // codice fornitore / part number
  manufacturer?: string;
  unit?: string;
  sourcePartId?: string;   // BomPart id: row is derived from Architecture
  sourceEntity?: string;   // which assembled entities require it (display)
  /** Imported from TIA Portal: the station exactly as it was (type identifiers, modules, addresses, IP). */
  tia?: any;
  /** Machine-specific changes to a row derived from the code base (customer requests). */
  overrides?: HardwareOverrides;
}

export interface HardwareOverrides {
  quantity?: number;
  hardware?: string;
  supplierCode?: string;
  internalCode?: string;
  manufacturer?: string;
}

/** A code base part the customer does not want on this machine. */
export interface RemovedPart { partId: string; label: string }

// --- BOM (per-entity parts for procurement) ---
export interface BomPart {
    id: string;
    internalCode?: string;  // codice interno aziendale
    code: string;           // codice fornitore / part number
    description: string;
    manufacturer: string;   // costruttore / fornitore
    type?: BomItemType;     // Hardware | Software | Network | Service | Security
    quantity: number;       // per ONE instance of the entity
    unit?: string;          // pz, m, kg…
    notes?: string;
    /** Ranked alternatives (first = preferred fallback) the assembler may pick instead. */
    alternatives?: BomAlternative[];
}

export interface BomAlternative {
    id: string;
    code: string;           // supplier part number
    manufacturer: string;
    description: string;
    notes?: string;         // why / when to prefer it
}

// --- Sub-types ---
export interface Variable {
  id: string;
  name: string;
  description: string;
  dataType: DataType;
  customDataType?: string;
  scope: VariableScope;
  address?: string;
}

export interface Alarm {
  id: string;
  alarmId: string;
  message: string;
  level: AlarmLevel;
  triggerVariable: string;
  action: AlarmAction;
  linkedModules: string[];
  possibleCauses?: string;
  possibleSolutions?: string;
}

export interface IOSignal {
  id: string;
  signalId: string;
  signalType: SignalType;
  address: string;
  variable: string;
  description: string;
  dataType: DataType;
  customDataType?: string;
}

export interface DFMEAEntry {
  id: string;
  failureMode: string;
  effect: string;
  cause: string;
  severity: number;
  occurrence: number;
  detection: number;
  rpn: number;
  controls: string;
  actions: string;
  status: DFMEAStatus;
  /** BomPart (component) of the same block this failure is about. */
  componentId?: string;
  /** Alarm of the same block that detects / reports this failure. */
  alarmId?: string;
}

export interface Revision {
  version: string;
  date: string;
  author: string;
  notes: string;
}

export interface ChecklistPoint {
  id: string;
  punto: string;
  quando: string;
  reparto: string;
  group: string;
}

export interface DevTimes {
  plcHours: number;
  hmiHours: number;
  commissioningHours: number;
}

/**
 * Update payload accepted by entity mutations: base fields plus the
 * level-specific assignment lists (present only on UN/EM/CM).
 */
export type EntityPatch = Partial<BlockBase> & Partial<{
  assignedFBs: string[];
  assignedEMs: string[];
  assignedCMs: string[];
  checklist: ChecklistPoint[];
  devTimes: DevTimes;
}>;

// --- Imported from TIA Portal: the original objects travel with the block ---
/** One TIA object (OB / FC / FB / DB or PLC data type) exactly as TIA exported it (SimaticML). */
export interface TiaObject {
  kind: 'block' | 'type' | 'technology';   // technology = technology object (counter, axis...)
  blockKind?: string;      // OB | FC | FB | GlobalDB | InstanceDB | ArrayDB
  name: string;
  folders: string[];       // program folder path in TIA
  system?: boolean;        // lived in "System blocks" (instance DB of a timer, counter or instruction)
  xml: string;
}
/** A PLC tag exactly as it was in TIA (the type is not reduced to the AMA data types). */
export interface TiaTag { name: string; type: string; address: string; comment: string; table: string }
export interface TiaOrigin { plc: string; version: string; objects: TiaObject[]; tags: TiaTag[] }

// --- Core Entity (shared base for UN, EM, CM, FB) ---
export interface BlockBase {
  id: string;
  name: string;
  description: string;
  category: FBCategory;
  level: EntityLevel;
  variables: Variable[];
  alarms: Alarm[];
  io: IOSignal[];
  dfmea: DFMEAEntry[];
  revisions: Revision[];
  code: string;
  currentVersion: string;
  lastModifiedBy: string;
  status?: EntityStatus;  // library lifecycle (default Draft)
  /** Release checks the Product Owner accepted (with the reason): the block was released anyway. */
  waivers?: { text: string; reason: string; by: string; date: string }[];
  /** Machine projects: 'codebase' = taken from the code base, 'machine' = exists only on this machine. */
  origin?: 'codebase' | 'machine';
  /** Machine projects: fingerprint of the block as it came from the code base (see lib/deviation.ts). */
  baseline?: string;
  hardware?: string;
  bom?: BomPart[];        // hardware parts of one instance (UN/EM/CM)
  /** Imported from TIA Portal: its original objects and tags, re-imported as they are on export. */
  tia?: TiaOrigin;
}

// --- Architecture Database Entities (flat, independent) ---
export interface FunctionBlock extends BlockBase {
  level: 'FB';
}

export interface ControlModule extends BlockBase {
  level: 'CM';
  assignedFBs: string[];  // FB IDs
  checklist: ChecklistPoint[];
  devTimes: DevTimes;
}

export interface EquipmentModule extends BlockBase {
  level: 'EM';
  assignedFBs: string[];
  assignedCMs: string[];
  checklist: ChecklistPoint[];
  devTimes: DevTimes;
}

export interface Unit extends BlockBase {
  level: 'UN';
  assignedFBs: string[];
  assignedEMs: string[];
  checklist: ChecklistPoint[];
  devTimes: DevTimes;
}

// --- Code base (the reusable library, kept in its own Git repository) ---
export type WorkspaceKind = 'machine' | 'codebase';

export interface CodebaseInfo {
  name: string;
  version: string;
  description: string;
  /** Folder of the code base repository (where it is opened from / saved to). */
  path: string;
  /** Machine projects: when the library snapshot was last taken from the code base. */
  syncedAt?: string;
  /** Machine projects: Git commit of the code base when the snapshot was taken (if known). */
  commit?: string;
  /** Machine projects: the code base folder had uncommitted changes when linked. */
  dirty?: boolean;
}

// --- Assembly Project (reference tree) ---
export interface AssemblyNode {
  id: string;         // unique instance ID within assembly
  refId: string;      // ID of the Architecture entity
  level: EntityLevel;
  children: AssemblyNode[];
  /** Instance name, e.g. "Capping head 3". Defaults to the block name. */
  label?: string;
  /** Per-instance parameters (setpoints, addresses, options). */
  params?: InstanceParam[];
  /** BomPart id -> alternative id chosen for this instance. */
  componentChoice?: Record<string, string>;
}

export interface InstanceParam { id: string; name: string; value: string; unit?: string }

export interface AssemblyProject {
  id: string;
  name: string;
  secondaryDescription?: string;
  description: string;
  version: string;
  tree: AssemblyNode[];  // top-level UNs with nested EMs/CMs
  sbom: HardwareItem[];
  /** Derived parts taken off this machine on purpose (they do not come back on re-sync). */
  sbomRemoved?: RemovedPart[];
  networkNodes?: any[];
  networkEdges?: any[];
}

// --- Tree Node (for sidebar rendering) ---
export interface TreeNode {
  id: string;
  name: string;
  level: EntityLevel;
  children?: TreeNode[];
}
