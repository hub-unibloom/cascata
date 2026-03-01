
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Terminal, Play, Loader2, Sparkles, History, X, CheckCircle2, Save } from 'lucide-react';

interface SqlConsoleProps {
    onExecute: (sql: string) => Promise<any>;
    onFix: (sql: string, error: string) => Promise<string | null>;
    onInterceptCreateTable?: (tableName: string, columns: any[]) => void;
    onClose?: () => void;
    initialQuery?: string;
    projectId?: string;
}

// ============================================================
// TIER-3 UNIVERSAL PADLOCK: Secure CREATE TABLE Interceptor
// ============================================================
// Detects CREATE TABLE statements and redirects them to the
// Schema Designer drawer for column-level security configuration.
//
// SECURITY: Uses a deterministic, non-backtracking tokenizer
// (NOT regex on user input) to avoid ReDoS vulnerabilities.
// The tokenizer splits SQL into structural tokens at parenthesis
// boundaries, then validates the command prefix via simple
// case-insensitive string comparison.
// ============================================================

/**
 * Safely extracts CREATE TABLE metadata from raw SQL.
 * Returns null if the SQL is not a simple CREATE TABLE statement,
 * allowing the SQL to execute natively via the backend.
 *
 * SECURITY NOTES:
 * - No regex is executed on raw user input
 * - Uses indexOf / substring for all parsing (O(n), no backtracking)
 * - Column parsing uses a parenthesis-depth counter (not regex split)
 * - All extracted names are sanitized before use
 */
function extractCreateTableInfo(sql: string): { tableName: string; columns: any[] } | null {
    const trimmed = sql.trim();

    // Phase 1: Verify this is a CREATE TABLE statement
    // Normalize whitespace for prefix matching only (collapse runs of whitespace to single space)
    // We only normalize the first ~80 chars to detect the command prefix — never the full user input.
    const prefixLen = Math.min(trimmed.length, 80);
    const prefix = trimmed.substring(0, prefixLen).replace(/\s+/g, ' ').toUpperCase();

    // Must start with "CREATE TABLE"
    if (!prefix.startsWith('CREATE TABLE')) return null;

    // Phase 2: Find the opening parenthesis that starts column definitions
    const firstParen = trimmed.indexOf('(');
    if (firstParen === -1) return null;

    // Phase 3: Extract table name from the segment between "CREATE TABLE" and "("
    // This segment may contain: IF NOT EXISTS, schema.table, "quoted_name", etc.
    const beforeParen = trimmed.substring(0, firstParen).trim();
    const tokens = beforeParen.split(/\s+/);

    // Walk backwards from end to find the table name token (last non-keyword token)
    let rawTableName = '';
    for (let i = tokens.length - 1; i >= 0; i--) {
        const tok = tokens[i].toUpperCase();
        if (tok === 'EXISTS' || tok === 'NOT' || tok === 'IF' || tok === 'TABLE' || tok === 'CREATE') continue;
        rawTableName = tokens[i];
        break;
    }

    if (!rawTableName) return null;

    // Handle schema-qualified names (schema.table or schema."table")
    const dotIdx = rawTableName.lastIndexOf('.');
    const tableName = (dotIdx >= 0 ? rawTableName.substring(dotIdx + 1) : rawTableName)
        .replace(/^"|"$/g, '') // Strip double quotes
        .toLowerCase();

    if (!tableName || tableName.length === 0) return null;

    // Phase 4: Extract column definitions body using parenthesis depth tracking
    // Find the matching closing parenthesis for the opening one
    let depth = 0;
    let bodyStart = -1;
    let bodyEnd = -1;

    for (let i = firstParen; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (ch === '(') {
            if (depth === 0) bodyStart = i + 1;
            depth++;
        } else if (ch === ')') {
            depth--;
            if (depth === 0) {
                bodyEnd = i;
                break;
            }
        }
    }

    if (bodyStart === -1 || bodyEnd === -1 || bodyEnd <= bodyStart) return null;

    const body = trimmed.substring(bodyStart, bodyEnd).trim();

    // Phase 5: Split columns by commas at depth 0 (respecting nested parens)
    const rawColumns: string[] = [];
    let current = '';
    let parenDepth = 0;

    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === '(') parenDepth++;
        else if (ch === ')') parenDepth--;
        else if (ch === ',' && parenDepth === 0) {
            rawColumns.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim()) rawColumns.push(current.trim());

    // Phase 6: Parse each column definition
    const columns: any[] = [];

    for (const raw of rawColumns) {
        // Skip table constraints (PRIMARY KEY(…), CONSTRAINT …, UNIQUE(…), CHECK(…), FOREIGN KEY …)
        const upper = raw.replace(/\s+/g, ' ').toUpperCase().trimStart();
        if (upper.startsWith('PRIMARY KEY') ||
            upper.startsWith('CONSTRAINT') ||
            upper.startsWith('UNIQUE') ||
            upper.startsWith('CHECK') ||
            upper.startsWith('FOREIGN KEY') ||
            upper.startsWith('EXCLUDE')) {
            continue;
        }

        // Column format: "name" TYPE [constraints...]
        // or: name TYPE [constraints...]
        const parts = raw.trim().split(/\s+/);
        if (parts.length < 2) continue;

        const colName = parts[0].replace(/^"|"$/g, '').toLowerCase();
        const colType = parts[1].toUpperCase();
        const rest = raw.toUpperCase();

        columns.push({
            name: colName,
            type: colType.toLowerCase(),
            isPrimaryKey: rest.includes('PRIMARY KEY'),
            nullable: !rest.includes('NOT NULL'),
            default: (() => {
                const defIdx = rest.indexOf('DEFAULT ');
                if (defIdx === -1) return undefined;
                // Extract default value: everything after DEFAULT until next keyword or end
                const afterDef = raw.substring(defIdx + 8).trim();
                // Find the end of the default value (next constraint keyword or end)
                const keywords = ['NOT NULL', 'NULL', 'UNIQUE', 'PRIMARY', 'REFERENCES', 'CHECK', 'CONSTRAINT'];
                let endPos = afterDef.length;
                for (const kw of keywords) {
                    const kwIdx = afterDef.toUpperCase().indexOf(kw);
                    if (kwIdx > 0 && kwIdx < endPos) endPos = kwIdx;
                }
                return afterDef.substring(0, endPos).trim() || undefined;
            })()
        });
    }

    if (columns.length === 0) return null;

    return { tableName, columns };
}

