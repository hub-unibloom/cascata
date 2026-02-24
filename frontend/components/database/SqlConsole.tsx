
import React, { useState, useEffect } from 'react';
import { Terminal, Play, Loader2, Sparkles, History, FileJson, FileSpreadsheet, X, CheckCircle2 } from 'lucide-react';

interface SqlConsoleProps {
    onExecute: (sql: string) => Promise<any>;
    onFix: (sql: string, error: string) => Promise<string | null>;
    onClose?: () => void;
    initialQuery?: string;
}

const SqlConsole: React.FC<SqlConsoleProps> = ({ onExecute, onFix, onClose, initialQuery = '' }) => {
    const [query, setQuery] = useState(initialQuery);
    const [result, setResult] = useState<any>(null);
    const [history, setHistory] = useState<string[]>([]);
    const [executing, setExecuting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isFixing, setIsFixing] = useState(false);

    useEffect(() => {
        if (initialQuery) setQuery(initialQuery);
    }, [initialQuery]);

    const handleRun = async () => {
        if (!query.trim()) return;
        setExecuting(true);
        setResult(null);
        setError(null);
        try {
            const data = await onExecute(query);
            setResult(data);
            setHistory(prev => [query, ...prev.slice(0, 19)]);
        } catch (e: any) {
            setError(e.message || "Query failed");
        } finally {
            setExecuting(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            handleRun();
        }
    };

    const handleFix = async () => {
        if (!error) return;
        setIsFixing(true);
        try {
            const fixed = await onFix(query, error);
            if (fixed) {
                setQuery(fixed);
                setError(null);
            }
        } catch (e) {
            alert("AI failed to fix query.");
        } finally {
            setIsFixing(false);
        }
    };

    // Layout adjusted: No longer fixed/absolute. It fills the parent container.
    return (
        <div className="flex flex-col h-full bg-slate-950 text-white overflow-hidden rounded-br-2xl">
            {/* Toolbar */}
            <div className="h-14 bg-slate-900 border-b border-white/10 flex items-center justify-between px-6 shrink-0">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-indigo-500/10 rounded-lg flex items-center justify-center text-indigo-400">
                        <Terminal size={16} />
                    </div>
                    <span className="font-bold text-sm">SQL Console v2</span>
                </div>
                <div className="flex items-center gap-3">
                    {error && (
                        <button onClick={handleFix} disabled={isFixing} className="flex items-center gap-2 px-3 py-1.5 bg-indigo-500/20 text-indigo-300 rounded-lg text-xs font-bold hover:bg-indigo-500/30 transition-all border border-indigo-500/30">
                            {isFixing ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} Fix with AI
                        </button>
                    )}
                    <button onClick={handleRun} disabled={executing} className="flex items-center gap-2 px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-black uppercase tracking-widest transition-all shadow-lg shadow-emerald-900/20 disabled:opacity-50">
                        {executing ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Run
                    </button>
                </div>
            </div>

            {/* Main Area */}
            <div className="flex-1 flex overflow-hidden">
                <div className="flex-1 flex flex-col min-w-0">
                    <textarea
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={handleKeyDown}
                        className="flex-1 bg-[#0B0F19] text-emerald-400 font-mono text-sm p-6 outline-none resize-none leading-relaxed"
                        placeholder="SELECT * FROM users...  (Ctrl+Enter to run)"
                        spellCheck="false"
                    />

                    {/* Result Panel - Height fixed at 50% for split view effect */}
                    {(result || error) && (
                        <div className="h-1/2 border-t border-white/10 bg-[#0F172A] flex flex-col animate-in slide-in-from-bottom-10">
                            {error ? (
                                <div className="p-6 text-rose-400 font-mono text-xs overflow-auto">
                                    <div className="flex items-center gap-2 mb-2 font-bold uppercase tracking-widest"><X size={14} /> Query Error</div>
                                    {error}
                                </div>
                            ) : (
                                <>
                                    <div className="px-6 py-3 border-b border-white/5 flex justify-between items-center bg-slate-900/50 shrink-0">
                                        <div className="flex gap-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                                            {result.command && <span className="text-emerald-400">{result.command}</span>}
                                            <span>{result.rowCount ?? 0} rows</span>
                                            <span>{result.duration}ms</span>
                                        </div>
                                    </div>
                                    <div className="flex-1 overflow-auto p-0">
                                        {result.rows && result.rows.length > 0 ? (
                                            <table className="w-full text-left border-collapse">
                                                <thead className="sticky top-0 bg-slate-900 z-10 shadow-sm">
                                                    <tr>
                                                        {Object.keys(result.rows[0]).map(k => (
                                                            <th key={k} className="px-4 py-2 text-[10px] font-black text-slate-500 uppercase tracking-widest border-r border-white/5 truncate max-w-[200px]">{k}</th>
                                                        ))}
                                                    </tr>
                                                </thead>
                                                <tbody className="font-mono text-xs text-slate-300">
                                                    {result.rows.map((row: any, i: number) => (
                                                        <tr key={i} className="border-b border-white/5 hover:bg-white/5">
                                                            {Object.values(row).map((v: any, j: number) => (
                                                                <td key={j} className="px-4 py-2 border-r border-white/5 truncate max-w-[300px]">{v === null ? <span className="text-slate-600 italic">null</span> : String(v)}</td>
                                                            ))}
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        ) : (
                                            <div className="p-6 flex flex-col items-center justify-center gap-2">
                                                <CheckCircle2 size={24} className="text-emerald-500" />
                                                <p className="text-emerald-400 text-xs font-bold">{result.command ? `${result.command} executed successfully` : 'Query executed — no rows returned.'}</p>
                                                {result.rowCount !== null && result.rowCount !== undefined && <p className="text-slate-500 text-[10px]">{result.rowCount} row(s) affected</p>}
                                            </div>
                                        )}
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                </div>

                {/* History Sidebar */}
                <div className="w-64 border-l border-white/10 bg-[#0B0F19] flex flex-col shrink-0">
                    <div className="p-4 border-b border-white/5 font-bold text-xs text-slate-400 uppercase tracking-widest flex items-center gap-2">
                        <History size={12} /> History
                    </div>
                    <div className="flex-1 overflow-y-auto p-2 space-y-1">
                        {history.map((h, i) => (
                            <button
                                key={i}
                                onClick={() => setQuery(h)}
                                className="w-full text-left p-3 rounded-lg hover:bg-white/5 text-[10px] font-mono text-slate-500 hover:text-emerald-400 transition-colors truncate border border-transparent hover:border-white/5"
                            >
                                {h}
                            </button>
                        ))}
                        {history.length === 0 && <p className="text-center py-4 text-[10px] text-slate-600">No history</p>}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SqlConsole;
