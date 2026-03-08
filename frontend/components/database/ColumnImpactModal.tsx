
import React, { useState } from 'react';
import {
    X, AlertTriangle, Key, Database, Eye, Zap, Code, Shield, Clock,
    ChevronDown, ChevronRight, Loader2, CheckCircle2, Copy
} from 'lucide-react';
import { DependencyItem, buildCascadeSQL } from '../../lib/ColumnImpactScanner';

// ============================================================
// ColumnImpactModal — Protocolo Cascata Global
// ============================================================
// Displays categorized dependency impact analysis before
// column rename/delete operations. Executes cascade atomically.
// ============================================================

interface ColumnImpactModalProps {
    isOpen: boolean;
    action: 'rename' | 'delete';
    schema: string;
    table: string;
    column: string;
    newName?: string;
    dependencies: DependencyItem[];
    isScanning: boolean;
    onClose: () => void;
    onExecute: (sql: string) => Promise<void>;
    /** 'column' (default) or 'table' — controls labels and SQL generation */
    targetType?: 'column' | 'table';
    /** Pre-built cascade SQL — used for table rename instead of buildCascadeSQL */
    cascadeSQLOverride?: string;
}

const TYPE_CONFIG: Record<string, { icon: React.ReactNode; label: string; color: string }> = {
    fk: { icon: <Key size={14} />, label: 'Foreign Keys', color: 'rose' },
    index: { icon: <Database size={14} />, label: 'Indexes', color: 'amber' },
    view: { icon: <Eye size={14} />, label: 'Views', color: 'blue' },
    trigger: { icon: <Zap size={14} />, label: 'Triggers', color: 'purple' },
    function: { icon: <Code size={14} />, label: 'Functions/RPCs', color: 'orange' },
    policy: { icon: <Shield size={14} />, label: 'RLS Policies', color: 'red' },
    cronjob: { icon: <Clock size={14} />, label: 'Cron Jobs', color: 'teal' },
};

const SEVERITY_BADGE: Record<string, string> = {
    danger: 'bg-rose-100 text-rose-700 border-rose-200',
    warning: 'bg-amber-100 text-amber-700 border-amber-200',
    info: 'bg-blue-100 text-blue-700 border-blue-200',
};