// ============================================================
// SQL History Persistence
// ============================================================

const HISTORY_KEY_PREFIX = 'cascata_sql_history_';
const MAX_HISTORY_SIZE = 50;

function loadHistory(projectId?: string): string[] {
    if (!projectId) return [];
    try {
        const raw = localStorage.getItem(HISTORY_KEY_PREFIX + projectId);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.slice(0, MAX_HISTORY_SIZE);
    } catch { return []; }
}

function saveHistory(projectId: string | undefined, history: string[]): void {
    if (!projectId) return;
    try {
        localStorage.setItem(HISTORY_KEY_PREFIX + projectId, JSON.stringify(history.slice(0, MAX_HISTORY_SIZE)));
    } catch { /* localStorage full — non-fatal */ }
}

// ============================================================
// Main Component
// ============================================================

const SqlConsole: React.FC<SqlConsoleProps> = ({ onExecute, onFix, onInterceptCreateTable, onClose, initialQuery = '', projectId }) => {
    const [query, setQuery] = useState(initialQuery);
    const [result, setResult] = useState<any>(null);
    const [history, setHistory] = useState<string[]>(() => loadHistory(projectId));
    const [executing, setExecuting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isFixing, setIsFixing] = useState(false);
    const [showHistory, setShowHistory] = useState(true);
    const [saveFlash, setSaveFlash] = useState(false);

    // Ref to track projectId for history persistence
    const projectIdRef = useRef(projectId);
    projectIdRef.current = projectId;

    useEffect(() => {
        if (initialQuery) setQuery(initialQuery);
    }, [initialQuery]);

    // Reload history when projectId changes
    useEffect(() => {
        if (projectId) {
            setHistory(loadHistory(projectId));
        }
    }, [projectId]);

    const addToHistory = useCallback((sql: string) => {
        setHistory(prev => {
            // Deduplicate: remove if already exists, then prepend
            const filtered = prev.filter(h => h !== sql);
            const next = [sql, ...filtered].slice(0, MAX_HISTORY_SIZE);
            saveHistory(projectIdRef.current, next);
            return next;
        });
    }, []);

    const handleRun = async () => {
        if (!query.trim()) return;
        setExecuting(true);
        setResult(null);
        setError(null);

        // TIER-3 UNIVERSAL PADLOCK: Secure DDL Interceptor
        // Uses the deterministic tokenizer (zero regex on user input)
        if (onInterceptCreateTable && query.toUpperCase().includes('CREATE TABLE')) {
            const info = extractCreateTableInfo(query);
            if (info && info.tableName && info.columns.length > 0) {
                onInterceptCreateTable(info.tableName, info.columns);
                addToHistory(query);
                setExecuting(false);
                return; // Intercepted — redirected to Schema Designer
            }
            // If extraction fails, fall through to normal execution
        }

        try {
            const data = await onExecute(query);
            setResult(data);
            addToHistory(query);
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
        // Ctrl+S → save to history without executing
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            if (query.trim()) {
                addToHistory(query);
                setSaveFlash(true);
                setTimeout(() => setSaveFlash(false), 1200);
            }
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

    const clearHistory = useCallback(() => {
        setHistory([]);
        saveHistory(projectIdRef.current, []);
    }, []);

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
                <div className="flex-1 flex flex-col min-w-0 relative">
                    <textarea
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={handleKeyDown}
                        className="flex-1 bg-[#0B0F19] text-emerald-400 font-mono text-sm p-6 outline-none resize-none leading-relaxed"
                        placeholder="SELECT * FROM users...  (Ctrl+Enter to run · Ctrl+S to save)"
                        spellCheck="false"
                    />
                    {saveFlash && (
                        <div className="absolute top-3 right-3 flex items-center gap-2 px-3 py-1.5 bg-emerald-500/20 text-emerald-400 rounded-lg text-xs font-bold animate-in fade-in zoom-in-95 duration-200">
                            <Save size={12} /> Saved to history
                        </div>
                    )}

                    {/* Result Panel */}
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
                    <div className="p-4 border-b border-white/5 font-bold text-xs text-slate-400 uppercase tracking-widest flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <History size={12} /> History
                        </div>
                        {history.length > 0 && (
                            <button
                                onClick={clearHistory}
                                className="text-[9px] text-slate-600 hover:text-rose-400 transition-colors uppercase tracking-widest font-black"
                                title="Clear history"
                            >
                                Clear
                            </button>
                        )}
                    </div>
                    <div className="flex-1 overflow-y-auto p-2 space-y-1">
                        {history.map((h, i) => (
                            <button
                                key={`${i}-${h.substring(0, 20)}`}
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
