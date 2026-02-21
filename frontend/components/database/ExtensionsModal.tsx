
import React, { useState, useMemo } from 'react';
import { Search, Puzzle, X, Loader2, Info, CheckCircle2, Cloud, Database, Shield, FileText, Code2, Globe, Clock, Wrench } from 'lucide-react';
import { EXTENSIONS_CATALOG, ExtensionMeta } from '../../lib/pg-extensions';

interface ExtensionStatus {
    name: string;
    default_version: string;
    installed_version: string | null;
    comment?: string;
}

interface ExtensionsModalProps {
    isOpen: boolean;
    onClose: () => void;
    installedExtensions: ExtensionStatus[];
    onToggle: (name: string, enable: boolean) => Promise<void>;
    loadingName: string | null;
}

// Helper icon component renamed to avoid conflict
const BrainIcon = ({size, className}:any) => <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/></svg>;

const CATEGORIES = [
    { id: 'All', label: 'All', icon: Puzzle },
    { id: 'AI', label: 'AI & Vector', icon: BrainIcon },
    { id: 'Geo', label: 'GeoSpatial', icon: Globe },
    { id: 'Crypto', label: 'Crypto', icon: Shield },
    { id: 'Search', label: 'Search', icon: Search },
    { id: 'DataType', label: 'Data Types', icon: FileText },
    { id: 'Net', label: 'Network', icon: Cloud },
    { id: 'Admin', label: 'Admin', icon: Wrench }
];

const ExtensionsModal: React.FC<ExtensionsModalProps> = ({ isOpen, onClose, installedExtensions, onToggle, loadingName }) => {
    const [search, setSearch] = useState('');
    const [activeCategory, setActiveCategory] = useState('All');

    // Merge logic: Combine installed status from DB with rich metadata from static catalog
    const mergedList = useMemo(() => {
        const map = new Map<string, ExtensionMeta & { installed_version: string | null }>();
        
        // 1. Add all from catalog
        EXTENSIONS_CATALOG.forEach(ext => {
            map.set(ext.name, { ...ext, installed_version: null });
        });

        // 2. Overlay installed status
        installedExtensions.forEach(inst => {
            const existing = map.get(inst.name);
            if (existing) {
                map.set(inst.name, { ...existing, installed_version: inst.installed_version });
            } else {
                // If extension exists in DB but not in our catalog, add it generically
                map.set(inst.name, { 
                    name: inst.name, 
                    category: 'Util', 
                    description: inst.comment || 'System extension', 
                    installed_version: inst.installed_version 
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
            // Sort: Installed first, then featured, then alphabetical
            if (a.installed_version && !b.installed_version) return -1;
            if (!a.installed_version && b.installed_version) return 1;
            if (a.featured && !b.featured) return -1;
            if (!a.featured && b.featured) return 1;
            return a.name.localeCompare(b.name);
        });
    }, [mergedList, search, activeCategory]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[200] flex items-center justify-center p-6 animate-in zoom-in-95">
            <div className="bg-white rounded-[2.5rem] w-full max-w-5xl h-[85vh] shadow-2xl border border-slate-200 flex flex-col overflow-hidden">
                {/* Header */}
                <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                    <div className="flex items-center gap-5">
                        <div className="w-14 h-14 bg-indigo-600 text-white rounded-2xl flex items-center justify-center shadow-xl shadow-indigo-200">
                            <Puzzle size={28}/>
                        </div>
                        <div>
                            <h3 className="text-2xl font-black text-slate-900 tracking-tight">Extensions Marketplace</h3>
                            <p className="text-xs text-slate-500 font-bold uppercase tracking-widest mt-1">Supercharge your Postgres</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-3 hover:bg-slate-200 rounded-full text-slate-400 transition-colors"><X size={24}/></button>
                </div>

                {/* Toolbar */}
                <div className="p-6 border-b border-slate-100 flex flex-col md:flex-row gap-4 items-center bg-white">
                    <div className="relative flex-1 w-full">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18}/>
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
                                <cat.icon size={14}/> {cat.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* List */}
                <div className="flex-1 overflow-y-auto p-8 bg-[#FAFBFC] custom-scrollbar">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {filteredList.map(ext => (
                            <div key={ext.name} className={`relative flex flex-col bg-white border rounded-[2rem] p-6 transition-all group hover:shadow-xl hover:-translate-y-1 ${ext.installed_version ? 'border-indigo-200 ring-1 ring-indigo-100' : 'border-slate-200'}`}>
                                <div className="flex justify-between items-start mb-4">
                                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shadow-sm ${ext.installed_version ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-100 text-slate-400'}`}>
                                        {ext.category === 'AI' ? <BrainIcon size={20}/> : 
                                         ext.category === 'Geo' ? <Globe size={20}/> :
                                         ext.category === 'Crypto' ? <Shield size={20}/> :
                                         <Puzzle size={20}/>}
                                    </div>
                                    <div className="flex flex-col items-end">
                                        <button 
                                            onClick={() => onToggle(ext.name, !!ext.installed_version)}
                                            disabled={loadingName === ext.name}
                                            className={`w-12 h-7 rounded-full p-1 transition-all duration-300 ${ext.installed_version ? 'bg-indigo-600' : 'bg-slate-200 hover:bg-slate-300'}`}
                                        >
                                            <div className={`w-5 h-5 bg-white rounded-full shadow-md transition-transform duration-300 ${ext.installed_version ? 'translate-x-5' : ''}`}>
                                                {loadingName === ext.name && <Loader2 size={12} className="animate-spin text-indigo-600 m-0.5"/>}
                                            </div>
                                        </button>
                                    </div>
                                </div>
                                
                                <h4 className="text-lg font-black text-slate-900 mb-2">{ext.name}</h4>
                                <p className="text-xs text-slate-500 font-medium leading-relaxed line-clamp-3 mb-4 flex-1">{ext.description}</p>
                                
                                <div className="mt-auto pt-4 border-t border-slate-50 flex items-center justify-between">
                                    <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest bg-slate-50 px-2 py-1 rounded">{ext.category}</span>
                                    <span className={`text-[10px] font-mono font-bold flex items-center gap-1 ${ext.installed_version ? 'text-indigo-600' : 'text-slate-400'}`}>
                                        {ext.installed_version ? <CheckCircle2 size={10}/> : null}
                                        {ext.installed_version || 'Not Installed'}
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                    {filteredList.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                            <Puzzle size={64} className="opacity-20 mb-4"/>
                            <p className="font-black uppercase tracking-widest text-xs">No extensions found</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default ExtensionsModal;