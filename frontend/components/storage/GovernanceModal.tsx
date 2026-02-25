
import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
    Search, X, ChevronDown, Plus, Shield, AlertTriangle,
    CheckSquare, Square, Server, Cloud, Database,
    Image as ImageIcon, Film, Mic, FileText as DocsIcon, BarChart3,
    Archive, Terminal, Code2, Settings2, Activity,
    MessageCircle, Type, Boxes, HardDrive, Globe, Box
} from 'lucide-react';

// ============================================================
// GovernanceModal — Storage Ingestion Policy Engine
// ============================================================
// Extracted from StorageExplorer.tsx for maintainability.
// NOTE: This modal works in tandem with the Column Format Validation
// system (DatabaseExplorer "Edit Format" modal + TableCreatorDrawer
// format presets). Both systems share the governance metadata stored
// in project.metadata.storage_governance.
// ============================================================

// Physical Limit Hardcoded in Nginx/Node
const PHYSICAL_LIMIT_BYTES = 100 * 1024 * 1024; // 100MB

// Sector-specific icons for intuitive visual identification
const SECTOR_ICONS: Record<string, React.FC<any>> = {
    visual: ImageIcon,
    motion: Film,
    audio: Mic,
    docs: DocsIcon,
    structured: BarChart3,
    archives: Archive,
    exec: Terminal,
    scripts: Code2,
    config: Settings2,
    telemetry: Activity,
    messaging: MessageCircle,
    ui_assets: Type,
    simulation: Boxes,
    backup_sys: HardDrive,
    global: Globe,
};

const STORAGE_PROVIDERS = [
    { id: 'local', name: 'Local Storage', icon: Server, desc: 'Armazenamento em disco no servidor.' },
    { id: 's3', name: 'S3 Compatible', icon: Database, desc: 'AWS S3, R2, Wasabi, MinIO, DigitalOcean.' },
    { id: 'cloudinary', name: 'Cloudinary', icon: Cloud, desc: 'Otimização de mídia e CDN global.' },
    { id: 'imagekit', name: 'ImageKit', icon: ImageIcon, desc: 'CDN de imagem em tempo real.' },
    { id: 'gdrive', name: 'Google Drive', icon: HardDrive, desc: 'Integração via Google Workspace API.' },
    { id: 'onedrive', name: 'OneDrive', icon: Cloud, desc: 'Microsoft Graph API Storage.' },
    { id: 'dropbox', name: 'Dropbox', icon: Box, desc: 'Armazenamento de arquivos simples.' }
];

interface SectorDefinition {
    id: string;
    label: string;
    desc: string;
    exts: string[];
    defaults: string[];
}

interface GovernanceModalProps {
    isOpen: boolean;
    onClose: () => void;
    governance: any;
    setGovernance: (g: any) => void;
    sectorDefinitions: SectorDefinition[];
    projectId: string;
    fetchWithAuth: (url: string, options?: any) => Promise<any>;
    onSuccess: (msg: string) => void;
    onError: (msg: string) => void;
}

// --- Helpers ---
const parseSizeValue = (str: string) => {
    const match = str?.match(/^(\d+(?:\.\d+)?)/);
    return match ? match[1] : '';
};

const parseSizeUnit = (str: string) => {
    const match = str?.match(/([a-zA-Z]+)$/);
    return match ? match[1] : 'MB';
};

const checkPhysicalLimit = (valStr: string) => {
    const val = parseFloat(parseSizeValue(valStr) || '0');
    const unit = parseSizeUnit(valStr);
    const multipliers: any = { 'B': 1, 'KB': 1024, 'MB': 1024 * 1024, 'GB': 1024 * 1024 * 1024 };
    const bytes = val * (multipliers[unit.toUpperCase()] || 1);
    return bytes > PHYSICAL_LIMIT_BYTES;
};

