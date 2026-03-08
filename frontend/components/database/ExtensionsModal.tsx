
import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Search, Puzzle, X, Loader2, CheckCircle2, Cloud, Shield, FileText, Globe, Clock, Wrench, Download, AlertTriangle, Zap, Cpu, HardDrive } from 'lucide-react';
import { EXTENSIONS_CATALOG, ExtensionMeta, TIER_LABELS, ORIGIN_LABELS, ExtensionOrigin, ExtensionStatus } from '../../lib/pg-extensions';

// Enriched extension from the backend API (includes real-time status)
interface EnrichedExtension {
    name: string;
    category: string;
    description: string;
    featured: boolean;
    origin: ExtensionOrigin;
    status: ExtensionStatus;
    installed_version: string | null;
    default_version: string | null;
    source_image: string | null;
    estimate_mb: number;
    tier: number;
}

interface ExtensionsModalProps {
    isOpen: boolean;
    onClose: () => void;
    installedExtensions: EnrichedExtension[];
    onInstall: (name: string) => Promise<void>;
    onUninstall: (name: string) => Promise<void>;
    loadingName: string | null;
}

// Helper icon component
const BrainIcon = ({ size, className }: any) => <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" /><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" /></svg>;

const CATEGORIES = [
    { id: 'All', label: 'All', icon: Puzzle },
    { id: 'AI', label: 'AI & Vector', icon: BrainIcon },
    { id: 'Geo', label: 'GeoSpatial', icon: Globe },
    { id: 'Crypto', label: 'Crypto', icon: Shield },
    { id: 'Search', label: 'Search', icon: Search },
    { id: 'Index', label: 'Index', icon: HardDrive },
    { id: 'DataType', label: 'Data Types', icon: FileText },
    { id: 'Time', label: 'Time Series', icon: Clock },
    { id: 'Admin', label: 'Admin', icon: Wrench },
    { id: 'Util', label: 'Utility', icon: Zap },
    { id: 'Audit', label: 'Audit', icon: Cpu }
];

const getCategoryIcon = (category: string, size: number) => {
    switch (category) {
        case 'AI': return <BrainIcon size={size} />;
        case 'Geo': return <Globe size={size} />;
        case 'Crypto': return <Shield size={size} />;
        case 'Search': return <Search size={size} />;
        case 'Index': return <HardDrive size={size} />;
        case 'DataType': return <FileText size={size} />;
        case 'Time': return <Clock size={size} />;
        case 'Admin': return <Wrench size={size} />;
        case 'Audit': return <Cpu size={size} />;
        case 'Net': return <Cloud size={size} />;
        default: return <Puzzle size={size} />;
    }
};

const TierBadge: React.FC<{ tier: number }> = ({ tier }) => {
    const info = TIER_LABELS[tier] || TIER_LABELS[0];
    return (
        <span
            className="text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-full"
            style={{ backgroundColor: `${info.color}18`, color: info.color }}
            title={info.description}
        >
            {info.label}
        </span>
    );
};

const OriginBadge: React.FC<{ origin: ExtensionOrigin }> = ({ origin }) => {
    const info = ORIGIN_LABELS[origin];
    const colorMap: Record<ExtensionOrigin, string> = {
        native: '#10b981',
        preloaded: '#f59e0b',
        phantom: '#8b5cf6'
    };
    return (
        <span
            className="text-[8px] font-bold px-1.5 py-0.5 rounded-full flex items-center gap-0.5"
            style={{ backgroundColor: `${colorMap[origin]}12`, color: colorMap[origin] }}
        >
            {info.icon} {info.label}
        </span>
    );
};

const StatusIndicator: React.FC<{ status: ExtensionStatus; isLoading: boolean }> = ({ status, isLoading }) => {
    if (isLoading || status === 'injecting') {
        return (
            <div className="flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin text-indigo-500" />
                <span className="text-[9px] font-bold text-indigo-500 uppercase tracking-wider">
                    {status === 'injecting' ? 'Injecting...' : 'Processing...'}
                </span>
            </div>
        );
    }
    if (status === 'installed') {
        return (
            <div className="flex items-center gap-1">
                <CheckCircle2 size={12} className="text-emerald-500" />
                <span className="text-[9px] font-bold text-emerald-600 uppercase tracking-wider">Active</span>
            </div>
        );
    }
    if (status === 'error') {
        return (
            <div className="flex items-center gap-1">
                <AlertTriangle size={12} className="text-red-400" />
                <span className="text-[9px] font-bold text-red-500 uppercase tracking-wider">Error</span>
            </div>
        );
    }
    if (status === 'ready') {
        return (
            <span className="text-[9px] font-bold text-blue-500 uppercase tracking-wider">Ready</span>
        );
    }
    return (
        <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Available</span>
    );
};