const ColumnImpactModal: React.FC<ColumnImpactModalProps> = ({
    isOpen, action, schema, table, column, newName,
    dependencies, isScanning, onClose, onExecute,
    targetType = 'column', cascadeSQLOverride,
}) => {
    const [executing, setExecuting] = useState(false);
    const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());
    const [showSQL, setShowSQL] = useState(false);

    if (!isOpen) return null;

    const isTable = targetType === 'table';
    const targetLabel = isTable ? 'Table' : 'Column';

    // Group dependencies by type
    const grouped = dependencies.reduce<Record<string, DependencyItem[]>>((acc, dep) => {
        if (!acc[dep.type]) acc[dep.type] = [];
        acc[dep.type].push(dep);
        return acc;
    }, {});

    const cascadeSQL = cascadeSQLOverride || buildCascadeSQL(schema, table, column, action, newName, dependencies);
    const hasManualReview = dependencies.some(d => d.type === 'function' && !d.cascadeSQL);
    const hasDanger = dependencies.some(d => d.severity === 'danger');

    const toggleType = (type: string) => {
        setExpandedTypes(prev => {
            const next = new Set(prev);
            if (next.has(type)) next.delete(type);
            else next.add(type);
            return next;
        });
    };

    const handleExecute = async () => {
        setExecuting(true);
        try {
            await onExecute(cascadeSQL);
        } finally {
            setExecuting(false);
        }
    };

    const copySQL = () => {
        navigator.clipboard.writeText(cascadeSQL).catch(() => { });
    };

    return (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[600] flex items-center justify-center p-6 animate-in zoom-in-95">
            <div className="bg-white rounded-3xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden">

                {/* Header */}
                <div className={`p-6 border-b ${action === 'delete' ? 'bg-rose-50 border-rose-100' : 'bg-indigo-50 border-indigo-100'}`}>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${action === 'delete' ? 'bg-rose-600' : 'bg-indigo-600'} text-white shadow-lg`}>
                                <AlertTriangle size={20} />
                            </div>
                            <div>
                                <h3 className="text-lg font-black text-slate-900 tracking-tight">
                                    {action === 'rename' ? `Impact Analysis — Rename ${targetLabel}` : `Impact Analysis — Delete ${targetLabel}`}
                                </h3>
                                <p className="text-xs font-bold text-slate-500 mt-0.5">
                                    {action === 'rename'
                                        ? <><span className="text-slate-700">{column}</span> → <span className="text-indigo-600">{newName}</span></>
                                        : <><span className="text-rose-600 line-through">{column}</span> on <span className="text-slate-700">{schema}.{table}</span></>
                                    }
                                </p>
                            </div>
                        </div>
                        <button onClick={onClose} className="p-2 hover:bg-white/80 rounded-lg text-slate-400">
                            <X size={20} />
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-6 space-y-4">
                    {isScanning ? (
                        <div className="flex flex-col items-center justify-center py-16 text-slate-400">
                            <Loader2 size={32} className="animate-spin mb-4" />
                            <p className="text-sm font-bold">Scanning dependencies...</p>
                            <p className="text-[10px] font-medium text-slate-300 mt-1">Checking FKs, indexes, views, triggers, functions, RLS, cron...</p>
                        </div>
                    ) : dependencies.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-16">
                            <CheckCircle2 size={48} className="text-emerald-500 mb-4" />
                            <p className="text-lg font-black text-slate-900">No Dependencies Found</p>
                            <p className="text-sm text-slate-400 font-medium mt-1">Safe to proceed. No objects reference this {targetLabel.toLowerCase()}.</p>
                        </div>
                    ) : (
                        <>
                            {/* Summary Bar */}
                            <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Found:</span>
                                {Object.entries(grouped).map(([type, items]) => {
                                    const config = TYPE_CONFIG[type] || { icon: null, label: type, color: 'slate' };
                                    return (
                                        <span key={type} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-black bg-${config.color}-100 text-${config.color}-700 border border-${config.color}-200`}>
                                            {config.icon} {items.length} {config.label}
                                        </span>
                                    );
                                })}
                            </div>

                            {/* Warning Banner */}
                            {hasManualReview && (
                                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
                                    <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
                                    <div>
                                        <p className="text-xs font-bold text-amber-800">Manual Review Required</p>
                                        <p className="text-[10px] text-amber-600 font-medium mt-1">
                                            Some functions reference this {targetLabel.toLowerCase()} and cannot be auto-updated. Review them after the operation.
                                        </p>
                                    </div>
                                </div>
                            )}

                            {/* Dependency Groups */}
                            {Object.entries(grouped).map(([type, items]) => {
                                const config = TYPE_CONFIG[type] || { icon: null, label: type, color: 'slate' };
                                const isExpanded = expandedTypes.has(type);

                                return (
                                    <div key={type} className="border border-slate-200 rounded-xl overflow-hidden">
                                        <button
                                            onClick={() => toggleType(type)}
                                            className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors"
                                        >
                                            <div className="flex items-center gap-2">
                                                {config.icon}
                                                <span className="text-xs font-black text-slate-700">{config.label}</span>
                                                <span className="text-[10px] font-bold text-slate-400 bg-slate-200 px-2 py-0.5 rounded-full">{items.length}</span>
                                            </div>
                                            {isExpanded ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
                                        </button>

                                        {isExpanded && (
                                            <div className="divide-y divide-slate-100">
                                                {items.map((dep, i) => (
                                                    <div key={i} className="px-4 py-3 flex items-start justify-between gap-3">
                                                        <div className="flex-1 min-w-0">
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-xs font-bold text-slate-800 truncate">{dep.name}</span>
                                                                <span className={`text-[9px] font-black px-1.5 py-0.5 rounded border ${SEVERITY_BADGE[dep.severity]}`}>
                                                                    {dep.severity.toUpperCase()}
                                                                </span>
                                                            </div>
                                                            <p className="text-[10px] text-slate-500 font-medium mt-1 truncate">{dep.detail}</p>
                                                            {dep.cascadeSQL && (
                                                                <pre className="text-[9px] font-mono text-slate-400 bg-slate-50 rounded-lg p-2 mt-2 overflow-x-auto whitespace-pre-wrap">
                                                                    {dep.cascadeSQL}
                                                                </pre>
                                                            )}
                                                            {!dep.cascadeSQL && dep.type === 'function' && (
                                                                <p className="text-[10px] font-bold text-amber-600 mt-1">⚠ Cannot auto-fix — manual review needed</p>
                                                            )}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}

                            {/* SQL Preview */}
                            <div className="border border-slate-200 rounded-xl overflow-hidden">
                                <button
                                    onClick={() => setShowSQL(!showSQL)}
                                    className="w-full flex items-center justify-between px-4 py-3 bg-slate-900 hover:bg-slate-800 transition-colors"
                                >
                                    <span className="text-xs font-black text-white">Full Cascade SQL</span>
                                    <div className="flex items-center gap-2">
                                        <button onClick={(e) => { e.stopPropagation(); copySQL(); }} className="text-[10px] font-bold text-slate-400 hover:text-white transition-colors flex items-center gap-1">
                                            <Copy size={10} /> Copy
                                        </button>
                                        {showSQL ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
                                    </div>
                                </button>
                                {showSQL && (
                                    <pre className="p-4 bg-slate-950 text-slate-300 text-[10px] font-mono overflow-x-auto max-h-64 whitespace-pre-wrap">
                                        {cascadeSQL}
                                    </pre>
                                )}
                            </div>
                        </>
                    )}
                </div>

                {/* Footer */}
                <div className="p-6 border-t border-slate-100 bg-slate-50/50 flex gap-4">
                    <button
                        onClick={onClose}
                        className="flex-1 py-3 text-xs font-black text-slate-400 uppercase tracking-widest hover:text-slate-600"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleExecute}
                        disabled={isScanning || executing}
                        className={`flex-[2] py-3 rounded-xl text-xs font-black uppercase tracking-widest shadow-xl transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed ${action === 'delete'
                            ? 'bg-rose-600 text-white hover:bg-rose-700'
                            : 'bg-indigo-600 text-white hover:bg-indigo-700'
                            }`}
                    >
                        {executing ? <Loader2 size={14} className="animate-spin" /> : null}
                        {dependencies.length === 0
                            ? (action === 'rename' ? `Rename ${targetLabel}` : `Delete ${targetLabel}`)
                            : `Execute Cascade (${dependencies.length} objects)`
                        }
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ColumnImpactModal;
