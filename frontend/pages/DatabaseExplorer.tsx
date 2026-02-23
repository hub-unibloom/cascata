import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Database, Search, Table as TableIcon, Loader2, AlertCircle, Plus, X,
  Terminal, Trash2, Download, Upload, Copy,
  CheckCircle2, Save, Key, RefreshCw, Puzzle, FileType, FileSpreadsheet, FileJson,
  RotateCcw, GripVertical, MousePointer2, Layers, AlertTriangle, Check, Link as LinkIcon, Code, Eye, Edit
} from 'lucide-react';
import jsPDF from 'jspdf';
import 'jspdf-autotable';

// Import New Modular Components
import ExtensionsModal from '../components/database/ExtensionsModal';
import SqlConsole from '../components/database/SqlConsole';

// Helper Functions
const getUUID = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    try { return crypto.randomUUID(); } catch (e) { /* ignore */ }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

const copyToClipboard = async (text: string) => {
  try { await navigator.clipboard.writeText(text); return true; } catch (err) { return false; }
};

const sanitizeName = (val: string) => {
  return val.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^[0-9]/, "_");
};

const sanitizeForCSV = (value: any) => {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (['=', '+', '-', '@'].includes(str.charAt(0))) return "'" + str;
  return str;
};

const translateError = (err: any) => {
  const msg = err.message || JSON.stringify(err);
  if (msg.includes('22P02')) return "Erro de Tipo: Valor inválido.";
  if (msg.includes('23505')) return "Duplicidade: Chave única violada.";
  if (msg.includes('23502')) return "Campo Obrigatório: Valor nulo não permitido.";
  if (msg.includes('42P01')) return "Tabela não encontrada.";
  if (msg.includes('42601')) return "Erro de Sintaxe SQL.";
  return msg;
};

const getDefaultSuggestions = (type: string) => {
  if (type === 'uuid') return ['gen_random_uuid()'];
  if (type.includes('timestamp') || type.includes('date')) return ['now()', 'current_timestamp'];
  if (type === 'boolean' || type === 'bool') return ['true', 'false'];
  if (type.includes('int') || type.includes('float') || type.includes('numeric')) return ['0', '1'];
  if (type.includes('json')) return ["'{}'::jsonb", "'[]'::jsonb"];
  if (type === 'text' || type === 'varchar') return ["''"];
  return [];
};

