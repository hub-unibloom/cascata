
import React, { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';
import {
    Loader2, Plus, Key, ChevronLeft, ChevronRight, ChevronUp, ChevronDown,
    Download, Upload, Save, GripVertical, X, Trash2,
    Code, FileJson, FileSpreadsheet, FileType, Rows3
} from 'lucide-react';

// --- Helpers ---
const getSmartPlaceholder = (col: any) => {
    if (col.defaultValue?.includes('gen_random_uuid')) return 'UUID (Auto)';
    if (col.defaultValue?.includes('now()')) return 'Now()';
    return col.type;
};

const translateError = (err: any) => {
    const msg = err?.message || String(err);
    if (msg.includes('duplicate key')) return 'Duplicate entry — a record with this key already exists.';
    if (msg.includes('violates foreign')) return 'Foreign Key Violation — the referenced record does not exist.';
    if (msg.includes('not-null')) return 'Missing required field.';
    if (msg.includes('permission denied')) return 'Permission denied. Check RLS policies.';
    return msg;
};

// --- Public API (imperative handle) ---
export interface TablePanelHandle {
    refresh: () => void;
    getData: () => any[];
    getSelectedRows: () => Set<any>;
    getColumns: () => any[];
}

export interface TablePanelProps {
    projectId: string;
    tableName: string;
    schema: string;
    isCompareMode: boolean;
    onClose?: () => void;
    onColumnContextMenu?: (x: number, y: number, col: string, table: string) => void;
    onAddColumn?: (table: string) => void;
    onError: (msg: string) => void;
    onSuccess: (msg: string) => void;
    onExport?: (tableName: string, data: any[], format: string) => void;
    onImport?: () => void;
    isRealtimeActive?: boolean;
}

// --- Cell Editor Portal ---
const CellEditorPortal: React.FC<{
    value: string;
    rect: DOMRect;
    onSave: (val: string) => void;
    onCancel: () => void;
}> = ({ value, rect, onSave, onCancel }) => {
    const [editVal, setEditVal] = useState(value);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const isSaving = useRef(false);

    useEffect(() => {
        textareaRef.current?.focus();
        // Auto-select all text on open
        textareaRef.current?.select();
    }, []);

    // Click outside to save
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                if (!isSaving.current) { isSaving.current = true; onSave(editVal); }
            }
        };
        // Delay to avoid immediate trigger
        const timer = setTimeout(() => document.addEventListener('mousedown', handler), 50);
        return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler); };
    }, [editVal, onSave]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (!isSaving.current) { isSaving.current = true; onSave(editVal); }
        }
    };

    // Position: appear over the cell, expand downward up to 7 lines
    const style: React.CSSProperties = {
        position: 'fixed',
        top: rect.top - 2,
        left: rect.left - 2,
        width: Math.max(rect.width + 4, 200),
        minHeight: rect.height + 4,
        maxHeight: 200,
        zIndex: 9999,
    };

    return createPortal(
        <div ref={containerRef} style={style} className="animate-in fade-in zoom-in-95 duration-100">
            <textarea
                ref={textareaRef}
                value={editVal}
                onChange={e => setEditVal(e.target.value)}
                onKeyDown={handleKeyDown}
                className="w-full h-full px-4 py-2 bg-white outline-none border-2 border-indigo-500 rounded-lg shadow-2xl text-xs font-medium text-slate-700 font-mono whitespace-pre-wrap"
                style={{ minHeight: rect.height + 4, maxHeight: 200, overflowY: 'auto', resize: 'vertical' }}
            />
            <div className="absolute -bottom-5 left-1 text-[9px] font-bold text-slate-400 bg-white/90 px-2 py-0.5 rounded shadow-sm">
                Ctrl+Enter save · Esc cancel
            </div>
        </div>,
        document.body
    );
};