const ExtensionsModal: React.FC<ExtensionsModalProps> = ({ isOpen, onClose, installedExtensions, onInstall, onUninstall, loadingName }) => {
    const [search, setSearch] = useState('');
    const [activeCategory, setActiveCategory] = useState('All');
    const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

    // Merge: backend enriched data with static catalog as fallback
    const mergedList = useMemo(() => {
        const map = new Map<string, EnrichedExtension>();

        // 1. Start with backend enriched data (source of truth)
        installedExtensions.forEach(ext => {
            map.set(ext.name, ext);
        });

        // 2. Add catalog entries that the backend didn't return
        // (shouldn't happen normally, but defensive)
        EXTENSIONS_CATALOG.forEach(catalogExt => {
            if (!map.has(catalogExt.name)) {
                map.set(catalogExt.name, {
                    name: catalogExt.name,
                    category: catalogExt.category,
                    description: catalogExt.description,
                    featured: catalogExt.featured || false,
                    origin: catalogExt.origin,
                    status: 'available',
                    installed_version: null,
                    default_version: null,
                    source_image: catalogExt.sourceImage || null,
                    estimate_mb: catalogExt.estimateMB || 0,
                    tier: catalogExt.tier
                });
            }
        });

        return Array.from(map.values());
    }, [installedExtensions]);

    const filteredList = useMemo(() => {
        return mergedList.filter(ext => {
            const matchesSearch = ext.name.toLowerCase().includes(search.toLowerCase()) ||
                ext.description.toLowerCase().includes(search.toLowerCase());
            const matchesCategory = activeCategory === 'All' || ext.category === activeCategory;
            return matchesSearch && matchesCategory;
        }).sort((a, b) => {
            // Sort: Installed first, then featured, then by tier, then alphabetical
            if (a.status === 'installed' && b.status !== 'installed') return -1;
            if (a.status !== 'installed' && b.status === 'installed') return 1;
            if (a.featured && !b.featured) return -1;
            if (!a.featured && b.featured) return 1;
            if (a.tier !== b.tier) return a.tier - b.tier;
            return a.name.localeCompare(b.name);
        });
    }, [mergedList, search, activeCategory]);

    // Stats
    const stats = useMemo(() => {
        const installed = mergedList.filter(e => e.status === 'installed').length;
        const phantom = mergedList.filter(e => e.origin === 'phantom').length;
        const native = mergedList.filter(e => e.origin === 'native' || e.origin === 'preloaded').length;
        return { installed, phantom, native, total: mergedList.length };
    }, [mergedList]);

    const handleToggle = useCallback(async (ext: EnrichedExtension) => {
        try {
            if (ext.status === 'installed') {
                await onUninstall(ext.name);
                showToast(`${ext.name} removed successfully`, 'success');
            } else {
                await onInstall(ext.name);
                showToast(`${ext.name} installed successfully`, 'success');
            }
        } catch (err: any) {
            showToast(err.message || 'Operation failed', 'error');
        }
    }, [onInstall, onUninstall]);

    const showToast = (message: string, type: 'success' | 'error') => {
        setToast({ message, type });
        setTimeout(() => setToast(null), 4000);
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[200] flex items-center justify-center p-6 animate-in zoom-in-95">
            <div className="bg-white rounded-[2.5rem] w-full max-w-5xl h-[85vh] shadow-2xl border border-slate-200 flex flex-col overflow-hidden">
                {/* Header */}
                <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-gradient-to-r from-slate-50 to-indigo-50/30">
                    <div className="flex items-center gap-5">
                        <div className="w-14 h-14 bg-gradient-to-br from-indigo-600 to-purple-600 text-white rounded-2xl flex items-center justify-center shadow-xl shadow-indigo-200">
                            <Puzzle size={28} />
                        </div>
                        <div>
                            <h3 className="text-2xl font-black text-slate-900 tracking-tight">Extensions Marketplace</h3>
                            <div className="flex items-center gap-3 mt-1">
                                <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                                    {stats.installed} Active
                                </span>
                                <span className="text-[10px] font-bold text-purple-600 bg-purple-50 px-2 py-0.5 rounded-full">
                                    {stats.phantom} Phantom
                                </span>
                                <span className="text-[10px] font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
                                    {stats.total} Total
                                </span>
                            </div>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-3 hover:bg-slate-200 rounded-full text-slate-400 transition-colors"><X size={24} /></button>
                </div>

                {/* Toolbar */}
                <div className="p-6 border-b border-slate-100 flex flex-col md:flex-row gap-4 items-center bg-white">
                    <div className="relative flex-1 w-full">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                        <input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search extensions (e.g. vector, geo, crypto)..."
                            className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-500/20 transition-all"
                            autoFocus
                        />
                    </div>
                    <div className="flex gap-2 overflow-x-auto w-full md:w-auto pb-1 custom-scrollbar">
                        {CATEGORIES.map(cat => (
                            <button
                                key={cat.id}
                                onClick={() => setActiveCategory(cat.id)}
                                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all whitespace-nowrap ${activeCategory === cat.id ? 'bg-indigo-600 text-white shadow-md' : 'bg-slate-50 text-slate-500 hover:bg-slate-100'}`}
                            >
                                <cat.icon size={14} /> {cat.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* List */}
                <div className="flex-1 overflow-y-auto p-8 bg-[#FAFBFC] custom-scrollbar">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {filteredList.map(ext => {
                            const isCurrentlyLoading = loadingName === ext.name;
                            const isPhantom = ext.origin === 'phantom';
                            const isInstalled = ext.status === 'installed';

                            return (
                                <div
                                    key={ext.name}
                                    className={`relative flex flex-col bg-white border rounded-[2rem] p-6 transition-all group hover:shadow-xl hover:-translate-y-1 ${isInstalled ? 'border-emerald-200 ring-1 ring-emerald-100' :
                                            ext.status === 'injecting' ? 'border-indigo-200 ring-1 ring-indigo-100' :
                                                'border-slate-200'
                                        }`}
                                >
                                    {/* Top Row: Icon + Toggle */}
                                    <div className="flex justify-between items-start mb-3">
                                        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shadow-sm ${isInstalled ? 'bg-emerald-50 text-emerald-600' :
                                                isPhantom ? 'bg-purple-50 text-purple-500' :
                                                    'bg-slate-100 text-slate-400'
                                            }`}>
                                            {getCategoryIcon(ext.category, 20)}
                                        </div>
                                        <div className="flex flex-col items-end gap-1.5">
                                            <button
                                                onClick={() => handleToggle(ext)}
                                                disabled={isCurrentlyLoading || ext.status === 'injecting'}
                                                className={`w-12 h-7 rounded-full p-1 transition-all duration-300 ${isInstalled ? 'bg-emerald-500' :
                                                        ext.status === 'injecting' ? 'bg-indigo-400 animate-pulse' :
                                                            'bg-slate-200 hover:bg-slate-300'
                                                    }`}
                                            >
                                                <div className={`w-5 h-5 bg-white rounded-full shadow-md transition-transform duration-300 flex items-center justify-center ${isInstalled || ext.status === 'injecting' ? 'translate-x-5' : ''
                                                    }`}>
                                                    {(isCurrentlyLoading || ext.status === 'injecting') && (
                                                        <Loader2 size={12} className="animate-spin text-indigo-600" />
                                                    )}
                                                </div>
                                            </button>
                                        </div>
                                    </div>

                                    {/* Name + Badges */}
                                    <h4 className="text-lg font-black text-slate-900 mb-1.5">{ext.name}</h4>
                                    <div className="flex items-center gap-1.5 mb-3 flex-wrap">
                                        <TierBadge tier={ext.tier} />
                                        <OriginBadge origin={ext.origin} />
                                        {isPhantom && ext.estimate_mb > 0 && (
                                            <span className="text-[8px] font-bold text-slate-400 px-1.5 py-0.5 rounded-full bg-slate-50 flex items-center gap-0.5">
                                                <Download size={8} /> ~{ext.estimate_mb}MB
                                            </span>
                                        )}
                                    </div>

                                    {/* Description */}
                                    <p className="text-xs text-slate-500 font-medium leading-relaxed line-clamp-3 mb-4 flex-1">{ext.description}</p>

                                    {/* Footer: Category + Status */}
                                    <div className="mt-auto pt-4 border-t border-slate-50 flex items-center justify-between">
                                        <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest bg-slate-50 px-2 py-1 rounded">
                                            {ext.category}
                                        </span>
                                        <StatusIndicator status={ext.status} isLoading={isCurrentlyLoading} />
                                    </div>

                                    {/* Phantom Injection Indicator (animated border glow) */}
                                    {ext.status === 'injecting' && (
                                        <div className="absolute inset-0 rounded-[2rem] ring-2 ring-indigo-400/40 animate-pulse pointer-events-none" />
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    {filteredList.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                            <Puzzle size={64} className="opacity-20 mb-4" />
                            <p className="font-black uppercase tracking-widest text-xs">No extensions found</p>
                        </div>
                    )}
                </div>

                {/* Toast Notification */}
                {toast && (
                    <div className={`absolute bottom-6 left-1/2 -translate-x-1/2 px-6 py-3 rounded-2xl shadow-2xl text-sm font-bold flex items-center gap-2 animate-in slide-in-from-bottom-4 z-[300] ${toast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
                        }`}>
                        {toast.type === 'success' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
                        {toast.message}
                    </div>
                )}
            </div>
        </div>
    );
};

export default ExtensionsModal;