const GovernanceModal: React.FC<GovernanceModalProps> = ({
    isOpen,
    onClose,
    governance,
    setGovernance,
    sectorDefinitions,
    projectId,
    fetchWithAuth,
    onSuccess,
    onError,
}) => {
    const [expandedSector, setExpandedSector] = useState<string | null>(null);
    const [governanceSearch, setGovernanceSearch] = useState('');
    const [newCustomExt, setNewCustomExt] = useState('');
    const scrollContainerRef = useRef<HTMLDivElement>(null);

    // --- Drag-scroll support ---
    const isDragging = useRef(false);
    const startY = useRef(0);
    const startScrollTop = useRef(0);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        const container = scrollContainerRef.current;
        if (!container) return;
        // Only activate drag-scroll on the container itself, not on interactive elements
        const target = e.target as HTMLElement;
        if (target.closest('button, input, select, [data-no-drag]')) return;
        isDragging.current = true;
        startY.current = e.clientY;
        startScrollTop.current = container.scrollTop;
        container.style.cursor = 'grabbing';
        container.style.userSelect = 'none';
    }, []);

    useEffect(() => {
        const container = scrollContainerRef.current;
        if (!container) return;

        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging.current) return;
            const delta = startY.current - e.clientY;
            container.scrollTop = startScrollTop.current + delta;
        };

        const handleMouseUp = () => {
            isDragging.current = false;
            container.style.cursor = 'grab';
            container.style.userSelect = '';
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, []);

    // --- Governance Helpers ---
    const updateSectorSize = (sectorId: string, val: string, unit: string, isDirect: boolean = false) => {
        const combined = `${val}${unit}`;
        const key = isDirect ? 'max_size_direct' : 'max_size';
        setGovernance({ ...governance, [sectorId]: { ...governance[sectorId], [key]: combined } });
    };

    const addCustomExtension = (sectorId: string) => {
        if (!newCustomExt) return;
        const cleanExt = newCustomExt.replace(/^\./, '').toLowerCase();
        const current = governance[sectorId]?.allowed_exts || [];
        if (!current.includes(cleanExt)) {
            const next = [...current, cleanExt];
            setGovernance({ ...governance, [sectorId]: { ...governance[sectorId], allowed_exts: next } });
        }
        setNewCustomExt('');
    };

    const handleSave = async () => {
        try {
            await fetchWithAuth(`/api/control/projects/${projectId}`, {
                method: 'PATCH',
                body: JSON.stringify({ metadata: { storage_governance: governance } })
            });
            onSuccess("Políticas de governança sincronizadas.");
            onClose();
        } catch (e: any) {
            onError("Erro ao salvar governança.");
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-xl z-[400] flex items-center justify-center p-8 animate-in fade-in duration-300">
            <div className="bg-white rounded-[4rem] w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl border border-slate-100 animate-in zoom-in-95">
                <header className="p-12 pb-6 border-b border-slate-100 bg-slate-50/50">
                    <div className="flex items-center justify-between mb-8">
                        <div className="flex items-center gap-6">
                            <div className="w-16 h-16 bg-slate-900 text-white rounded-[1.8rem] flex items-center justify-center shadow-xl"><Shield size={32} /></div>
                            <div><h3 className="text-4xl font-black text-slate-900 tracking-tighter">Governance Engine</h3><p className="text-[10px] text-indigo-600 font-bold uppercase tracking-widest">Advanced Ingestion Policy</p></div>
                        </div>
                        <button onClick={onClose} className="p-4 hover:bg-slate-200 rounded-full transition-all text-slate-400"><X size={32} /></button>
                    </div>

                    {/* GLOBAL SEARCH */}
                    <div className="relative mb-2">
                        <Search size={18} className="absolute left-6 top-1/2 -translate-y-1/2 text-slate-400" />
                        <input
                            value={governanceSearch}
                            onChange={(e) => setGovernanceSearch(e.target.value)}
                            placeholder="Search format globally (e.g. .png, json)..."
                            className="w-full pl-14 pr-6 py-5 bg-white border border-slate-200 rounded-3xl text-sm font-bold outline-none focus:ring-4 focus:ring-indigo-500/10 shadow-sm"
                        />
                    </div>
                </header>

                {/* Drag-scrollable content area */}
                <div
                    ref={scrollContainerRef}
                    onMouseDown={handleMouseDown}
                    className="flex-1 overflow-y-auto p-12 space-y-4"
                    style={{ cursor: 'grab' }}
                >
                    {sectorDefinitions.map(sector => {
                        const searchClean = governanceSearch.toLowerCase().replace(/^\./, '');
                        const hasMatch = sector.exts.some(ext => ext.includes(searchClean));
                        if (governanceSearch && !hasMatch && sector.id !== 'global') return null;

                        const internalValStr = governance[sector.id]?.max_size || '10MB';
                        const externalValStr = governance[sector.id]?.max_size_direct || '5GB';
                        const isOverPhysical = checkPhysicalLimit(internalValStr);

                        // Per-sector icon
                        const SectorIcon = SECTOR_ICONS[sector.id] || Globe;
                        const isExpanded = expandedSector === sector.id || (!!governanceSearch && hasMatch);

                        return (
                            <div key={sector.id} className="bg-slate-50 border border-slate-100 rounded-[2.5rem] overflow-hidden transition-all group">
                                {/* Sector Header — with Select All / Clear All repositioned next to the expand arrow */}
                                <div className="w-full p-8 flex items-center justify-between text-left hover:bg-white transition-colors">
                                    <button onClick={() => setExpandedSector(expandedSector === sector.id ? null : sector.id)} className="flex items-center gap-6 flex-1 text-left">
                                        <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-inner ${isExpanded ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-400'}`}>
                                            <SectorIcon size={24} />
                                        </div>
                                        <div>
                                            <h4 className="text-xl font-black text-slate-900 tracking-tight">{sector.label}</h4>
                                            <p className="text-[11px] text-slate-400 font-medium uppercase tracking-widest">{sector.desc}</p>
                                        </div>
                                    </button>

                                    {/* Quick actions next to the expand arrow */}
                                    <div className="flex items-center gap-3">
                                        {sector.id !== 'global' && (
                                            <>
                                                <button
                                                    data-no-drag
                                                    onClick={(e) => { e.stopPropagation(); setGovernance({ ...governance, [sector.id]: { ...governance[sector.id], allowed_exts: sector.exts } }); }}
                                                    className="text-[9px] font-black text-indigo-600 uppercase hover:underline px-2 py-1 rounded-lg hover:bg-indigo-50 transition-colors"
                                                    title="Select All Extensions"
                                                >All</button>
                                                <button
                                                    data-no-drag
                                                    onClick={(e) => { e.stopPropagation(); setGovernance({ ...governance, [sector.id]: { ...governance[sector.id], allowed_exts: [] } }); }}
                                                    className="text-[9px] font-black text-rose-500 uppercase hover:underline px-2 py-1 rounded-lg hover:bg-rose-50 transition-colors"
                                                    title="Clear All Extensions"
                                                >None</button>
                                            </>
                                        )}
                                        <button
                                            onClick={() => setExpandedSector(expandedSector === sector.id ? null : sector.id)}
                                            className="p-2 rounded-lg hover:bg-slate-100 transition-colors"
                                        >
                                            <ChevronDown size={20} className={`text-slate-300 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                                        </button>
                                    </div>
                                </div>

                                {isExpanded && (
                                    <div className="p-8 pt-0 border-t border-slate-100 bg-white/50 animate-in slide-in-from-top-2">

                                        {/* LIMITS SECTION (DUAL) */}
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8 bg-white p-6 rounded-3xl border border-slate-100">
                                            {/* Internal Limit */}
                                            <div>
                                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-2">
                                                    <Server size={12} /> Internal Limit (Proxy)
                                                    {isOverPhysical && <span className="text-rose-500 flex items-center gap-1" title="Exceeds Nginx Physical Cap"><AlertTriangle size={10} /> High Risk</span>}
                                                </label>
                                                <div className={`flex items-center gap-2 bg-slate-50 border rounded-xl p-1 ${isOverPhysical ? 'border-rose-300 bg-rose-50' : 'border-slate-200'}`}>
                                                    <input
                                                        data-no-drag
                                                        value={parseSizeValue(internalValStr)}
                                                        onChange={(e) => updateSectorSize(sector.id, e.target.value, parseSizeUnit(internalValStr), false)}
                                                        className="w-full text-center text-xs font-black text-indigo-600 outline-none bg-transparent py-2"
                                                    />
                                                    <select
                                                        data-no-drag
                                                        value={parseSizeUnit(internalValStr)}
                                                        onChange={(e) => updateSectorSize(sector.id, parseSizeValue(internalValStr), e.target.value, false)}
                                                        className="bg-white rounded-lg text-[9px] font-bold text-slate-500 outline-none px-2 py-1 shadow-sm border border-slate-100 h-8"
                                                    >
                                                        <option value="B">Bytes</option><option value="KB">KB</option><option value="MB">MB</option><option value="GB">GB</option>
                                                    </select>
                                                </div>
                                                <p className="text-[9px] text-slate-400 mt-2 leading-relaxed">Limit for files passing through the server RAM/Disk. Max safe: 100MB.</p>
                                            </div>

                                            {/* External Limit */}
                                            <div>
                                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-2"><Cloud size={12} /> External Limit (Direct)</label>
                                                <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl p-1">
                                                    <input
                                                        data-no-drag
                                                        value={parseSizeValue(externalValStr)}
                                                        onChange={(e) => updateSectorSize(sector.id, e.target.value, parseSizeUnit(externalValStr), true)}
                                                        className="w-full text-center text-xs font-black text-emerald-600 outline-none bg-transparent py-2"
                                                    />
                                                    <select
                                                        data-no-drag
                                                        value={parseSizeUnit(externalValStr)}
                                                        onChange={(e) => updateSectorSize(sector.id, parseSizeValue(externalValStr), e.target.value, true)}
                                                        className="bg-white rounded-lg text-[9px] font-bold text-slate-500 outline-none px-2 py-1 shadow-sm border border-slate-100 h-8"
                                                    >
                                                        <option value="B">Bytes</option><option value="KB">KB</option><option value="MB">MB</option><option value="GB">GB</option><option value="TB">TB</option>
                                                    </select>
                                                </div>
                                                <p className="text-[9px] text-slate-400 mt-2 leading-relaxed">Limit for presigned uploads directly to S3/Cloud. Virtually unlimited.</p>
                                            </div>
                                        </div>

                                        {/* Storage Routing (per-sector provider) */}
                                        {sector.id !== 'global' && (
                                            <div className="mb-6">
                                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-3">Storage Routing</span>
                                                <select
                                                    data-no-drag
                                                    value={governance[sector.id]?.storage_provider || 'default'}
                                                    onChange={(e) => setGovernance({
                                                        ...governance,
                                                        [sector.id]: {
                                                            ...governance[sector.id],
                                                            storage_provider: e.target.value === 'default' ? undefined : e.target.value
                                                        }
                                                    })}
                                                    className="w-full bg-white border border-slate-200 rounded-xl py-3 px-4 text-xs font-bold text-slate-700 outline-none cursor-pointer focus:ring-2 focus:ring-indigo-500/20"
                                                >
                                                    <option value="default">Default (Global Provider)</option>
                                                    {STORAGE_PROVIDERS.map(p => (
                                                        <option key={p.id} value={p.id}>{p.name} — {p.desc}</option>
                                                    ))}
                                                </select>
                                                <p className="text-[9px] text-slate-400 mt-2 leading-relaxed">
                                                    Route uploads of this file type to a specific storage provider. Leave as "Default" to use the project's global provider.
                                                </p>
                                            </div>
                                        )}

                                        {/* Whitelisted Extensions */}
                                        {sector.id !== 'global' && (
                                            <>
                                                <div className="flex items-center justify-between mb-6">
                                                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Whitelisted Terminations</span>
                                                </div>

                                                {/* Custom Extension Adder */}
                                                <div className="mb-4 flex items-center gap-3">
                                                    <input
                                                        data-no-drag
                                                        value={newCustomExt}
                                                        onChange={(e) => setNewCustomExt(e.target.value)}
                                                        placeholder="Add custom ext (e.g. .thales)"
                                                        className="bg-white border border-slate-200 rounded-xl px-4 py-2 text-xs font-bold outline-none focus:ring-2 focus:ring-indigo-500/10"
                                                        onKeyDown={(e) => e.key === 'Enter' && addCustomExtension(sector.id)}
                                                    />
                                                    <button data-no-drag onClick={() => addCustomExtension(sector.id)} className="bg-indigo-600 text-white p-2 rounded-lg hover:bg-indigo-700 transition-colors"><Plus size={14} /></button>
                                                </div>

                                                <div className="grid grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3">
                                                    {Array.from(new Set([...sector.exts, ...(governance[sector.id]?.allowed_exts || [])]))
                                                        .filter(ext => ext.includes(governanceSearch.toLowerCase().replace(/^\./, '')))
                                                        .map(ext => {
                                                            const isActive = governance[sector.id]?.allowed_exts?.includes(ext);
                                                            return (
                                                                <button
                                                                    key={ext}
                                                                    data-no-drag
                                                                    onClick={() => {
                                                                        const current = governance[sector.id]?.allowed_exts || [];
                                                                        const next = current.includes(ext) ? current.filter((e: string) => e !== ext) : [...current, ext];
                                                                        setGovernance({ ...governance, [sector.id]: { ...governance[sector.id], allowed_exts: next } });
                                                                    }}
                                                                    className={`flex items-center justify-center gap-2 py-3 rounded-xl border transition-all ${isActive ? 'bg-indigo-600 text-white border-indigo-700 shadow-lg' : 'bg-white text-slate-400 border-slate-200 hover:border-slate-300'}`}
                                                                >
                                                                    {isActive ? <CheckSquare size={12} /> : <Square size={12} />}
                                                                    <span className="text-[10px] font-black uppercase tracking-tighter">.{ext}</span>
                                                                </button>
                                                            );
                                                        })}
                                                </div>
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>

                <footer className="p-10 bg-slate-50 border-t border-slate-100 flex gap-6 shrink-0">
                    <button onClick={onClose} className="flex-1 py-6 text-slate-400 font-black uppercase tracking-widest text-xs hover:bg-slate-100 rounded-[2rem] transition-all">Discard</button>
                    <button onClick={handleSave} className="flex-[3] py-6 bg-slate-900 text-white rounded-[2rem] text-xs font-black uppercase tracking-widest shadow-2xl hover:bg-indigo-600 transition-all">Sincronizar Políticas de Segurança</button>
                </footer>
            </div>
        </div>
    );
};

export default GovernanceModal;