// --- Main Component ---
const TablePanel = forwardRef<TablePanelHandle, TablePanelProps>(({
    projectId, tableName, schema, isCompareMode,
    onClose, onColumnContextMenu, onAddColumn,
    onError, onSuccess, onExport, onImport,
    isRealtimeActive
}, ref) => {
    // --- STATE ---
    const [tableData, setTableData] = useState<any[]>([]);
    const [columns, setColumns] = useState<any[]>([]);
    const [dataLoading, setDataLoading] = useState(false);
    const [pageStart, setPageStart] = useState(0);
    const [totalRows, setTotalRows] = useState<number | null>(null);
    const [rowsPerPage, setRowsPerPage] = useState(100);

    // Row height control
    const [rowHeight, setRowHeight] = useState<'compact' | 'normal' | 'tall' | 'expanded'>('normal');
    const rowHeightPx: Record<string, number> = { compact: 32, normal: 40, tall: 56, expanded: 80 };

    // Sort config — persisted in localStorage per table
    const sortStorageKey = `cascata_sort_${projectId}_${schema}_${tableName}`;
    const [sortConfig, setSortConfigInternal] = useState<{ column: string, direction: 'asc' | 'desc' } | null>(() => {
        try { const s = localStorage.getItem(sortStorageKey); return s ? JSON.parse(s) : null; } catch { return null; }
    });
    const setSortConfig = useCallback((cfg: { column: string, direction: 'asc' | 'desc' } | null) => {
        setSortConfigInternal(cfg);
        if (cfg) localStorage.setItem(sortStorageKey, JSON.stringify(cfg));
        else localStorage.removeItem(sortStorageKey);
    }, [sortStorageKey]);

    // Column state
    const [columnOrder, setColumnOrder] = useState<string[]>([]);
    const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
    const [draggingColumn, setDraggingColumn] = useState<string | null>(null);
    const [dragOverCol, setDragOverCol] = useState<string | null>(null);

    // Row selection
    const [selectedRows, setSelectedRows] = useState<Set<any>>(new Set());

    // Cell editing — portal approach
    const [editingCell, setEditingCell] = useState<{ rowId: any, col: string, rect: DOMRect } | null>(null);
    const [inlineNewRow, setInlineNewRow] = useState<any>({});
    const [executing, setExecuting] = useState(false);
    const firstInputRef = useRef<HTMLInputElement>(null);

    // Export menu
    const [showExportMenu, setShowExportMenu] = useState(false);
    const exportMenuRef = useRef<HTMLDivElement>(null);

    // Derived
    const pkCol = columns.find(c => c.isPrimaryKey)?.name || columns[0]?.name;
    const displayColumns = columnOrder.length > 0
        ? columnOrder.map(name => columns.find(c => c.name === name)).filter(Boolean)
        : columns;

    // Count is fetched separately — only on mount and after mutations
    const countFetchedRef = useRef(false);

    // --- API HELPER ---
    const fetchWithAuth = useCallback(async (url: string, options: any = {}) => {
        const token = localStorage.getItem('cascata_token');
        const response = await fetch(url, {
            ...options,
            headers: { ...options.headers, 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        });
        if (response.status === 401) { localStorage.removeItem('cascata_token'); window.location.hash = '#/login'; throw new Error('Session expired'); }
        if (!response.ok) { const errData = await response.json().catch(() => ({})); throw new Error(errData.error || `Error ${response.status}`); }
        return response.json();
    }, []);

    // --- COUNT LOADER (separate from data) ---
    const fetchCount = useCallback(async () => {
        try {
            const res = await fetchWithAuth(`/api/data/${projectId}/query?schema=${schema}`, {
                method: 'POST',
                body: JSON.stringify({ sql: `SELECT count(*)::int as total FROM ${schema}."${tableName}"` })
            });
            if (res?.rows?.[0]?.total != null) setTotalRows(res.rows[0].total);
        } catch { /* silent — count is non-critical */ }
    }, [projectId, tableName, schema, fetchWithAuth]);

    // --- DATA LOADER ---
    const fetchTableData = useCallback(async () => {
        setDataLoading(true);
        try {
            let url = `/api/data/${projectId}/tables/${tableName}/data?limit=${rowsPerPage}&offset=${pageStart}&schema=${schema}`;
            if (sortConfig) url += `&sortColumn=${sortConfig.column}&sortDirection=${sortConfig.direction}`;

            const [rows, cols, settings] = await Promise.all([
                fetchWithAuth(url),
                fetchWithAuth(`/api/data/${projectId}/tables/${tableName}/columns?schema=${schema}`),
                fetchWithAuth(`/api/data/${projectId}/ui-settings/${tableName}?schema=${schema}`)
            ]);

            setTableData(rows);
            setColumns(cols);

            // Auto-reset pagination if page returns empty but data exists
            if (rows.length === 0 && pageStart > 0) {
                setPageStart(0);
                return; // Will re-trigger via useEffect
            }

            // Column order + widths from settings
            let finalOrder: string[] = [];
            if (settings?.columns) {
                const savedNames = settings.columns.map((c: any) => c.name);
                const validSaved = savedNames.filter((name: string) => cols.some((c: any) => c.name === name));
                const newCols = cols.filter((c: any) => !savedNames.includes(c.name)).map((c: any) => c.name);
                finalOrder = [...validSaved, ...newCols];
                const widths: Record<string, number> = {};
                settings.columns.forEach((c: any) => { if (c.width) widths[c.name] = c.width; });
                setColumnWidths(widths);
            } else {
                finalOrder = cols.map((c: any) => c.name);
            }
            setColumnOrder(finalOrder);

            // Initialize inline row
            const initialRow: any = {};
            cols.forEach((c: any) => { initialRow[c.name] = ''; });
            setInlineNewRow(initialRow);

            // Fetch count only on first load
            if (!countFetchedRef.current) {
                countFetchedRef.current = true;
                fetchCount();
            }
        } catch (err: any) { onError(translateError(err)); }
        finally { setDataLoading(false); }
    }, [projectId, tableName, schema, pageStart, rowsPerPage, sortConfig, fetchWithAuth, onError, fetchCount]);

    useEffect(() => { fetchTableData(); }, [fetchTableData]);

    // --- IMPERATIVE HANDLE ---
    useImperativeHandle(ref, () => ({
        refresh: () => { countFetchedRef.current = false; fetchTableData(); },
        getData: () => tableData,
        getSelectedRows: () => selectedRows,
        getColumns: () => columns,
    }), [fetchTableData, tableData, selectedRows, columns]);

    // --- CLOSE EXPORT MENU ON OUTSIDE CLICK ---
    useEffect(() => {
        if (!showExportMenu) return;
        const handler = (e: MouseEvent) => {
            if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) setShowExportMenu(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [showExportMenu]);

    // --- COLUMN REORDER ---
    const handleColumnDrop = (targetCol: string) => {
        if (!draggingColumn || draggingColumn === targetCol) { setDragOverCol(null); return; }
        const newOrder = [...columnOrder];
        const fromIdx = newOrder.indexOf(draggingColumn);
        const toIdx = newOrder.indexOf(targetCol);
        if (fromIdx === -1 || toIdx === -1) return;
        newOrder.splice(fromIdx, 1);
        newOrder.splice(toIdx, 0, draggingColumn);
        setColumnOrder(newOrder);
        setDraggingColumn(null);
        setDragOverCol(null);
        // Persist
        fetchWithAuth(`/api/data/${projectId}/ui-settings/${tableName}?schema=${schema}`, {
            method: 'PUT',
            body: JSON.stringify({ columns: newOrder.map(n => ({ name: n, width: columnWidths[n] || 200 })) })
        }).catch(() => { });
    };

    // --- CELL UPDATE ---
    const handleUpdateCell = async (row: any, colName: string, newValue: string) => {
        try {
            const payload: any = { [colName]: newValue === '' ? null : newValue };
            await fetchWithAuth(`/api/data/${projectId}/tables/${tableName}/rows`, {
                method: 'PUT',
                body: JSON.stringify({ data: payload, pkColumn: pkCol, pkValue: row[pkCol] })
            });
            setTableData(prev => prev.map(r => r[pkCol] === row[pkCol] ? { ...r, [colName]: newValue } : r));
            setEditingCell(null);
        } catch (e: any) { onError(translateError(e)); }
    };

    // --- OPTIMISTIC INLINE INSERT ---
    const handleInlineSave = async () => {
        setExecuting(true);
        try {
            const payload: any = {};
            columns.forEach(col => {
                const rawVal = inlineNewRow[col.name];
                if (rawVal === '' || rawVal === undefined) {
                    if (col.defaultValue) return;
                    if (col.isNullable) payload[col.name] = null;
                } else {
                    payload[col.name] = rawVal;
                }
            });
            const result = await fetchWithAuth(`/api/data/${projectId}/tables/${tableName}/rows`, {
                method: 'POST', body: JSON.stringify({ data: payload })
            });
            if (Array.isArray(result) && result.length > 0) {
                setTableData(prev => [...prev, ...result]);
                setTotalRows(prev => (prev ?? 0) + result.length);
            }
            onSuccess('Row added.');
            const nextRow: any = {};
            columns.forEach(col => { nextRow[col.name] = ''; });
            setInlineNewRow(nextRow);
            setTimeout(() => firstInputRef.current?.focus(), 100);
        } catch (e: any) { onError(translateError(e)); }
        finally { setExecuting(false); }
    };

    // --- DELETE SELECTED ROWS ---
    const handleDeleteSelected = async () => {
        if (selectedRows.size === 0 || !pkCol) return;
        if (!confirm(`Delete ${selectedRows.size} selected row(s)?`)) return;
        setExecuting(true);
        try {
            const ids = Array.from(selectedRows);
            for (const id of ids) {
                await fetchWithAuth(`/api/data/${projectId}/tables/${tableName}/rows`, {
                    method: 'DELETE',
                    body: JSON.stringify({ pkColumn: pkCol, pkValue: id })
                });
            }
            setTableData(prev => prev.filter(r => !selectedRows.has(r[pkCol])));
            setTotalRows(prev => (prev ?? 0) - ids.length);
            setSelectedRows(new Set());
            onSuccess(`${ids.length} row(s) deleted.`);
        } catch (e: any) { onError(translateError(e)); }
        finally { setExecuting(false); }
    };

    // --- OPEN CELL EDITOR ---
    const openCellEditor = (row: any, colName: string, e: React.MouseEvent) => {
        const td = (e.target as HTMLElement).closest('td');
        if (!td) return;
        const rect = td.getBoundingClientRect();
        setEditingCell({ rowId: row[pkCol], col: colName, rect });
    };

    // --- RENDER ---
    return (
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            {/* TOOLBAR */}
            <div className="px-4 py-2 border-b border-slate-200 bg-white flex items-center justify-between shrink-0 gap-3 flex-wrap">
                <div className="flex items-center gap-3 flex-wrap">
                    <h3 className="text-sm font-black text-slate-900 tracking-tight truncate max-w-[180px]">{tableName}</h3>

                    {/* PAGINATION */}
                    <div className="flex items-center gap-1 bg-slate-50 border border-slate-200 rounded-lg p-0.5 shadow-inner shadow-slate-100/50">
                        <button disabled={pageStart === 0} onClick={() => setPageStart(Math.max(0, pageStart - rowsPerPage))} className="p-1 px-1.5 text-slate-400 hover:text-indigo-600 hover:bg-white rounded shadow-sm disabled:opacity-30 disabled:shadow-none disabled:bg-transparent transition-all"><ChevronLeft size={13} /></button>
                        <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest min-w-[90px] text-center select-none">
                            {tableData.length > 0 ? `${pageStart + 1}–${pageStart + tableData.length}` : '0'}{totalRows != null ? ` / ${totalRows.toLocaleString()}` : ''}
                        </span>
                        <button disabled={tableData.length < rowsPerPage} onClick={() => setPageStart(pageStart + rowsPerPage)} className="p-1 px-1.5 text-slate-400 hover:text-indigo-600 hover:bg-white rounded shadow-sm disabled:opacity-30 disabled:shadow-none disabled:bg-transparent transition-all"><ChevronRight size={13} /></button>
                    </div>

                    {/* PER-PAGE SELECTOR */}
                    <select value={rowsPerPage} onChange={(e: any) => { setRowsPerPage(Number(e.target.value)); setPageStart(0); }} className="text-[9px] font-black text-slate-500 uppercase tracking-widest bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 outline-none cursor-pointer hover:bg-white">
                        {[25, 50, 100, 250, 500].map(n => <option key={n} value={n}>{n} rows</option>)}
                    </select>

                    {/* ROW HEIGHT */}
                    <div className="flex items-center gap-0.5 bg-slate-50 border border-slate-200 rounded-lg p-0.5">
                        <Rows3 size={11} className="text-slate-400 mx-1" />
                        {(['compact', 'normal', 'tall', 'expanded'] as const).map(h => (
                            <button key={h} onClick={() => setRowHeight(h)} title={h} className={`px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-widest transition-all ${rowHeight === h ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-indigo-600 hover:bg-white'}`}>{h[0].toUpperCase()}</button>
                        ))}
                    </div>

                    {isRealtimeActive && <div className="flex items-center gap-1.5 px-2 py-1 bg-amber-50 rounded-full border border-amber-100"><div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></div><span className="text-[9px] font-black text-amber-600 uppercase">Live</span></div>}
                </div>
                <div className="flex items-center gap-2">
                    {/* DELETE SELECTED */}
                    {selectedRows.size > 0 && (
                        <button onClick={handleDeleteSelected} disabled={executing} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-50 text-rose-600 hover:bg-rose-100 text-[10px] font-black uppercase tracking-widest transition-colors border border-rose-200">
                            <Trash2 size={12} /> Delete ({selectedRows.size})
                        </button>
                    )}
                    {/* Export/Import — hidden in compare mode */}
                    {!isCompareMode && onExport && (
                        <div className="relative" ref={exportMenuRef}>
                            <button onClick={(e: any) => { e.stopPropagation(); setShowExportMenu(!showExportMenu); }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-50 text-slate-600 hover:bg-slate-100 text-[10px] font-black uppercase tracking-widest"><Download size={11} /> Export</button>
                            {showExportMenu && (
                                <div className="absolute top-10 right-0 w-48 bg-white rounded-xl shadow-2xl border border-slate-200 z-50 p-1.5 animate-in fade-in zoom-in-95">
                                    {['csv', 'xlsx', 'json', 'sql'].map(fmt => (
                                        <button key={fmt} onClick={() => { onExport(tableName, tableData, fmt); setShowExportMenu(false); }} className="w-full text-left px-3 py-2 hover:bg-slate-50 text-xs font-bold uppercase text-slate-600 rounded-lg flex items-center gap-2">
                                            {fmt === 'xlsx' ? <FileSpreadsheet size={12} /> : fmt === 'json' ? <FileJson size={12} /> : <Code size={12} />} {fmt.toUpperCase()}
                                        </button>
                                    ))}
                                    <div className="h-[1px] bg-slate-100 my-1"></div>
                                    <div className="px-3 py-1.5 text-[9px] font-black text-slate-400 uppercase tracking-widest">PDF Orientation</div>
                                    <button onClick={() => { onExport(tableName, tableData, 'pdf-portrait'); setShowExportMenu(false); }} className="w-full text-left px-3 py-2 hover:bg-slate-50 text-xs font-bold text-slate-600 rounded-lg flex items-center gap-2">
                                        <FileType size={12} /> PDF — Portrait
                                    </button>
                                    <button onClick={() => { onExport(tableName, tableData, 'pdf-landscape'); setShowExportMenu(false); }} className="w-full text-left px-3 py-2 hover:bg-slate-50 text-xs font-bold text-slate-600 rounded-lg flex items-center gap-2">
                                        <FileType size={12} /> PDF — Landscape
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                    {!isCompareMode && onImport && (
                        <button onClick={onImport} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-50 text-slate-600 hover:bg-slate-100 text-[10px] font-black uppercase tracking-widest"><Upload size={11} /> Import</button>
                    )}
                    {isCompareMode && onClose && (
                        <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors" title="Close panel">
                            <X size={14} />
                        </button>
                    )}
                </div>
            </div>

            {/* GRID */}
            <div className="flex-1 overflow-auto relative">
                <table className="border-collapse table-fixed" style={{ minWidth: '100%' }}>
                    <thead className="sticky top-0 bg-white shadow-sm z-20">
                        <tr>
                            <th className="w-12 border-b border-r border-slate-200 bg-slate-50 sticky left-0 z-30">
                                <div className="flex items-center justify-center h-full"><input type="checkbox" onChange={(e: any) => setSelectedRows(e.target.checked ? new Set(tableData.map(r => r[pkCol])) : new Set())} checked={selectedRows.size > 0 && selectedRows.size === tableData.length} className="rounded border-slate-300" /></div>
                            </th>
                            {displayColumns.map((col: any) => (
                                <th
                                    key={col.name}
                                    draggable
                                    onDragStart={(e: any) => { e.stopPropagation(); setDraggingColumn(col.name); }}
                                    onDragOver={(e: any) => { e.preventDefault(); e.stopPropagation(); setDragOverCol(col.name); }}
                                    onDragLeave={() => setDragOverCol(null)}
                                    onDrop={(e: any) => { e.preventDefault(); e.stopPropagation(); handleColumnDrop(col.name); }}
                                    onDragEnd={() => { setDraggingColumn(null); setDragOverCol(null); }}
                                    className={`px-3 py-2.5 text-left border-b border-r border-slate-200 bg-slate-50 relative group select-none cursor-pointer hover:bg-slate-100 overflow-hidden ${dragOverCol === col.name ? 'bg-indigo-100 border-indigo-400' : ''} ${draggingColumn === col.name ? 'opacity-50' : ''}`}
                                    style={{ width: columnWidths[col.name] || 200, minWidth: 0 }}
                                    onClick={() => {
                                        let nextDir: 'asc' | 'desc' | null = 'asc';
                                        if (sortConfig?.column === col.name) {
                                            if (sortConfig.direction === 'asc') nextDir = 'desc';
                                            else nextDir = null;
                                        }
                                        setSortConfig(nextDir ? { column: col.name, direction: nextDir } : null);
                                    }}
                                    onContextMenu={(e: any) => {
                                        e.preventDefault(); e.stopPropagation();
                                        if (onColumnContextMenu) onColumnContextMenu(e.clientX, e.clientY, col.name, tableName);
                                    }}
                                >
                                    <div className="flex items-center gap-1.5">
                                        <GripVertical size={10} className="text-slate-300 opacity-0 group-hover:opacity-60 shrink-0 cursor-grab" />
                                        {col.isPrimaryKey && <Key size={10} className="text-amber-500 shrink-0" />}
                                        <span className="text-[10px] font-black text-slate-700 uppercase tracking-tight truncate flex-1">{col.name}</span>
                                        {sortConfig?.column === col.name && (
                                            <div className="shrink-0">
                                                {sortConfig.direction === 'asc' ? <ChevronUp size={11} className="text-indigo-600" /> : <ChevronDown size={11} className="text-indigo-600" />}
                                            </div>
                                        )}
                                    </div>
                                    {/* Column resize handle */}
                                    <div className="absolute right-0 top-0 w-1.5 h-full cursor-col-resize hover:bg-indigo-400 z-10" onClick={(e: any) => e.stopPropagation()} onMouseDown={(e: any) => {
                                        e.preventDefault();
                                        const startX = e.clientX;
                                        const startWidth = columnWidths[col.name] || 200;
                                        const onMove = (ev: MouseEvent) => setColumnWidths(prev => ({ ...prev, [col.name]: Math.max(30, startWidth + (ev.clientX - startX)) }));
                                        const onUp = () => {
                                            document.removeEventListener('mousemove', onMove);
                                            document.removeEventListener('mouseup', onUp);
                                            setColumnWidths(latest => {
                                                setColumnOrder(order => {
                                                    fetchWithAuth(`/api/data/${projectId}/ui-settings/${tableName}?schema=${schema}`, {
                                                        method: 'PUT',
                                                        body: JSON.stringify({ columns: order.map(n => ({ name: n, width: latest[n] || 200 })) })
                                                    }).catch(() => { });
                                                    return order;
                                                });
                                                return latest;
                                            });
                                        };
                                        document.addEventListener('mousemove', onMove);
                                        document.addEventListener('mouseup', onUp);
                                    }} />
                                </th>
                            ))}
                            {onAddColumn && (
                                <th className="w-14 border-b border-slate-200 bg-slate-50 text-center hover:bg-slate-100 cursor-pointer" onClick={() => onAddColumn(tableName)}>
                                    <Plus size={15} className="mx-auto text-slate-400 hover:text-indigo-600 transition-colors" />
                                </th>
                            )}
                        </tr>

                        {/* INLINE ROW */}
                        <tr className="bg-indigo-50/30 border-b border-indigo-100 group">
                            <td className="p-0 text-center border-r border-slate-200 bg-indigo-50/50 sticky left-0 z-20"><Plus size={13} className="mx-auto text-indigo-400" /></td>
                            {displayColumns.map((col: any, idx) => (
                                <td key={col.name} className="p-0 border-r border-slate-200 relative">
                                    <div className="h-9">
                                        <input
                                            ref={idx === 0 ? firstInputRef : undefined}
                                            value={inlineNewRow[col.name] || ''}
                                            onChange={(e: any) => setInlineNewRow({ ...inlineNewRow, [col.name]: e.target.value })}
                                            className="w-full bg-transparent outline-none text-xs font-medium text-slate-700 h-full px-2 placeholder:text-slate-300"
                                            placeholder={getSmartPlaceholder(col)}
                                            onKeyDown={(e: any) => e.key === 'Enter' && handleInlineSave()}
                                        />
                                    </div>
                                </td>
                            ))}
                            {onAddColumn && (
                                <td className="p-0 text-center bg-indigo-50/50"><button onClick={handleInlineSave} disabled={executing} className="w-full h-full flex items-center justify-center text-indigo-600 hover:bg-indigo-100 transition-colors"><Save size={13} /></button></td>
                            )}
                        </tr>
                    </thead>
                    <tbody className="bg-white">
                        {dataLoading ? (
                            <tr><td colSpan={displayColumns.length + 2} className="py-20 text-center text-slate-400"><Loader2 className="animate-spin mx-auto mb-2" /> Loading data...</td></tr>
                        ) : tableData.length === 0 ? (
                            <tr><td colSpan={displayColumns.length + 2} className="py-16 text-center text-slate-300"><span className="text-xs font-bold uppercase tracking-widest">No rows</span></td></tr>
                        ) : tableData.map((row, rIdx) => (
                            <tr key={rIdx} className={`hover:bg-slate-50 group ${selectedRows.has(row[pkCol]) ? 'bg-indigo-50/50' : ''}`} style={{ height: rowHeightPx[rowHeight] }}>
                                <td className="text-center border-b border-r border-slate-100 sticky left-0 bg-white group-hover:bg-slate-50 z-10">
                                    <input type="checkbox" checked={selectedRows.has(row[pkCol])} onChange={() => { const next = new Set(selectedRows); if (next.has(row[pkCol])) next.delete(row[pkCol]); else next.add(row[pkCol]); setSelectedRows(next); }} className="rounded border-slate-300" />
                                </td>
                                {displayColumns.map((col: any) => (
                                    <td
                                        key={col.name}
                                        onDoubleClick={(e) => openCellEditor(row, col.name, e)}
                                        className={`border-b border-r border-slate-100 px-3 text-xs text-slate-700 font-medium cursor-text ${rowHeight === 'compact' ? 'py-1' : rowHeight === 'tall' ? 'py-3' : rowHeight === 'expanded' ? 'py-3' : 'py-2'}`}
                                        style={{ maxWidth: columnWidths[col.name] || 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: rowHeight === 'expanded' ? 'pre-wrap' : 'nowrap' }}
                                    >
                                        {row[col.name] === null
                                            ? <span className="text-slate-300 italic">null</span>
                                            : String(row[col.name])}
                                    </td>
                                ))}
                                <td className="border-b border-slate-100"></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* PORTAL CELL EDITOR */}
            {editingCell && (() => {
                const row = tableData.find(r => r[pkCol] === editingCell.rowId);
                if (!row) return null;
                return (
                    <CellEditorPortal
                        value={String(row[editingCell.col] ?? '')}
                        rect={editingCell.rect}
                        onSave={(val) => { handleUpdateCell(row, editingCell.col, val); setEditingCell(null); }}
                        onCancel={() => setEditingCell(null)}
                    />
                );
            })()}
        </div>
    );
});

TablePanel.displayName = 'TablePanel';
export default TablePanel;