// Main Component
const DatabaseExplorer: React.FC<{ projectId: string }> = ({ projectId }) => {
  // --- STATE ---
  const [activeTab, setActiveTab] = useState<'tables' | 'query'>('tables');
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tables, setTables] = useState<any[]>([]);
  const [recycleBin, setRecycleBin] = useState<any[]>([]);
  const [tableData, setTableData] = useState<any[]>([]);
  const [columns, setColumns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(false);
  const [isRealtimeActive, setIsRealtimeActive] = useState(false);

  // UI State
  const [selectedRows, setSelectedRows] = useState<Set<any>>(new Set());
  const [columnOrder, setColumnOrder] = useState<string[]>([]);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [draggingColumn, setDraggingColumn] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);

  // Modals
  const [showExtensions, setShowExtensions] = useState(false);
  const [extensions, setExtensions] = useState<any[]>([]);
  const [extensionLoadingName, setExtensionLoadingName] = useState<string | null>(null);

  // --- RESTORED DRAWER STATE ---
  const [showCreateTable, setShowCreateTable] = useState(false);
  const [newTableName, setNewTableName] = useState('');
  const [newTableDesc, setNewTableDesc] = useState('');
  const [newTableCols, setNewTableCols] = useState<any[]>([
    { id: '1', name: 'id', type: 'uuid', defaultValue: 'gen_random_uuid()', isPrimaryKey: true, isNullable: false, isUnique: true, isArray: false },
    { id: '2', name: 'created_at', type: 'timestamptz', defaultValue: 'now()', isPrimaryKey: false, isNullable: false, isUnique: false, isArray: false },
  ]);
  const [activeFkEditor, setActiveFkEditor] = useState<string | null>(null);
  const [fkTargetColumns, setFkTargetColumns] = useState<string[]>([]);
  const [fkLoading, setFkLoading] = useState(false);

  // --- IMPORT STATE ---
  const [importPendingData, setImportPendingData] = useState<any[] | null>(null);
  const [importPreview, setImportPreview] = useState<any[]>([]);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);

  // Feedback
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  // Editing State
  const [editingCell, setEditingCell] = useState<{ rowId: any, col: string } | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  const [inlineNewRow, setInlineNewRow] = useState<any>({});
  const firstInputRef = useRef<HTMLInputElement>(null);
  const drawerEndRef = useRef<HTMLDivElement>(null);

  // Drag State
  const [draggedTable, setDraggedTable] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, table: string } | null>(null);

  // Refs for Sql Console State Lifting
  const [sqlInitial, setSqlInitial] = useState('');

  const pkCol = columns.find(c => c.isPrimaryKey)?.name || columns[0]?.name;

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

  // --- DATA LOADERS ---
  const fetchTables = async () => {
    try {
      const [data, recycle] = await Promise.all([
        fetchWithAuth(`/api/data/${projectId}/tables`),
        fetchWithAuth(`/api/data/${projectId}/recycle-bin`)
      ]);
      setTables(data);
      setRecycleBin(recycle);
      if (data.length > 0 && !selectedTable) setSelectedTable(data[0].name);
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  };

  const fetchTableData = async (tableName: string, keepSelection = false) => {
    setDataLoading(true);
    if (!keepSelection) setSelectedRows(new Set());
    try {
      const [rows, cols, settings] = await Promise.all([
        fetchWithAuth(`/api/data/${projectId}/tables/${tableName}/data?limit=100`),
        fetchWithAuth(`/api/data/${projectId}/tables/${tableName}/columns`),
        fetchWithAuth(`/api/data/${projectId}/ui-settings/${tableName}`)
      ]);

      setTableData(rows);
      setColumns(cols);

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

      // Reset inline input
      const initialRow: any = {};
      cols.forEach((c: any) => { initialRow[c.name] = ''; });
      setInlineNewRow(initialRow);

    } catch (err: any) { setError(translateError(err)); }
    finally { setDataLoading(false); }
  };

  const fetchExtensions = async () => {
    try {
      const data = await fetchWithAuth(`/api/data/${projectId}/extensions`);
      setExtensions(data);
    } catch (e) { setError("Failed to load extensions"); }
  };

  const installExtension = async (name: string) => {
    setExtensionLoadingName(name);
    try {
      await fetchWithAuth(`/api/data/${projectId}/extensions/install`, {
        method: 'POST',
        body: JSON.stringify({ name })
      });
      await fetchExtensions();
      setSuccessMsg(`Extension "${name}" installed successfully`);
    } catch (e: any) { setError(e.message); }
    finally { setExtensionLoadingName(null); }
  };

  const uninstallExtension = async (name: string) => {
    setExtensionLoadingName(name);
    try {
      await fetchWithAuth(`/api/data/${projectId}/extensions/uninstall`, {
        method: 'POST',
        body: JSON.stringify({ name })
      });
      await fetchExtensions();
      setSuccessMsg(`Extension "${name}" removed`);
    } catch (e: any) { setError(e.message); }
    finally { setExtensionLoadingName(null); }
  };

  // --- EFFECT HOOKS ---
  useEffect(() => { fetchTables(); }, [projectId]);
  useEffect(() => { if (selectedTable && activeTab === 'tables') fetchTableData(selectedTable); }, [selectedTable, activeTab]);
  useEffect(() => { if (showExtensions) fetchExtensions(); }, [showExtensions]);

  // Realtime
  useEffect(() => {
    let eventSource: EventSource | null = null;
    setIsRealtimeActive(false);

    if (projectId) {
      const token = localStorage.getItem('cascata_token');
      const env = localStorage.getItem('cascata_env') || 'live';
      const url = `/api/data/${projectId}/realtime?token=${token}&env=${env}`;

      eventSource = new EventSource(url);
      eventSource.onopen = () => setIsRealtimeActive(true);
      eventSource.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data);
          if (payload.type === 'connected') return;
          if (payload && payload.table === selectedTable) fetchTableData(selectedTable, true);
        } catch (err) { }
      };
      eventSource.onerror = () => { setIsRealtimeActive(false); eventSource?.close(); };
    }
    return () => { if (eventSource) eventSource.close(); };
  }, [projectId, selectedTable]);

  // Sidebar Resizer
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => { if (isResizingSidebar) setSidebarWidth(Math.max(150, Math.min(e.clientX, 600))); };
    const handleMouseUp = () => setIsResizingSidebar(false);
    if (isResizingSidebar) { document.addEventListener('mousemove', handleMouseMove); document.addEventListener('mouseup', handleMouseUp); }
    return () => { document.removeEventListener('mousemove', handleMouseMove); document.removeEventListener('mouseup', handleMouseUp); };
  }, [isResizingSidebar]);

  // --- ACTIONS ---

  const handleUpdateCell = async (row: any, colName: string, newValue: string) => {
    if (!pkCol) return;
    try {
      const payload = { [colName]: newValue === '' ? null : newValue };
      await fetchWithAuth(`/api/data/${projectId}/tables/${selectedTable}/rows`, {
        method: 'PUT',
        body: JSON.stringify({ data: payload, pkColumn: pkCol, pkValue: row[pkCol] })
      });
      const updatedData = tableData.map(r => r[pkCol] === row[pkCol] ? { ...r, [colName]: newValue } : r);
      setTableData(updatedData);
      setEditingCell(null);
    } catch (e: any) { setError(translateError(e)); }
  };

  const handleInlineSave = async () => {
    setExecuting(true);
    try {
      const payload: any = {};
      columns.forEach(col => {
        const rawVal = inlineNewRow[col.name];
        if (rawVal === '' || rawVal === undefined) {
          if (col.defaultValue) return; // Skip for DB default
          if (col.isNullable) payload[col.name] = null;
        } else {
          payload[col.name] = rawVal;
        }
      });
      await fetchWithAuth(`/api/data/${projectId}/tables/${selectedTable}/rows`, { method: 'POST', body: JSON.stringify({ data: payload }) });
      setSuccessMsg('Row added.');
      fetchTableData(selectedTable!);
      // Reset
      const nextRow: any = {};
      columns.forEach(col => { nextRow[col.name] = ''; });
      setInlineNewRow(nextRow);
      setTimeout(() => firstInputRef.current?.focus(), 100);
    } catch (e: any) { setError(translateError(e)); }
    finally { setExecuting(false); }
  };

  const handleFixSql = async (sql: string, errorMsg: string) => {
    try {
      const res = await fetchWithAuth(`/api/data/${projectId}/ai/fix-sql`, {
        method: 'POST',
        body: JSON.stringify({ sql, error: errorMsg })
      });
      if (res.fixed_sql) return res.fixed_sql;
    } catch (e) { console.error(e); }
    return null;
  };

  const handleExecuteSql = async (sql: string) => {
    return await fetchWithAuth(`/api/data/${projectId}/query`, {
      method: 'POST',
      body: JSON.stringify({ sql })
    });
  };

  const handleRenameTable = async (oldName: string) => {
    const newName = prompt("Rename table to:", oldName);
    if (!newName || newName === oldName) return;
    try {
      await fetchWithAuth(`/api/data/${projectId}/query`, {
        method: 'POST',
        body: JSON.stringify({ sql: `ALTER TABLE "${oldName}" RENAME TO "${sanitizeName(newName)}"` })
      });
      setSuccessMsg(`Renamed to ${newName}`);
      fetchTables();
      if (selectedTable === oldName) setSelectedTable(sanitizeName(newName));
    } catch (e: any) { setError(e.message); }
  };

  const handleDuplicateTable = async (source: string) => {
    try {
      const newName = `${source}_copy_${Date.now().toString().slice(-4)}`;
      await fetchWithAuth(`/api/data/${projectId}/query`, {
        method: 'POST',
        body: JSON.stringify({ sql: `CREATE TABLE "${newName}" AS TABLE "${source}" WITH NO DATA;` })
      });
      setSuccessMsg(`Duplicated to ${newName}`);
      fetchTables();
    } catch (e: any) { setError(e.message); }
  };

  const handleDeleteTable = async (tableName: string) => {
    if (!confirm(`Are you sure you want to delete ${tableName}?`)) return;
    try {
      await fetchWithAuth(`/api/data/${projectId}/tables/${tableName}`, {
        method: 'DELETE',
        body: JSON.stringify({ mode: 'SOFT' })
      });
      setSuccessMsg("Moved to Recycle Bin");
      fetchTables();
      if (selectedTable === tableName) setSelectedTable(null);
    } catch (e: any) { setError(e.message); }
  };

  const handleCopyStructure = async (tableName: string) => {
    try {
      const cols = await fetchWithAuth(`/api/data/${projectId}/tables/${tableName}/columns`);
      const sql = `CREATE TABLE "${tableName}" (\n${cols.map((c: any) => `  "${c.name}" ${c.type}`).join(',\n')}\n);`;
      copyToClipboard(sql);
      setSuccessMsg("SQL Copied");
    } catch (e) { }
  };

  // --- RESTORED DRAWER HELPERS ---
  const handleAddColumnItem = () => {
    const newId = getUUID();
    setNewTableCols([...newTableCols, { id: newId, name: '', type: 'text', defaultValue: '', isPrimaryKey: false, isNullable: true, isUnique: false, isArray: false }]);
    setTimeout(() => drawerEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
  };

  const handleRemoveColumnItem = (id: string) => setNewTableCols(newTableCols.filter(c => c.id !== id));

  const handleColumnChange = (id: string, field: string, value: any) => {
    setNewTableCols(newTableCols.map(c => c.id === id ? { ...c, [field]: value } : c));
  };

  const handleSetForeignKey = async (id: string, table: string, column: string) => {
    setNewTableCols(newTableCols.map(c => c.id === id ? { ...c, foreignKey: table ? { table, column: column || '' } : undefined } : c));
    if (table) {
      setFkLoading(true);
      try {
        const res = await fetchWithAuth(`/api/data/${projectId}/tables/${table}/columns`);
        setFkTargetColumns(res.map((c: any) => c.name));
      } catch (e) { } finally { setFkLoading(false); }
    }
  };

  const handleCreateTable = async () => {
    if (!newTableName) { setError("Table name required"); return; }
    try {
      const safeName = sanitizeName(newTableName);
      const colDefs = newTableCols.map(c => {
        const type = c.isArray ? `${c.type}[]` : c.type;
        let def = `"${sanitizeName(c.name)}" ${type}`;
        if (c.isPrimaryKey) def += ' PRIMARY KEY';
        if (!c.isNullable && !c.isPrimaryKey) def += ' NOT NULL';
        if (c.defaultValue) def += ` DEFAULT ${c.defaultValue}`;
        if (c.isUnique && !c.isPrimaryKey) def += ' UNIQUE';
        if (c.foreignKey) def += ` REFERENCES public."${c.foreignKey.table}"("${c.foreignKey.column}")`;
        return def;
      }).join(',\n  ');

      let sql = `CREATE TABLE public."${safeName}" (\n  ${colDefs}\n);`;
      sql += `\nALTER TABLE public."${safeName}" ENABLE ROW LEVEL SECURITY;`;

      setSqlInitial(sql);
      setActiveTab('query');
      setShowCreateTable(false);
      setSuccessMsg("SQL generated in Console");
    } catch (e: any) { setError(e.message); }
  };

  // --- RENDER HELPERS ---
  const displayColumns = columnOrder.length > 0 ? columnOrder.map(name => columns.find(c => c.name === name)).filter(Boolean) : columns;

  const renderSidebar = () => (
    <aside className="bg-white border-r border-slate-200 flex flex-col shrink-0 relative z-10" style={{ width: sidebarWidth }}>
      <div className="p-6 border-b border-slate-100 bg-white sticky top-0 z-10">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo-200">
              <Database size={20} />
            </div>
            <h2 className="text-lg font-black text-slate-900 tracking-tight">Explorer</h2>
          </div>
          <button onClick={() => setShowExtensions(true)} className="p-2 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-purple-600 transition-colors" title="Manage Extensions">
            <Puzzle size={20} />
          </button>
        </div>

        <div className="relative group">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
          <input placeholder="Search tables..." className="w-full bg-slate-50 border border-slate-100 rounded-xl pl-10 pr-4 py-3 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-500/20" />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-1 custom-scrollbar">
        <div className="flex items-center justify-between mb-4 px-2">
          <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest">Public Tables</h2>
          <div className="flex gap-1">
            <button onClick={fetchTables} className="p-1 hover:bg-slate-100 rounded text-slate-400 hover:text-indigo-600"><RefreshCw size={14} /></button>
            <button onClick={() => setShowCreateTable(true)} className="p-1 hover:bg-slate-100 rounded text-slate-400 hover:text-indigo-600"><Plus size={14} /></button>
          </div>
        </div>

        {tables.map(table => (
          <div
            key={table.name}
            onClick={() => { setActiveTab('tables'); setSelectedTable(table.name); }}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, table: table.name }); }}
            className={`
                          group flex items-center justify-between px-3 py-2.5 rounded-xl cursor-pointer transition-all border border-transparent
                          ${selectedTable === table.name && activeTab === 'tables' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200' : 'text-slate-600 hover:bg-slate-50'}
                      `}
          >
            <div className="flex items-center gap-3 overflow-hidden">
              <TableIcon size={16} className={selectedTable === table.name && activeTab === 'tables' ? 'text-white' : 'text-slate-400'} />
              <span className="font-bold text-xs truncate">{table.name}</span>
            </div>
          </div>
        ))}

        {recycleBin.length > 0 && (
          <div className="mt-8 pt-4 border-t border-slate-100">
            <button className="w-full flex items-center gap-3 px-3 py-2 text-xs font-bold text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-xl transition-all">
              <Trash2 size={16} /> Recycle Bin ({recycleBin.length})
            </button>
          </div>
        )}
      </div>

      <div className="p-4 border-t border-slate-100 bg-slate-50">
        <button
          onClick={() => setActiveTab(activeTab === 'query' ? 'tables' : 'query')}
          className={`w-full py-3 rounded-xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-2 transition-all ${activeTab === 'query' ? 'bg-slate-900 text-white shadow-xl' : 'bg-white border border-slate-200 text-slate-600 hover:border-slate-300'}`}
        >
          <Terminal size={14} /> SQL Editor
        </button>
      </div>
      <div className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-indigo-500 transition-colors z-20" onMouseDown={() => setIsResizingSidebar(true)} />
    </aside>
  );

  const getSmartPlaceholder = (col: any) => {
    if (col.defaultValue && col.defaultValue.includes('gen_random_uuid')) return 'UUID (Auto)';
    if (col.defaultValue && col.defaultValue.includes('now()')) return 'Now()';
    return col.type;
  };

  return (
    <div className="flex h-full bg-[#F8FAFC] text-slate-900 overflow-hidden font-sans">

      {/* Notifications */}
      {(successMsg || error) && (
        <div className={`fixed top-8 left-1/2 -translate-x-1/2 z-[100] px-6 py-4 rounded-full shadow-2xl flex items-center gap-3 animate-in slide-in-from-top-4 ${error ? 'bg-rose-600 text-white' : 'bg-emerald-600 text-white'}`}>
          {error ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
          <span className="text-xs font-bold">{error || successMsg}</span>
          <button onClick={() => { setError(null); setSuccessMsg(null); }} className="ml-2 opacity-60 hover:opacity-100"><X size={14} /></button>
        </div>
      )}

      {renderSidebar()}

      <main className="flex-1 overflow-hidden relative flex flex-col bg-white">
        {activeTab === 'tables' && selectedTable ? (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* TOOLBAR */}
            <div className="px-8 py-4 border-b border-slate-200 bg-white flex items-center justify-between shrink-0">
              <div className="flex items-center gap-6">
                <h3 className="text-xl font-black text-slate-900 tracking-tight">{selectedTable}</h3>
                <span className="text-xs font-bold text-slate-400">{tableData.length} records</span>
                {isRealtimeActive && <div className="flex items-center gap-1.5 px-2 py-1 bg-amber-50 rounded-full border border-amber-100"><div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></div><span className="text-[9px] font-black text-amber-600 uppercase">Live</span></div>}
              </div>
              <div className="flex items-center gap-3">
                <button className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-50 text-slate-600 hover:bg-slate-100 text-[10px] font-black uppercase tracking-widest"><Download size={12} /> Export</button>
                <button onClick={() => setShowImportModal(true)} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-50 text-slate-600 hover:bg-slate-100 text-[10px] font-black uppercase tracking-widest"><Upload size={12} /> Import</button>
              </div>
            </div>

            {/* GRID */}
            <div className="flex-1 overflow-auto relative">
              <table className="border-collapse table-fixed" style={{ minWidth: '100%' }}>
                <thead className="sticky top-0 bg-white shadow-sm z-20">
                  <tr>
                    <th className="w-12 border-b border-r border-slate-200 bg-slate-50 sticky left-0 z-30">
                      <div className="flex items-center justify-center h-full"><input type="checkbox" onChange={(e) => setSelectedRows(e.target.checked ? new Set(tableData.map(r => r[pkCol])) : new Set())} checked={selectedRows.size > 0 && selectedRows.size === tableData.length} className="rounded border-slate-300" /></div>
                    </th>
                    {displayColumns.map((col: any) => (
                      <th
                        key={col.name}
                        className="px-4 py-3 text-left border-b border-r border-slate-200 bg-slate-50 relative group select-none"
                        style={{ width: columnWidths[col.name] || 200 }}
                      >
                        <div className="flex items-center gap-2">
                          {col.isPrimaryKey && <Key size={10} className="text-amber-500" />}
                          <span className="text-[10px] font-black text-slate-700 uppercase tracking-tight truncate">{col.name}</span>
                        </div>
                        <div className="absolute right-0 top-0 w-1 h-full cursor-col-resize hover:bg-indigo-400 z-10" onMouseDown={(e) => {
                          e.preventDefault();
                          const startX = e.clientX;
                          const startWidth = columnWidths[col.name] || 200;
                          const onMove = (ev: MouseEvent) => setColumnWidths(prev => ({ ...prev, [col.name]: Math.max(10, startWidth + (ev.clientX - startX)) }));
                          const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
                          document.addEventListener('mousemove', onMove);
                          document.addEventListener('mouseup', onUp);
                        }} />
                      </th>
                    ))}
                    <th className="w-16 border-b border-slate-200 bg-slate-50 text-center hover:bg-slate-100 cursor-pointer">
                      <Plus size={16} className="mx-auto text-slate-400" />
                    </th>
                  </tr>

                  {/* INLINE ROW */}
                  <tr className="bg-indigo-50/30 border-b border-indigo-100 group">
                    <td className="p-0 text-center border-r border-slate-200 bg-indigo-50/50 sticky left-0 z-20"><Plus size={14} className="mx-auto text-indigo-400" /></td>
                    {displayColumns.map((col: any, idx) => (
                      <td key={col.name} className="p-0 border-r border-slate-200 relative">
                        <div className="h-10">
                          <input
                            ref={idx === 0 ? firstInputRef : undefined}
                            value={inlineNewRow[col.name]}
                            onChange={(e) => setInlineNewRow({ ...inlineNewRow, [col.name]: e.target.value })}
                            className="w-full bg-transparent outline-none text-xs font-medium text-slate-700 h-full px-2 placeholder:text-slate-300"
                            placeholder={getSmartPlaceholder(col)}
                            onKeyDown={(e) => e.key === 'Enter' && handleInlineSave()}
                          />
                        </div>
                      </td>
                    ))}
                    <td className="p-0 text-center bg-indigo-50/50"><button onClick={handleInlineSave} className="w-full h-full flex items-center justify-center text-indigo-600 hover:bg-indigo-100 transition-colors"><Save size={14} /></button></td>
                  </tr>
                </thead>
                <tbody className="bg-white">
                  {dataLoading ? (
                    <tr><td colSpan={displayColumns.length + 2} className="py-20 text-center text-slate-400"><Loader2 className="animate-spin mx-auto mb-2" /> Loading data...</td></tr>
                  ) : tableData.map((row, rIdx) => (
                    <tr key={rIdx} className={`hover:bg-slate-50 group ${selectedRows.has(row[pkCol]) ? 'bg-indigo-50/50' : ''}`}>
                      <td className="text-center border-b border-r border-slate-100 sticky left-0 bg-white group-hover:bg-slate-50 z-10"><input type="checkbox" checked={selectedRows.has(row[pkCol])} onChange={() => { const next = new Set(selectedRows); if (next.has(row[pkCol])) next.delete(row[pkCol]); else next.add(row[pkCol]); setSelectedRows(next); }} className="rounded border-slate-300" /></td>
                      {displayColumns.map((col: any) => {
                        const isEditing = editingCell?.rowId === row[pkCol] && editingCell?.col === col.name;
                        return (
                          <td key={col.name} onDoubleClick={() => { setEditingCell({ rowId: row[pkCol], col: col.name }); setEditValue(String(row[col.name])); }} className="border-b border-r border-slate-100 px-4 py-2.5 text-xs text-slate-700 font-medium truncate cursor-text relative">
                            {isEditing ? <input autoFocus value={editValue} onChange={(e) => setEditValue(e.target.value)} onBlur={() => handleUpdateCell(row, col.name, editValue)} onKeyDown={(e) => e.key === 'Enter' && handleUpdateCell(row, col.name, editValue)} className="absolute inset-0 w-full h-full px-4 bg-white outline-none border-2 border-indigo-500 shadow-lg z-10" /> : (row[col.name] === null ? <span className="text-slate-300 italic">null</span> : String(row[col.name]))}
                          </td>
                        );
                      })}
                      <td className="border-b border-slate-100"></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : activeTab === 'query' ? (
          <SqlConsole onExecute={handleExecuteSql} onFix={handleFixSql} initialQuery={sqlInitial} />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-300">
            <Database size={64} className="mb-4 opacity-20" />
            <span className="font-bold uppercase tracking-widest text-xs">Select a table</span>
          </div>
        )}
      </main>

      {/* RESTORED DRAWER: CREATE TABLE */}
      <div className={`fixed inset-y-0 right-0 w-[500px] bg-white shadow-2xl z-[100] transform transition-transform duration-300 ease-in-out flex flex-col border-l border-slate-200 ${showCreateTable ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div><h3 className="text-xl font-black text-slate-900 tracking-tight">Create New Table</h3><p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Schema Designer</p></div>
          <button onClick={() => setShowCreateTable(false)} className="p-2 hover:bg-slate-200 rounded-lg text-slate-400"><X size={20} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          <div className="space-y-4">
            <div className="space-y-2"><label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Table Name</label><input autoFocus value={newTableName} onChange={(e) => setNewTableName(sanitizeName(e.target.value))} placeholder="public.users" className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 px-4 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-500/20" /></div>
            <div className="space-y-2"><label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Description (for AI)</label><input value={newTableDesc} onChange={(e) => setNewTableDesc(e.target.value)} placeholder="e.g. Stores registered users." className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 px-4 text-sm font-medium outline-none focus:ring-2 focus:ring-indigo-500/20 text-slate-600" /></div>
          </div>
          <div className="space-y-4">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Column Definitions</label>
            <div className="space-y-3" ref={drawerEndRef}>
              {newTableCols.map((col, idx) => (
                <div key={col.id} className="bg-white border border-slate-200 rounded-xl p-3 shadow-sm hover:shadow-md transition-all group relative">
                  <div className="flex gap-3 mb-3">
                    <input
                      value={col.name}
                      onChange={(e) => handleColumnChange(col.id, 'name', sanitizeName(e.target.value))}
                      placeholder="column_name"
                      className="flex-[2] bg-slate-50 border-none rounded-lg px-3 py-2 text-xs font-bold outline-none"
                    />
                    <select value={col.type} onChange={(e) => handleColumnChange(col.id, 'type', e.target.value)} className="flex-1 bg-slate-100 border-none rounded-lg px-2 py-2 text-[10px] font-black uppercase text-slate-600 outline-none cursor-pointer">
                      <optgroup label="Numbers"><option value="int8">int8 (BigInt)</option><option value="int4">int4 (Integer)</option><option value="numeric">numeric</option><option value="float8">float8</option></optgroup>
                      <optgroup label="Text"><option value="text">text</option><option value="varchar">varchar</option><option value="uuid">uuid</option></optgroup>
                      <optgroup label="Date/Time"><option value="timestamptz">timestamptz</option><option value="date">date</option><option value="time">time</option></optgroup>
                      <optgroup label="JSON"><option value="jsonb">jsonb</option><option value="json">json</option></optgroup>
                      <optgroup label="Other"><option value="bool">boolean</option><option value="bytea">bytea</option><option value="vector">vector (Embedding)</option></optgroup>
                    </select>
                    <button onClick={() => handleRemoveColumnItem(col.id)} className="p-2 text-slate-300 hover:text-rose-500 transition-colors"><X size={14} /></button>
                  </div>
                  <div className="flex items-center gap-3 bg-slate-50 p-2 rounded-lg relative">
                    <input list={`defaults-${col.id}`} value={col.defaultValue} onChange={(e) => handleColumnChange(col.id, 'defaultValue', e.target.value)} placeholder="Default Value (NULL)" className="flex-1 bg-transparent border-none text-[10px] font-mono text-slate-600 outline-none placeholder:text-slate-300" />
                    <datalist id={`defaults-${col.id}`}>{getDefaultSuggestions(col.type).map(s => <option key={s} value={s} />)}</datalist>
                    <div className="h-4 w-[1px] bg-slate-200"></div>
                    <div className="flex items-center gap-2">
                      <div title="Primary Key" onClick={() => handleColumnChange(col.id, 'isPrimaryKey', !col.isPrimaryKey)} className={`px-1.5 py-1 rounded text-[9px] font-black cursor-pointer select-none transition-colors ${col.isPrimaryKey ? 'bg-amber-100 text-amber-700' : 'text-slate-300 hover:bg-slate-200'}`}>PK</div>
                      <div title="Foreign Key" onClick={(e) => { e.stopPropagation(); setActiveFkEditor(activeFkEditor === col.id ? null : col.id); }} className={`px-1.5 py-1 rounded cursor-pointer select-none transition-colors flex items-center ${col.foreignKey ? 'bg-blue-100 text-blue-700' : 'text-slate-300 hover:bg-slate-200'}`}><LinkIcon size={12} strokeWidth={4} /></div>
                      <div title="Array" onClick={() => handleColumnChange(col.id, 'isArray', !col.isArray)} className={`px-1.5 py-1 rounded text-[9px] font-black cursor-pointer select-none transition-colors ${col.isArray ? 'bg-indigo-100 text-indigo-700' : 'text-slate-300 hover:bg-slate-200'}`}>LIST</div>
                      <div title="Nullable" onClick={() => handleColumnChange(col.id, 'isNullable', !col.isNullable)} className={`px-1.5 py-1 rounded text-[9px] font-black cursor-pointer select-none transition-colors ${col.isNullable ? 'bg-emerald-100 text-emerald-700' : 'text-slate-300 hover:bg-slate-200'}`}>NULL</div>
                      <div title="Unique" onClick={() => handleColumnChange(col.id, 'isUnique', !col.isUnique)} className={`px-1.5 py-1 rounded text-[9px] font-black cursor-pointer select-none transition-colors ${col.isUnique ? 'bg-purple-100 text-purple-700' : 'text-slate-300 hover:bg-slate-200'}`}>UNIQ</div>
                    </div>
                  </div>
                  {/* FK EDITOR */}
                  {activeFkEditor === col.id && (
                    <div onClick={(e) => e.stopPropagation()} className="absolute z-50 top-full right-0 mt-2 w-64 bg-white border border-slate-200 shadow-xl rounded-xl p-4 animate-in fade-in zoom-in-95">
                      <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Link to Table</h4>
                      <div className="space-y-3">
                        <select value={col.foreignKey?.table || ''} onChange={(e) => handleSetForeignKey(col.id, e.target.value, '')} className="w-full bg-slate-50 border border-slate-200 rounded-lg py-2 px-3 text-xs font-bold text-slate-700 outline-none"><option value="">Select Target Table...</option>{tables.filter(t => t.name !== newTableName).map(t => (<option key={t.name} value={t.name}>{t.name}</option>))}</select>
                        {col.foreignKey?.table && (<div className="flex items-center gap-2"><span className="text-xs text-slate-400">Column:</span>{fkLoading ? <Loader2 size={12} className="animate-spin text-indigo-500" /> : (<select value={col.foreignKey.column} onChange={(e) => handleSetForeignKey(col.id, col.foreignKey!.table, e.target.value)} className="flex-1 bg-slate-50 border-none rounded-lg py-1 px-2 text-xs font-mono font-bold outline-none"><option value="">Select Column...</option>{fkTargetColumns.map(c => <option key={c} value={c}>{c}</option>)}</select>)}</div>)}
                        <div className="flex justify-end pt-2"><button onClick={() => { handleSetForeignKey(col.id, '', ''); setActiveFkEditor(null); }} className="text-[10px] font-bold text-rose-500 hover:underline">Remove Link</button></div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <button onClick={handleAddColumnItem} className="w-full py-3 border border-dashed border-slate-300 rounded-xl text-slate-400 text-xs font-bold hover:bg-slate-50 hover:text-indigo-600 hover:border-indigo-300 transition-all flex items-center justify-center gap-2"><Plus size={14} /> Add Column</button>
          </div>
        </div>
        <div className="p-6 border-t border-slate-100 bg-slate-50/50 flex gap-4">
          <button onClick={() => setShowCreateTable(false)} className="flex-1 py-3 text-xs font-black text-slate-400 uppercase tracking-widest hover:text-slate-600">Cancel</button>
          <button onClick={handleCreateTable} className="flex-[2] bg-indigo-600 text-white py-3 rounded-xl text-xs font-black uppercase tracking-widest shadow-xl hover:bg-indigo-700 transition-all flex items-center justify-center gap-2">Generate SQL</button>
        </div>
      </div>

      {/* IMPORT MODAL */}
      {showImportModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[250] flex items-center justify-center p-8 animate-in zoom-in-95">
          <div className="bg-white rounded-[3.5rem] w-full max-w-lg p-12 shadow-2xl border border-slate-100 relative">
            <button onClick={() => setShowImportModal(false)} className="absolute top-8 right-8 text-slate-300 hover:text-slate-900 transition-colors"><X size={24} /></button>
            <h3 className="text-3xl font-black text-slate-900 tracking-tighter mb-8">Data Import</h3>
            <div className="space-y-6">
              <div className="border-4 border-dashed border-slate-100 rounded-[2.5rem] p-10 text-center hover:border-emerald-300 hover:bg-emerald-50/10 transition-all cursor-pointer relative group">
                <input type="file" accept=".csv, .xlsx, .json" onChange={(e) => setImportFile(e.target.files?.[0] || null)} className="absolute inset-0 opacity-0 cursor-pointer" />
                {importFile ? <span className="font-bold text-slate-900">{importFile.name}</span> : <div className="flex flex-col items-center text-slate-300 group-hover:text-emerald-500"><Upload size={40} className="mb-2" /><span className="font-bold text-sm">Drop file here</span></div>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* EXTENSIONS MODAL */}
      <ExtensionsModal
        isOpen={showExtensions}
        onClose={() => setShowExtensions(false)}
        installedExtensions={extensions}
        onInstall={installExtension}
        onUninstall={uninstallExtension}
        loadingName={extensionLoadingName}
      />

      {/* CONTEXT MENU */}
      {contextMenu && (
        <div className="fixed z-[100] bg-white border border-slate-200 shadow-2xl rounded-2xl p-2 w-56 animate-in fade-in zoom-in-95" style={{ top: contextMenu.y, left: contextMenu.x }}>
          <button onClick={() => { handleRenameTable(contextMenu.table); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl transition-all"><Edit size={14} /> Rename</button>
          <button onClick={() => { handleDuplicateTable(contextMenu.table); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl transition-all"><Layers size={14} /> Duplicate</button>
          <button onClick={() => { handleCopyStructure(contextMenu.table); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl transition-all"><Code size={14} /> Copy SQL</button>
          <div className="h-[1px] bg-slate-100 my-1"></div>
          <button onClick={() => { handleDeleteTable(contextMenu.table); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-rose-600 hover:bg-rose-50 rounded-xl transition-all"><Trash2 size={14} /> Delete Table</button>
        </div>
      )}

    </div>
  );
};

export default DatabaseExplorer;