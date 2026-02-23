
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { 
  Database, Search, Play, Table as TableIcon, Loader2, AlertCircle, Plus, X, 
  Terminal, Code, Trash2, Download, Upload, MoreHorizontal, Copy, Edit, 
  CheckSquare, Square, CheckCircle2, Calendar, Wand2, Lock, User, 
  FileJson, FileSpreadsheet, RefreshCw, Archive, RotateCcw, GripVertical, 
  Save, ArrowRight, Key, Image as ImageIcon, Link as LinkIcon, File as FileIcon, 
  ChevronDown, Check, MoreVertical, Layers, MousePointer2, Settings, List, 
  MessageSquare, RefreshCcw as RefreshIcon, FileType, Shield, Eye, AlertTriangle, Sparkles,
  History, CornerDownRight
} from 'lucide-react';
import jsPDF from 'jspdf';
import 'jspdf-autotable';

declare global {
  interface Window { XLSX: any; }
}

const getUUID = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    try { return crypto.randomUUID(); } catch(e) { /* ignore */ }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

// Clipboard Helper
const copyToClipboard = async (text: string) => {
  if (!navigator.clipboard) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
      return true;
    } catch (err) {
      return false;
    } finally {
      document.body.removeChild(textArea);
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    return false;
  }
};

const sanitizeName = (val: string) => {
    return val
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // Remove accents
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[0-9]/, "_");
};

// Security: Prevent CSV Injection
const sanitizeForCSV = (value: any) => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (['=', '+', '-', '@'].includes(str.charAt(0))) return "'" + str;
    return str;
};

// Human Readable Error Mapper
const translateError = (err: any) => {
    const msg = err.message || JSON.stringify(err);
    if (msg.includes('22P02')) return "Erro de Tipo: Você tentou inserir um texto num campo numérico ou data inválida.";
    if (msg.includes('23505')) return "Duplicidade: Este registro já existe (Violação de chave única).";
    if (msg.includes('23502')) return "Campo Obrigatório: Um campo não pode ser vazio (NOT NULL).";
    if (msg.includes('42P01')) return "Tabela não encontrada. Tente atualizar a página.";
    if (msg.includes('42601')) return "Erro de Sintaxe SQL. Verifique o comando.";
    return msg; // Fallback
};

interface ColumnDef {
  id: string; 
  name: string;
  type: string;
  defaultValue: string;
  isPrimaryKey: boolean;
  isNullable: boolean;
  isUnique: boolean;
  isArray: boolean;
  description?: string; 
  foreignKey?: { table: string, column: string };
  sourceHeader?: string; 
}

const DatabaseExplorer: React.FC<{ projectId: string }> = ({ projectId }) => {
  // --- STATE ---
  const [activeTab, setActiveTab] = useState<'tables' | 'query' | 'recycle'>('tables');
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tables, setTables] = useState<any[]>([]);
  const [recycleBin, setRecycleBin] = useState<any[]>([]);
  const [tableData, setTableData] = useState<any[]>([]);
  const [columns, setColumns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(false);
  const [authLinkedTable, setAuthLinkedTable] = useState<string | null>(null);
  const [projectMetadata, setProjectMetadata] = useState<any>({});
  const [isRealtimeActive, setIsRealtimeActive] = useState(false);
  
  // --- STATE: MULTI-SELECT & GRID ---
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [selectedRows, setSelectedRows] = useState<Set<any>>(new Set());
  const [columnOrder, setColumnOrder] = useState<string[]>([]);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [draggingColumn, setDraggingColumn] = useState<string | null>(null);

  // --- STATE: RESIZABLE SIDEBAR ---
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);

  // --- STATE: SQL TERMINAL ---
  const [query, setQuery] = useState('');
  const [queryResult, setQueryResult] = useState<any>(null);
  const [queryHistory, setQueryHistory] = useState<string[]>([]);
  
  // --- STATE: UI & MODALS ---
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [isFixingSql, setIsFixingSql] = useState(false);
  
  // TABLE CREATOR DRAWER STATE
  const [showCreateTable, setShowCreateTable] = useState(false);
  const [newTableName, setNewTableName] = useState('');
  const [newTableDesc, setNewTableDesc] = useState('');
  const [newTableCols, setNewTableCols] = useState<ColumnDef[]>([
    { id: '1', name: 'id', type: 'uuid', defaultValue: 'gen_random_uuid()', isPrimaryKey: true, isNullable: false, isUnique: true, isArray: false, description: 'Unique Identifier' },
    { id: '2', name: 'created_at', type: 'timestamptz', defaultValue: 'now()', isPrimaryKey: false, isNullable: false, isUnique: false, isArray: false, description: 'Creation Timestamp' },
  ]);
  const [activeFkEditor, setActiveFkEditor] = useState<string | null>(null);
  const [fkTargetColumns, setFkTargetColumns] = useState<string[]>([]);
  const [fkLoading, setFkLoading] = useState(false);

  // IMPORT STATE
  const [importPendingData, setImportPendingData] = useState<any[] | null>(null);
  const [importPreview, setImportPreview] = useState<any[]>([]);

  const [showImportModal, setShowImportModal] = useState(false);
  const [showTrashModal, setShowTrashModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState<{ active: boolean, table: string, mode: 'SOFT' | 'HARD' }>({ active: false, table: '', mode: 'SOFT' });
  const [verifyPassword, setVerifyPassword] = useState('');
  
  // --- NEW: DUPLICATE MODAL ---
  const [showDuplicateModal, setShowDuplicateModal] = useState(false);
  const [duplicateConfig, setDuplicateConfig] = useState({ source: '', newName: '', withData: false });

  // --- NEW: EXPORT MENU ---
  const [showExportMenu, setShowExportMenu] = useState(false);

  // --- NEW: ADD COLUMN MODAL (ENHANCED) ---
  const [showAddColumn, setShowAddColumn] = useState(false);
  const [newColumn, setNewColumn] = useState<{ 
    name: string; 
    type: string; 
    isNullable: boolean; 
    defaultValue: string; 
    isUnique: boolean; 
    description: string;
    foreignKey?: { table: string, column: string };
  }>({ 
    name: '', 
    type: 'text', 
    isNullable: true, 
    defaultValue: '', 
    isUnique: false, 
    description: '' 
  });

  // --- STATE: INLINE EDITING & CREATION ---
  const [inlineNewRow, setInlineNewRow] = useState<any>({});
  const [editingCell, setEditingCell] = useState<{rowId: any, col: string} | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  const firstInputRef = useRef<HTMLInputElement>(null);

  // --- STATE: CONTEXT MENUS & DRAG ---
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, table: string } | null>(null);
  const [draggedTable, setDraggedTable] = useState<string | null>(null);

  // --- STATE: IMPORT FILE ---
  const [importFile, setImportFile] = useState<File | null>(null);
  const [createTableFromImport, setCreateTableFromImport] = useState(false);
  
  // --- REFS FOR UX IMPROVEMENTS ---
  const drawerEndRef = useRef<HTMLDivElement>(null);
  const columnInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  // --- COMPUTED ---
  const pkCol = columns.find(c => c.isPrimaryKey)?.name || columns[0]?.name;

  // --- HELPER: SANITIZATION & INFERENCE ---
  const getDefaultSuggestions = (type: string) => {
      const t = type.toLowerCase();
      if (t.includes('timestamp') || t.includes('date')) return ['now()', "timezone('utc', now())", 'current_date'];
      if (t === 'uuid') return ['gen_random_uuid()'];
      if (t.includes('bool')) return ['true', 'false'];
      if (t.includes('int') || t.includes('numeric')) return ['0', '1'];
      if (t.includes('json')) return ["'{}'::jsonb", "'[]'::jsonb"];
      return [];
  };

  const inferType = (values: any[]): string => {
    let isInt = true;
    let isFloat = true;
    let isBool = true;
    let isDate = true;
    let isUuid = true;
    let hasData = false;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    for (const v of values) {
      if (v === null || v === undefined || v === '') continue;
      hasData = true;
      const str = String(v).trim();
      
      if (isUuid && !uuidRegex.test(str)) isUuid = false;
      if (isBool && !['true', 'false', '1', '0', 'yes', 'no'].includes(str.toLowerCase())) isBool = false;
      
      // Date Check
      if (isDate) {
          const d = Date.parse(str);
          // Simple validation: must not be NaN and must look like a date (contains digits)
          if (isNaN(d) || !str.match(/\d/)) isDate = false;
      }

      // Number Checks
      if (!isNaN(Number(str))) {
          if (isInt && !Number.isInteger(Number(str))) isInt = false;
      } else {
          isInt = false;
          isFloat = false;
      }
    }

    if (!hasData) return 'text';
    if (isUuid) return 'uuid';
    if (isBool) return 'bool';
    if (isInt) return 'int4';
    if (isFloat) return 'numeric';
    if (isDate) return 'timestamptz';
    return 'text';
  };

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

  // --- RESIZE SIDEBAR LOGIC ---
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizingSidebar) {
        const newWidth = e.clientX; 
        if (newWidth > 150 && newWidth < 600) setSidebarWidth(newWidth);
      }
    };
    const handleMouseUp = () => setIsResizingSidebar(false);

    if (isResizingSidebar) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingSidebar]);

  // --- REALTIME & LOADERS ---
  const fetchProjectInfo = async () => {
    try {
      const projects = await fetchWithAuth(`/api/control/projects`);
      const current = projects.find((p: any) => p.slug === projectId);
      setProjectMetadata(current?.metadata || {});
      if (current?.metadata?.auth_link?.table) {
        setAuthLinkedTable(current.metadata.auth_link.table);
      }
      return current;
    } catch (e) { console.error(e); return null; }
  };

  const fetchTables = async () => {
    try {
      const [data, project, recycle] = await Promise.all([
        fetchWithAuth(`/api/data/${projectId}/tables`),
        fetchProjectInfo(),
        fetchWithAuth(`/api/data/${projectId}/recycle-bin`)
      ]);
      
      const savedOrder = project?.metadata?.ui_settings?.table_order || [];
      if (savedOrder.length > 0) {
        data.sort((a: any, b: any) => {
          const idxA = savedOrder.indexOf(a.name);
          const idxB = savedOrder.indexOf(b.name);
          if (idxA === -1) return 1;
          if (idxB === -1) return -1;
          return idxA - idxB;
        });
      }
      
      setTables(data);
      setRecycleBin(recycle);
      if (data.length > 0 && !selectedTable) setSelectedTable(data[0].name);
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  };

  const loadTableSettings = async (tableName: string) => {
      try {
          const settings = await fetchWithAuth(`/api/data/${projectId}/ui-settings/${tableName}`);
          if (settings.columns) return settings;
      } catch (e) { console.log("No UI settings"); }
      return null;
  };

  const fetchTableData = async (tableName: string, keepSelection = false) => {
    setDataLoading(true);
    if (!keepSelection) setSelectedRows(new Set());
    try {
      const [rows, cols, settings] = await Promise.all([
        fetchWithAuth(`/api/data/${projectId}/tables/${tableName}/data?limit=100`),
        fetchWithAuth(`/api/data/${projectId}/tables/${tableName}/columns`),
        loadTableSettings(tableName)
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
          settings.columns.forEach((c: any) => { if(c.width) widths[c.name] = c.width; });
          setColumnWidths(widths);
      } else {
          finalOrder = cols.map((c: any) => c.name);
      }
      setColumnOrder(finalOrder);

      const initialRow: any = {};
      cols.forEach((c: any) => {
         // Smart Defaults for New Row UI
         initialRow[c.name] = '';
      });
      setInlineNewRow(initialRow);

    } catch (err: any) { setError(translateError(err)); }
    finally { setDataLoading(false); }
  };

  useEffect(() => { fetchTables(); }, [projectId]);
  useEffect(() => { if (selectedTable && activeTab === 'tables') fetchTableData(selectedTable); }, [selectedTable, activeTab]);
  
  // REALTIME CONNECTION (ENV AWARE)
  useEffect(() => {
      let eventSource: EventSource | null = null;
      setIsRealtimeActive(false);
      
      // Listen for env change to refresh
      const handleEnvChange = () => {
         // Re-run effects via state update or force refresh.
         // Actually, parent App component re-mounts this component on env change.
         // So this useEffect runs fresh.
      };
      window.addEventListener('cascata_env_change', handleEnvChange);

      if (projectId) {
          const token = localStorage.getItem('cascata_token');
          // Inject Environment
          const env = localStorage.getItem('cascata_env') || 'live';
          const url = `/api/data/${projectId}/realtime?token=${token}&env=${env}`;
          
          eventSource = new EventSource(url);
          eventSource.onopen = () => setIsRealtimeActive(true);
          eventSource.onmessage = (e) => {
              try {
                  const payload = JSON.parse(e.data);
                  if (payload.type === 'connected') return;
                  if (payload && payload.table === selectedTable) fetchTableData(selectedTable, true);
              } catch (err) {}
          };
          eventSource.onerror = () => { setIsRealtimeActive(false); eventSource?.close(); };
      }
      return () => { 
          if (eventSource) eventSource.close(); 
          window.removeEventListener('cascata_env_change', handleEnvChange);
      };
  }, [projectId, selectedTable]);

  useEffect(() => {
    const hide = () => { 
        setContextMenu(null); 
        setShowExportMenu(false); 
        if (activeFkEditor) setActiveFkEditor(null);
    };
    window.addEventListener('click', hide);
    return () => window.removeEventListener('click', hide);
  }, [activeFkEditor]);

  // --- AUTO-HEALING SQL ---
  const handleFixSql = async () => {
      if (!error || !query) return;
      setIsFixingSql(true);
      try {
          const res = await fetchWithAuth(`/api/data/${projectId}/ai/fix-sql`, {
              method: 'POST',
              body: JSON.stringify({ sql: query, error: error })
          });
          if (res.fixed_sql) {
              setQuery(res.fixed_sql);
              setError(null); // Clear error as we have a potential fix
              setSuccessMsg("SQL corrected by AI. Review and execute.");
          }
      } catch (e: any) {
          alert("AI Fix Failed: " + e.message);
      } finally {
          setIsFixingSql(false);
      }
  };

  // --- ACTIONS: TABLE CREATOR DRAWER ---
  const handleAddColumnItem = () => {
    const newId = getUUID();
    setNewTableCols([
      ...newTableCols,
      { id: newId, name: '', type: 'text', defaultValue: '', isPrimaryKey: false, isNullable: true, isUnique: false, isArray: false, description: '' }
    ]);
    
    // Auto Scroll & Focus
    setTimeout(() => {
        if (drawerEndRef.current) {
            drawerEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
        const input = columnInputRefs.current.get(newId);
        if (input) input.focus();
    }, 50);
  };

  const handleRemoveColumnItem = (id: string) => {
    setNewTableCols(newTableCols.filter(c => c.id !== id));
    columnInputRefs.current.delete(id);
  };

  const handleColumnChange = (id: string, field: keyof ColumnDef, value: any) => {
    setNewTableCols(newTableCols.map(c => c.id === id ? { ...c, [field]: value } : c));
  };

  const handleSetForeignKey = async (id: string, table: string, column: string) => {
      setNewTableCols(newTableCols.map(c => c.id === id ? { ...c, foreignKey: table ? { table, column: column || '' } : undefined } : c));
      
      if (table) {
          setFkLoading(true);
          try {
              const res = await fetchWithAuth(`/api/data/${projectId}/tables/${table}/columns`);
              setFkTargetColumns(res.map((c: any) => c.name));
              if (!column && res.length > 0) {
                  const defaultCol = res.find((c:any) => c.name === 'id') ? 'id' : res[0].name;
                  setNewTableCols(cols => cols.map(c => c.id === id ? { ...c, foreignKey: { table, column: defaultCol } } : c));
              }
          } catch (e) { console.error("FK Fetch Error", e); }
          finally { setFkLoading(false); }
      }
  };

  const handleCreateTableSubmit = () => {
    // Legacy function placeholder (logic moved to button below)
  };

  // --- ACTIONS: SIDEBAR DRAG ---
  const saveTableOrder = async (newTables: any[]) => {
      const order = newTables.map(t => t.name);
      await fetchWithAuth(`/api/control/projects/${projectId}`, {
          method: 'PATCH',
          body: JSON.stringify({ metadata: { ui_settings: { table_order: order } } })
      });
  };

  const handleTableDrop = (targetTable: string) => {
      if (!draggedTable || draggedTable === targetTable) return;
      const newTables = [...tables];
      const fromIdx = newTables.findIndex(t => t.name === draggedTable);
      const toIdx = newTables.findIndex(t => t.name === targetTable);
      const [moved] = newTables.splice(fromIdx, 1);
      newTables.splice(toIdx, 0, moved);
      setTables(newTables);
      setDraggedTable(null);
      saveTableOrder(newTables);
  };

  // --- ACTIONS: TABLE MANAGEMENT ---
  const handleTableSelection = (e: React.MouseEvent, tableName: string) => {
      // NEW BEHAVIOR: If SQL Editor is active, switch to Grid View
      if (activeTab === 'query') {
          setActiveTab('tables');
          setSelectedTable(tableName);
          return;
      }

      if (e.detail === 2) { 
          const next = new Set(selectedTables);
          if (next.has(tableName)) next.delete(tableName); else next.add(tableName);
          setSelectedTables(next);
      } else {
          if (!e.ctrlKey && !e.metaKey && selectedTables.size === 0) {
             setSelectedTable(tableName);
          }
      }
  };

  const handleCopyStructure = async () => {
      const targets = selectedTables.size > 0 ? Array.from(selectedTables) : [selectedTable!];
      let fullSql = '';
      for (const t of targets) {
          try {
            const cols = await fetchWithAuth(`/api/data/${projectId}/tables/${t}/columns`);
            const createSql = `CREATE TABLE "${t}" (\n${cols.map((c: any) => `  "${c.name}" ${c.type}${c.isPrimaryKey ? ' PRIMARY KEY' : ''}`).join(',\n')}\n);`;
            fullSql += `-- Structure for ${t}\n${createSql}\n\n`;
          } catch(e) {}
      }
      const copied = await copyToClipboard(fullSql);
      if (copied) setSuccessMsg(`SQL copied.`);
  };

  const handleDeleteTable = async () => {
      setExecuting(true);
      try {
          if (showDeleteModal.mode === 'HARD') {
              const verify = await fetch('/api/control/auth/verify', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
                  body: JSON.stringify({ password: verifyPassword })
              });
              if (!verify.ok) throw new Error("Senha incorreta");
          }
          const payloadMode = showDeleteModal.mode === 'HARD' ? 'CASCADE' : undefined;
          await fetchWithAuth(`/api/data/${projectId}/tables/${showDeleteModal.table}`, {
              method: 'DELETE',
              body: JSON.stringify({ mode: payloadMode })
          });
          setSuccessMsg(showDeleteModal.mode === 'SOFT' ? "Moved to Recycle Bin." : "Table Destroyed.");
          setShowDeleteModal({ active: false, table: '', mode: 'SOFT' });
          setVerifyPassword('');
          fetchTables();
          if (selectedTable === showDeleteModal.table) setSelectedTable(null);
      } catch (e: any) { setError(e.message); }
      finally { setExecuting(false); }
  };

  const handleRestore = async (tableName: string) => {
      setExecuting(true);
      try {
          await fetchWithAuth(`/api/data/${projectId}/recycle-bin/${tableName}/restore`, { method: 'POST' });
          setSuccessMsg(`${tableName} restored.`);
          fetchTables();
          setShowTrashModal(false);
      } catch (e: any) { setError(e.message); }
      finally { setExecuting(false); }
  };

  const handleExportRecycled = async (tableName: string, format: 'sql' | 'csv') => {
      setExecuting(true);
      try {
          // Fetch data from deleted table directly using SQL
          const res = await fetchWithAuth(`/api/data/${projectId}/query`, {
              method: 'POST',
              body: JSON.stringify({ sql: `SELECT * FROM public."${tableName}" LIMIT 1000` })
          });
          
          if (!res.rows) throw new Error("No data found");
          
          handleExport(format, res.rows);
          setSuccessMsg("Export initiated.");
      } catch (e: any) {
          setError(translateError(e));
      } finally {
          setExecuting(false);
      }
  };

  const handleDuplicateTableSubmit = async () => {
      if (!duplicateConfig.newName || !duplicateConfig.source) return;
      setExecuting(true);
      try {
          const withDataSql = duplicateConfig.withData ? '' : 'WITH NO DATA';
          const sql = `CREATE TABLE "${duplicateConfig.newName}" AS TABLE "${duplicateConfig.source}" ${withDataSql};`;
          
          await fetchWithAuth(`/api/data/${projectId}/query`, {
              method: 'POST',
              body: JSON.stringify({ sql })
          });
          
          setSuccessMsg(`Table duplicated to ${duplicateConfig.newName}`);
          setShowDuplicateModal(false);
          setDuplicateConfig({ source: '', newName: '', withData: false });
          fetchTables();
      } catch (e: any) { setError(e.message); }
      finally { setExecuting(false); }
  };

  // --- ACTIONS: COLUMNS ---
  const handleAddColumn = async () => {
      if (!newColumn.name || !selectedTable) return;
      setExecuting(true);
      try {
          // GENERATE SQL FOR ALTER TABLE
          let sql = `ALTER TABLE public."${selectedTable}" ADD COLUMN "${sanitizeName(newColumn.name)}" ${newColumn.type}`;
          
          if (!newColumn.isNullable) sql += ' NOT NULL';
          if (newColumn.defaultValue) sql += ` DEFAULT ${newColumn.defaultValue}`;
          if (newColumn.isUnique) sql += ' UNIQUE';
          
          if (newColumn.foreignKey) {
              sql += ` REFERENCES public."${newColumn.foreignKey.table}"("${newColumn.foreignKey.column}")`;
          }

          // Execute via Query Endpoint
          await fetchWithAuth(`/api/data/${projectId}/query`, {
              method: 'POST',
              body: JSON.stringify({ sql })
          });

          // Add Comment/Description if provided
          if (newColumn.description) {
             await fetchWithAuth(`/api/data/${projectId}/query`, {
                method: 'POST',
                body: JSON.stringify({ 
                    sql: `COMMENT ON COLUMN public."${selectedTable}"."${sanitizeName(newColumn.name)}" IS '${newColumn.description.replace(/'/g, "''")}'` 
                })
             });
          }

          setSuccessMsg("Column added.");
          setShowAddColumn(false);
          setNewColumn({ name: '', type: 'text', isNullable: true, defaultValue: '', isUnique: false, description: '' });
          fetchTableData(selectedTable);
      } catch (e: any) { setError(translateError(e)); }
      finally { setExecuting(false); }
  };

  const handleResize = (colName: string, newWidth: number) => {
      setColumnWidths(prev => ({ ...prev, [colName]: Math.max(10, newWidth) }));
  };

  const saveGridSettings = async (overrideOrder?: string[], overrideWidths?: Record<string, number>) => {
      if (!selectedTable) return;
      
      const targetOrder = overrideOrder || columnOrder;
      const targetWidths = overrideWidths || columnWidths;

      const settings = {
          columns: targetOrder.map(name => ({ name, width: targetWidths[name] }))
      };
      await fetchWithAuth(`/api/data/${projectId}/ui-settings/${selectedTable}`, {
          method: 'POST',
          body: JSON.stringify({ settings })
      });
  };

  const handleColumnDrop = (targetCol: string) => {
      if (!draggingColumn || draggingColumn === targetCol) return;
      const newOrder = [...columnOrder];
      const fromIdx = newOrder.indexOf(draggingColumn);
      const toIdx = newOrder.indexOf(targetCol);
      newOrder.splice(fromIdx, 1);
      newOrder.splice(toIdx, 0, draggingColumn);
      setColumnOrder(newOrder);
      setDraggingColumn(null);
      saveGridSettings(newOrder);
  };

  // --- ACTIONS: IMPORT/EXPORT ---
  const handleExport = (format: 'csv' | 'json' | 'sql' | 'xlsx' | 'pdf', sourceData?: any[]) => {
      // If sourceData is provided, use it (for query results export). Otherwise use tableData.
      const rows = sourceData || (selectedRows.size > 0 ? tableData.filter(r => selectedRows.has(r[pkCol])) : tableData);
      
      const sanitized = rows.map(r => {
          const clean: any = {};
          Object.keys(r).forEach(k => clean[k] = sanitizeForCSV(r[k]));
          return clean;
      });
      const fileName = `${sourceData ? 'query_result' : selectedTable}_${Date.now()}`;
      
      if (format === 'json') {
          const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a'); a.href = url; a.download = `${fileName}.json`; a.click();
      } 
      else if (format === 'pdf') {
          const doc = new jsPDF();
          (doc as any).autoTable({
              head: [Object.keys(sanitized[0] || {})],
              body: sanitized.map(r => Object.values(r)),
          });
          doc.save(`${fileName}.pdf`);
      }
      else if (format === 'sql') {
          const sql = sanitized.map(row => {
              const keys = Object.keys(row);
              const vals = keys.map(k => typeof row[k] === 'string' ? `'${row[k].replace(/'/g, "''")}'` : row[k]);
              return `INSERT INTO "${selectedTable || 'export_table'}" (${keys.map(k=>`"${k}"`).join(',')}) VALUES (${vals.join(',')});`;
          }).join('\n');
          const blob = new Blob([sql], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a'); a.href = url; a.download = `${fileName}.sql`; a.click();
      }
      else if (window.XLSX) {
          const ws = window.XLSX.utils.json_to_sheet(sanitized);
          if (format === 'csv') {
              const csv = window.XLSX.utils.sheet_to_csv(ws);
              const blob = new Blob([csv], { type: 'text/csv' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a'); a.href = url; a.download = `${fileName}.csv`; a.click();
          } else {
              const wb = window.XLSX.utils.book_new();
              window.XLSX.utils.book_append_sheet(wb, ws, "Data");
              window.XLSX.writeFile(wb, `${fileName}.xlsx`);
          }
      }
  };

  const handleImport = async () => {
      if (!importFile) return;
      setExecuting(true);
      try {
          const reader = new FileReader();
          
          // ENCODING FIX: Use ArrayBuffer for proper UTF-8 handling
          reader.readAsArrayBuffer(importFile);
          
          reader.onload = async (e) => {
              const data = new Uint8Array(e.target?.result as ArrayBuffer);
              let json: any[] = [];
              const fileName = importFile.name.split('.')[0];
              const ext = importFile.name.split('.').pop()?.toLowerCase();

              if (ext === 'json') {
                  try { 
                      const text = new TextDecoder("utf-8").decode(data);
                      json = JSON.parse(text); 
                  } catch(e) { alert("Invalid JSON"); return; }
              } else if (['csv', 'xlsx'].includes(ext || '')) {
                  const wb = window.XLSX.read(data, { type: 'array' }); // Correct type for ArrayBuffer
                  const wsName = wb.SheetNames[0];
                  json = window.XLSX.utils.sheet_to_json(wb.Sheets[wsName]);
              }

              if (createTableFromImport) {
                  inferSchemaAndOpenModal(json, fileName);
                  setShowImportModal(false);
                  setExecuting(false);
                  return;
              }

              // Normal Import to existing table
              let targetTable = selectedTable;
              if (!targetTable) throw new Error("No target table selected");

              const chunkSize = 100;
              for (let i = 0; i < json.length; i += chunkSize) {
                  const chunk = json.slice(i, i + chunkSize);
                  await fetchWithAuth(`/api/data/${projectId}/tables/${targetTable}/rows`, {
                      method: 'POST',
                      body: JSON.stringify({ data: chunk })
                  });
              }
              setSuccessMsg(`Imported to ${targetTable}.`);
              setShowImportModal(false);
              fetchTables();
              if (targetTable) { setSelectedTable(targetTable); fetchTableData(targetTable); }
              setExecuting(false);
          };
      } catch (e: any) { 
          setError(translateError(e)); 
          setExecuting(false);
      }
  };

  const inferSchemaAndOpenModal = (data: any[], fileName: string) => {
      const headers = Object.keys(data[0]);
      const sample = data.slice(0, 50);
      
      const inferredCols: ColumnDef[] = [];
      inferredCols.push({ id: getUUID(), name: 'id', type: 'uuid', defaultValue: 'gen_random_uuid()', isPrimaryKey: true, isNullable: false, isUnique: true, isArray: false, description: 'ID' });
      
      headers.forEach(h => {
          const colValues = sample.map((r: any) => r[h]);
          const inferredType = inferType(colValues);

          inferredCols.push({
              id: getUUID(),
              name: sanitizeName(h),
              sourceHeader: h, 
              type: inferredType,
              defaultValue: '',
              isPrimaryKey: false,
              isNullable: true,
              isUnique: false,
              isArray: false,
              description: 'Imported ' + h
          });
      });
      
      setNewTableName(sanitizeName(fileName));
      setNewTableCols(inferredCols);
      setImportPendingData(data);
      // Generate Preview
      setImportPreview(data.slice(0, 5));
      setShowCreateTable(true);
  };

  const handleGlobalDrop = async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDraggingOver(false);
      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
          setImportFile(files[0]);
          setShowImportModal(true);
      }
  };

  // --- ACTIONS: ROWS ---
  const handleInlineSave = async () => {
    setExecuting(true);
    try {
      // 22P02 Fix: Clean Payload
      const payload: any = {};
      columns.forEach(col => {
          const rawVal = inlineNewRow[col.name];
          if (rawVal === '' || rawVal === undefined) {
              if (col.defaultValue) {
                  // Skip to allow DB default to takeover (e.g. gen_random_uuid, now())
                  return;
              }
              if (col.isNullable) {
                  payload[col.name] = null;
              }
          } else {
              payload[col.name] = rawVal;
          }
      });

      // Secure Insert via REST
      await fetchWithAuth(`/api/data/${projectId}/tables/${selectedTable}/rows`, { method: 'POST', body: JSON.stringify({ data: payload }) });
      setSuccessMsg('Row added.');
      fetchTableData(selectedTable!);
      
      // Reset Input
      const nextRow: any = {};
      columns.forEach(col => { nextRow[col.name] = ''; });
      setInlineNewRow(nextRow);
      setTimeout(() => firstInputRef.current?.focus(), 100);
    } catch (e: any) { setError(translateError(e)); }
    finally { setExecuting(false); }
  };

  const handleUpdateCell = async (row: any, colName: string, newValue: string) => {
    if (!pkCol) return;
    try {
      const payload = { [colName]: newValue === '' ? null : newValue }; // 22P02 Fix for Updates
      // Secure Update via REST
      await fetchWithAuth(`/api/data/${projectId}/tables/${selectedTable}/rows`, {
        method: 'PUT',
        body: JSON.stringify({ data: payload, pkColumn: pkCol, pkValue: row[pkCol] })
      });
      const updatedData = tableData.map(r => r[pkCol] === row[pkCol] ? { ...r, [colName]: newValue } : r);
      setTableData(updatedData);
      setEditingCell(null);
    } catch (e: any) { setError(translateError(e)); }
  };

  const getSmartPlaceholder = (col: any) => {
      if (col.defaultValue && col.defaultValue.includes('gen_random_uuid')) return 'UUID (Auto)';
      if (col.defaultValue && col.defaultValue.includes('now()')) return 'Now()';
      return col.type;
  };

  const renderInput = (col: any, value: any, onChange: (val: any) => void, onEnter?: () => void, isFirst = false) => {
    return (
        <input 
            ref={isFirst ? firstInputRef : undefined} 
            value={value} 
            onChange={(e) => onChange(e.target.value)} 
            className="w-full bg-transparent outline-none text-xs font-medium text-slate-700 h-full px-2 placeholder:text-slate-300" 
            placeholder={getSmartPlaceholder(col)}
            onKeyDown={(e) => e.key === 'Enter' && onEnter && onEnter()} 
        />
    );
  };

  const displayColumns = columnOrder.length > 0 ? columnOrder.map(name => columns.find(c => c.name === name)).filter(Boolean) : columns;

  return (
    <div 
        className={`flex h-full flex-col bg-[#FDFDFD] relative transition-colors ${isDraggingOver ? 'bg-indigo-50/50' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setIsDraggingOver(true); }}
        onDragLeave={() => setIsDraggingOver(false)}
        onDrop={handleGlobalDrop}
    >
      {/* ERROR TOAST (Human Readable) */}
      {error && (
        <div className="fixed top-8 left-1/2 -translate-x-1/2 z-[600] px-6 py-4 bg-rose-600 text-white rounded-full shadow-2xl flex items-center gap-4 animate-in slide-in-from-top-4 cursor-pointer" onClick={() => setError(null)}>
            <AlertTriangle size={18} />
            <span className="text-xs font-bold">{error}</span>
            <X size={14} className="opacity-50 hover:opacity-100" />
        </div>
      )}
      
      {/* SUCCESS TOAST */}
      {successMsg && (
        <div className="fixed top-8 left-1/2 -translate-x-1/2 z-[600] px-6 py-4 bg-emerald-600 text-white rounded-full shadow-2xl flex items-center gap-4 animate-in slide-in-from-top-4">
            <CheckCircle2 size={18} />
            <span className="text-xs font-bold">{successMsg}</span>
            <button onClick={() => setSuccessMsg(null)}><X size={14} className="opacity-50 hover:opacity-100" /></button>
        </div>
      )}

      {/* GLOBAL DRAG OVERLAY */}
      {isDraggingOver && (
          <div className="absolute inset-0 z-[999] flex items-center justify-center bg-indigo-600/10 backdrop-blur-sm pointer-events-none">
              <div className="bg-white p-10 rounded-[3rem] shadow-2xl flex flex-col items-center animate-in zoom-in-95">
                  <Upload size={64} className="text-indigo-600 mb-6"/>
                  <h3 className="text-2xl font-black text-slate-900">Drop to Import</h3>
                  <p className="text-slate-500 font-bold uppercase tracking-widest mt-2">Smart Schema Detection Active</p>
              </div>
          </div>
      )}

      {/* HEADER */}
      <header className="border-b border-slate-200 px-6 py-4 bg-white flex items-center justify-between shadow-sm z-20 h-16">
        <div className="flex items-center gap-4">
          <div className="p-2 bg-slate-900 text-white rounded-xl shadow-lg"><Database size={20} /></div>
          <div><h2 className="text-lg font-black text-slate-900 tracking-tight leading-none">Data Browser</h2><p className="text-[9px] text-indigo-600 font-bold uppercase tracking-[0.2em]">{projectId}</p></div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center bg-slate-100 p-1 rounded-xl">
            <button onClick={() => setActiveTab('tables')} className={`px-4 py-1.5 text-[10px] font-black rounded-lg transition-all ${activeTab === 'tables' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-500'}`}>GRID VIEW</button>
            <button onClick={() => setActiveTab('query')} className={`px-4 py-1.5 text-[10px] font-black rounded-lg transition-all ${activeTab === 'query' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-500'}`}>SQL EDITOR</button>
          </div>
          <button onClick={() => { setShowCreateTable(true); setImportPendingData(null); setNewTableName(''); }} className="bg-slate-900 text-white px-4 py-2 rounded-xl text-[10px] font-black flex items-center gap-2 hover:bg-slate-800 transition-all"><Plus size={14} /> NEW TABLE</button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden relative">
        {/* RESIZABLE SIDEBAR */}
        <aside 
          className="border-r border-slate-200 bg-white flex flex-col shrink-0 z-10 relative group/sidebar"
          style={{ width: sidebarWidth }}
        >
          <div onMouseDown={() => setIsResizingSidebar(true)} className={`absolute right-0 top-0 w-1 h-full cursor-col-resize hover:bg-indigo-500 transition-colors z-50 ${isResizingSidebar ? 'bg-indigo-500 w-1.5' : 'bg-transparent'}`} />

          <div className="p-4 border-b border-slate-50 flex flex-col gap-2">
            <div className="flex items-center justify-between px-2">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{tables.length} Public Tables</span>
                <button onClick={() => fetchTables()} className="text-indigo-600 hover:bg-indigo-50 p-1 rounded"><RefreshIcon size={12}/></button>
            </div>
          </div>
          
          <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
            {tables.map(t => {
              const isSelected = selectedTables.has(t.name) || selectedTable === t.name;
              const isMulti = selectedTables.has(t.name);
              return (
                <div 
                  key={t.name}
                  draggable
                  onDragStart={() => setDraggedTable(t.name)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => handleTableDrop(t.name)}
                  onClick={(e) => handleTableSelection(e, t.name)}
                  onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, table: t.name }); }}
                  className={`flex items-center justify-between px-4 py-3 rounded-xl transition-all cursor-pointer group select-none 
                    ${isMulti ? 'bg-indigo-100 text-indigo-800 ring-1 ring-indigo-300' : selectedTable === t.name ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-50'}
                    ${draggedTable === t.name ? 'opacity-50' : ''}
                  `}
                >
                  <div className="flex items-center gap-3">
                    <GripVertical size={12} className="text-slate-300 cursor-move opacity-0 group-hover:opacity-100" />
                    {t.name === authLinkedTable ? <User size={14} className={isSelected ? 'text-indigo-600' : 'text-emerald-500'} /> : <TableIcon size={14} className={isSelected ? 'text-indigo-600' : 'text-slate-400'} />}
                    <span className="text-xs font-bold truncate max-w-[120px]">{t.name}</span>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="p-4 border-t border-slate-100">
             <button onClick={() => setShowTrashModal(true)} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-500 hover:bg-rose-50 hover:text-rose-600 rounded-xl transition-all">
                <Trash2 size={16} /> Recycle Bin
                {recycleBin.length > 0 && <span className="ml-auto bg-rose-100 text-rose-600 px-2 py-0.5 rounded-full text-[9px] font-black">{recycleBin.length}</span>}
             </button>
          </div>
        </aside>

        {/* MAIN CONTENT */}
        <main className="flex-1 overflow-hidden flex flex-col relative bg-[#FAFBFC]">
          {activeTab === 'tables' ? (
            selectedTable ? (
              <div className="flex-1 flex flex-col overflow-hidden">
                {/* TOOLBAR */}
                <div className="px-8 py-4 border-b border-slate-200 bg-white flex items-center justify-between shrink-0">
                   <div className="flex items-center gap-6">
                      <h3 className="text-xl font-black text-slate-900 tracking-tight">{selectedTable}</h3>
                      <span className="text-xs font-bold text-slate-400">{tableData.length} records</span>
                      {isRealtimeActive && <div className="flex items-center gap-1.5 px-2 py-1 bg-amber-50 rounded-full border border-amber-100"><div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></div><span className="text-[9px] font-black text-amber-600 uppercase">Live</span></div>}
                   </div>
                   <div className="flex items-center gap-3 relative">
                      <div className="relative">
                          <button onClick={(e) => { e.stopPropagation(); setShowExportMenu(!showExportMenu); }} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-50 text-slate-600 hover:bg-slate-100 text-[10px] font-black uppercase tracking-widest"><Download size={12}/> Export</button>
                          {showExportMenu && (
                              <div className="absolute top-full right-0 mt-2 bg-white border border-slate-200 shadow-xl rounded-xl p-1 z-50 w-32 animate-in fade-in zoom-in-95">
                                  {['csv', 'xlsx', 'json', 'sql', 'pdf'].map(fmt => (
                                      <button key={fmt} onClick={() => { handleExport(fmt as any); setShowExportMenu(false); }} className="w-full text-left px-3 py-2 hover:bg-slate-50 text-xs font-bold uppercase text-slate-600 rounded-lg flex items-center gap-2">
                                          {fmt === 'pdf' ? <FileType size={12}/> : fmt === 'xlsx' ? <FileSpreadsheet size={12}/> : fmt === 'json' ? <FileJson size={12}/> : <Code size={12}/>} {fmt.toUpperCase()}
                                      </button>
                                  ))}
                              </div>
                          )}
                      </div>
                      <button onClick={() => setShowImportModal(true)} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-50 text-slate-600 hover:bg-slate-100 text-[10px] font-black uppercase tracking-widest"><Upload size={12}/> Import</button>
                   </div>
                </div>

                {/* GRID */}
                <div className="flex-1 overflow-auto relative">
                   <table className="border-collapse table-fixed" style={{ minWidth: '100%' }}>
                      <thead className="sticky top-0 bg-white shadow-sm z-20">
                         <tr>
                            <th className="w-12 border-b border-r border-slate-200 bg-slate-50 sticky left-0 z-30"><div className="flex items-center justify-center h-full"><input type="checkbox" onChange={(e) => setSelectedRows(e.target.checked ? new Set(tableData.map(r => r[pkCol])) : new Set())} checked={selectedRows.size > 0 && selectedRows.size === tableData.length} className="rounded border-slate-300"/></div></th>
                            {displayColumns.map((col: any) => (
                               <th 
                                key={col.name} 
                                className={`px-4 py-3 text-left border-b border-r border-slate-200 bg-slate-50 relative group select-none ${draggingColumn === col.name ? 'opacity-50 bg-indigo-50' : ''}`}
                                style={{ width: columnWidths[col.name] || 200 }}
                                draggable
                                onDragStart={() => setDraggingColumn(col.name)}
                                onDragOver={(e) => e.preventDefault()}
                                onDrop={() => handleColumnDrop(col.name)}
                               >
                                  <div className="flex items-center gap-2">
                                     {col.isPrimaryKey && <Key size={10} className="text-amber-500" />}
                                     {/* UX IMPROVEMENT: Clean Header (No Type shown here) */}
                                     <span className="text-[10px] font-black text-slate-700 uppercase tracking-tight truncate">{col.name}</span>
                                  </div>
                                  <div className="absolute right-0 top-0 w-1 h-full cursor-col-resize hover:bg-indigo-400 z-10" onMouseDown={(e) => { 
                                      e.preventDefault(); 
                                      const startX = e.clientX; 
                                      const startWidth = columnWidths[col.name] || 200; 
                                      const onMove = (moveEvent: MouseEvent) => setColumnWidths(prev => ({ ...prev, [col.name]: Math.max(10, startWidth + (moveEvent.clientX - startX)) })); 
                                      const onUp = (upEvent: MouseEvent) => { 
                                          document.removeEventListener('mousemove', onMove); 
                                          document.removeEventListener('mouseup', onUp); 
                                          const finalWidth = Math.max(10, startWidth + (upEvent.clientX - startX));
                                          saveGridSettings(undefined, { ...columnWidths, [col.name]: finalWidth }); 
                                      }; 
                                      document.addEventListener('mousemove', onMove); 
                                      document.addEventListener('mouseup', onUp); 
                                  }} />
                               </th>
                            ))}
                            <th className="w-16 border-b border-slate-200 bg-slate-50 text-center hover:bg-slate-100 cursor-pointer" onClick={() => setShowAddColumn(true)}>
                                <Plus size={16} className="mx-auto text-slate-400" />
                            </th>
                         </tr>
                         
                         {/* INLINE ROW (Smart Placeholders) */}
                         <tr className="bg-indigo-50/30 border-b border-indigo-100 group">
                            <td className="p-0 text-center border-r border-slate-200 bg-indigo-50/50 sticky left-0 z-20"><Plus size={14} className="mx-auto text-indigo-400"/></td>
                            {displayColumns.map((col: any, idx) => (
                               <td key={col.name} className="p-0 border-r border-slate-200 relative"><div className="h-10">{renderInput(col, inlineNewRow[col.name], (val) => setInlineNewRow({...inlineNewRow, [col.name]: val}), handleInlineSave, idx === 0)}</div></td>
                            ))}
                            <td className="p-0 text-center bg-indigo-50/50"><button onClick={handleInlineSave} className="w-full h-full flex items-center justify-center text-indigo-600 hover:bg-indigo-100 transition-colors"><Save size={14} /></button></td>
                         </tr>
                      </thead>
                      <tbody className="bg-white">
                         {dataLoading ? (
                            <tr><td colSpan={displayColumns.length + 2} className="py-20 text-center text-slate-400"><Loader2 className="animate-spin mx-auto mb-2" /> Loading data...</td></tr>
                         ) : tableData.map((row, rIdx) => (
                            <tr key={rIdx} className={`hover:bg-slate-50 group ${selectedRows.has(row[pkCol]) ? 'bg-indigo-50/50' : ''}`}>
                               <td className="text-center border-b border-r border-slate-100 sticky left-0 bg-white group-hover:bg-slate-50 z-10"><input type="checkbox" checked={selectedRows.has(row[pkCol])} onChange={() => { const next = new Set(selectedRows); if (next.has(row[pkCol])) next.delete(row[pkCol]); else next.add(row[pkCol]); setSelectedRows(next); }} className="rounded border-slate-300"/></td>
                               {displayColumns.map((col: any) => {
                                  const isEditing = editingCell?.rowId === row[pkCol] && editingCell?.col === col.name;
                                  return (
                                     <td key={col.name} onDoubleClick={() => { setEditingCell({rowId: row[pkCol], col: col.name}); setEditValue(String(row[col.name])); }} className="border-b border-r border-slate-100 px-4 py-2.5 text-xs text-slate-700 font-medium truncate cursor-text relative">
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
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-300 p-10 text-center">
                 <div className="w-24 h-24 bg-slate-100 rounded-[2rem] flex items-center justify-center mb-6"><TableIcon size={40} className="opacity-20" /></div>
                 <h3 className="text-2xl font-black text-slate-400 tracking-tighter mb-2">No Table Selected</h3>
              </div>
            )
          ) : (
            // SQL EDITOR V2
            <div className="flex-1 flex bg-slate-950 overflow-hidden relative">
              {/* Main Editor */}
              <div className="flex-1 flex flex-col relative">
                <div className="px-8 py-5 bg-slate-900/80 border-b border-white/5 flex items-center justify-between z-10">
                  <div className="flex items-center gap-4"><div className="w-10 h-10 rounded-2xl bg-indigo-500/10 flex items-center justify-center text-indigo-400"><Terminal size={20} /></div><h4 className="text-white font-black text-sm tracking-tight">SQL Console v2</h4></div>
                  <div className="flex items-center gap-2">
                      {/* Botão Fix with AI condicional */}
                      {error && activeTab === 'query' && (
                          <button 
                              onClick={handleFixSql} 
                              disabled={isFixingSql}
                              className="mr-2 bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 px-4 py-2 rounded-xl text-[10px] font-black uppercase flex items-center gap-2 hover:bg-indigo-600 hover:text-white transition-all"
                          >
                              {isFixingSql ? <Loader2 size={12} className="animate-spin"/> : <Sparkles size={12}/>} 
                              Fix SQL
                          </button>
                      )}
                      <button onClick={async () => {
                        setExecuting(true); setQueryResult(null); setError(null);
                        try {
                          const data = await fetchWithAuth(`/api/data/${projectId}/query`, { method: 'POST', body: JSON.stringify({ sql: query }) });
                          setQueryResult(data); 
                          setQueryHistory(prev => [query, ...prev.slice(0, 4)]); // Keep last 5
                          fetchTables();
                        } catch (err: any) { setError(translateError(err)); }
                        finally { setExecuting(false); }
                      }} disabled={executing} className="bg-emerald-500 text-white px-8 py-3 rounded-2xl text-xs font-black flex items-center gap-3 hover:bg-emerald-400 transition-all shadow-xl shadow-emerald-500/20">{executing ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} />} EXECUTE</button>
                  </div>
                </div>
                <textarea 
                  value={query} 
                  onChange={(e) => setQuery(e.target.value)} 
                  onKeyDown={(e) => {
                      if (e.key === 'Tab') {
                          e.preventDefault();
                          const target = e.target as HTMLTextAreaElement;
                          const start = target.selectionStart;
                          const end = target.selectionEnd;
                          const newValue = query.substring(0, start) + "  " + query.substring(end);
                          setQuery(newValue);
                          setTimeout(() => {
                              target.selectionStart = target.selectionEnd = start + 2;
                          }, 0);
                      }
                  }}
                  className="flex-1 w-full bg-[#020617] text-emerald-400 p-12 font-mono text-lg outline-none resize-none spellcheck-false placeholder:text-emerald-900"
                  placeholder="-- Start typing SQL query..." 
                />
                {queryResult && (
                  <div className="h-[45%] bg-[#0f172a] border-t border-white/5 overflow-auto p-10 font-mono animate-in slide-in-from-bottom-10 flex flex-col">
                    <div className="mb-4 flex items-center justify-between">
                        <div className="flex items-center gap-6">
                          <span className="text-emerald-400 font-black text-xs uppercase tracking-widest">Query Result</span>
                          <span className="text-slate-500 text-[10px] font-bold">{queryResult.command} • {queryResult.rowCount} rows • {queryResult.duration}ms</span>
                        </div>
                        
                        {/* --- EXPORT BUTTONS FOR SQL RESULT --- */}
                        {queryResult.rows && queryResult.rows.length > 0 && (
                            <div className="flex gap-2">
                               <button onClick={() => handleExport('csv', queryResult.rows)} className="bg-white/10 text-white/80 px-3 py-1.5 rounded-lg text-[9px] font-black uppercase hover:bg-white/20 transition-all flex items-center gap-2"><FileSpreadsheet size={10}/> CSV</button>
                               <button onClick={() => handleExport('json', queryResult.rows)} className="bg-white/10 text-white/80 px-3 py-1.5 rounded-lg text-[9px] font-black uppercase hover:bg-white/20 transition-all flex items-center gap-2"><FileJson size={10}/> JSON</button>
                            </div>
                        )}
                    </div>

                    {queryResult.rows && queryResult.rows.length > 0 ? (
                      <div className="bg-slate-900 rounded-2xl border border-white/5 overflow-hidden">
                        <table className="w-full text-left border-collapse">
                          <thead>
                            <tr className="bg-white/5">
                              {Object.keys(queryResult.rows[0]).map(h => <th key={h} className="px-4 py-3 text-[10px] font-black text-slate-400 uppercase border-r border-white/5">{h}</th>)}
                            </tr>
                          </thead>
                          <tbody>
                            {queryResult.rows.map((r:any, i:number) => (
                              <tr key={i} className="border-b border-white/5 hover:bg-white/5">
                                {Object.values(r).map((v:any, j:number) => <td key={j} className="px-4 py-2 text-xs text-slate-300 truncate max-w-[200px] border-r border-white/5">{v === null ? 'null' : String(v)}</td>)}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : <pre className="text-xs text-slate-300 leading-6">{JSON.stringify(queryResult, null, 2)}</pre>}
                  </div>
                )}
              </div>

              {/* History Sidebar */}
              <div className="w-64 border-l border-white/5 bg-[#0f172a] flex flex-col">
                <div className="p-4 border-b border-white/5 flex items-center gap-2">
                    <History size={14} className="text-slate-500"/>
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Recent Queries</span>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1">
                    {queryHistory.map((q, i) => (
                        <button 
                            key={i} 
                            onClick={() => setQuery(q)}
                            className="w-full text-left p-3 rounded-lg hover:bg-white/5 text-[10px] font-mono text-slate-400 hover:text-emerald-400 transition-colors truncate block border border-transparent hover:border-white/5"
                            title={q}
                        >
                            {q}
                        </button>
                    ))}
                    {queryHistory.length === 0 && (
                        <div className="text-center py-10 text-[10px] text-slate-600 italic">No history yet</div>
                    )}
                </div>
              </div>
            </div>
          )}
        </main>

        {/* TABLE CREATOR DRAWER (SUPABASE STYLE) */}
        <div className={`fixed inset-y-0 right-0 w-[500px] bg-white shadow-2xl z-[100] transform transition-transform duration-300 ease-in-out flex flex-col border-l border-slate-200 ${showCreateTable ? 'translate-x-0' : 'translate-x-full'}`}>
          <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
            <div><h3 className="text-xl font-black text-slate-900 tracking-tight">{importPendingData ? 'Import & Map' : 'Create New Table'}</h3><p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Schema Designer</p></div>
            <button onClick={() => setShowCreateTable(false)} className="p-2 hover:bg-slate-200 rounded-lg text-slate-400"><X size={20}/></button>
          </div>
          <div className="flex-1 overflow-y-auto p-6 space-y-8">
            
            {/* DATA PREVIEW FOR IMPORT (NEW FEATURE) */}
            {importPreview.length > 0 && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 overflow-hidden">
                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-2"><Eye size={12}/> File Preview (First 5 Rows)</h4>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                            <thead>
                                <tr className="border-b border-slate-200">
                                    {Object.keys(importPreview[0]).map(h => <th key={h} className="pb-2 font-bold text-slate-600 pr-4 whitespace-nowrap">{h}</th>)}
                                </tr>
                            </thead>
                            <tbody>
                                {importPreview.map((row, i) => (
                                    <tr key={i} className="border-b border-slate-100 last:border-0">
                                        {Object.values(row).map((val: any, j) => (
                                            <td key={j} className="py-1 text-slate-500 pr-4 whitespace-nowrap max-w-[100px] truncate">{String(val)}</td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            <div className="space-y-4">
              <div className="space-y-2"><label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Table Name</label><input autoFocus value={newTableName} onChange={(e) => setNewTableName(sanitizeName(e.target.value))} placeholder="public.users" className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 px-4 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-500/20"/></div>
              <div className="space-y-2"><label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Description (for AI)</label><input value={newTableDesc} onChange={(e) => setNewTableDesc(e.target.value)} placeholder="e.g. Stores registered users." className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 px-4 text-sm font-medium outline-none focus:ring-2 focus:ring-indigo-500/20 text-slate-600"/></div>
            </div>
            <div className="space-y-4">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Column Definitions</label>
              <div className="space-y-3" ref={drawerEndRef}>
                {newTableCols.map((col, idx) => (
                  <div key={col.id} className="bg-white border border-slate-200 rounded-xl p-3 shadow-sm hover:shadow-md transition-all group relative">
                    <div className="flex gap-3 mb-3">
                      <input 
                        ref={el => { if(el) columnInputRefs.current.set(col.id, el); }}
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
                        <optgroup label="Other"><option value="bool">boolean</option><option value="bytea">bytea</option></optgroup>
                      </select>
                      <button onClick={() => handleRemoveColumnItem(col.id)} className="p-2 text-slate-300 hover:text-rose-500 transition-colors"><X size={14}/></button>
                    </div>
                    <div className="flex items-center gap-3 bg-slate-50 p-2 rounded-lg relative">
                       <input list={`defaults-${col.id}`} value={col.defaultValue} onChange={(e) => handleColumnChange(col.id, 'defaultValue', e.target.value)} placeholder="Default Value (NULL)" className="flex-1 bg-transparent border-none text-[10px] font-mono text-slate-600 outline-none placeholder:text-slate-300"/>
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
              <button onClick={handleAddColumnItem} className="w-full py-3 border border-dashed border-slate-300 rounded-xl text-slate-400 text-xs font-bold hover:bg-slate-50 hover:text-indigo-600 hover:border-indigo-300 transition-all flex items-center justify-center gap-2"><Plus size={14}/> Add Column</button>
            </div>
          </div>
          <div className="p-6 border-t border-slate-100 bg-slate-50/50 flex gap-4">
             <button onClick={() => setShowCreateTable(false)} className="flex-1 py-3 text-xs font-black text-slate-400 uppercase tracking-widest hover:text-slate-600">Cancel</button>
             <button 
                onClick={() => {
                    if (!newTableName) { setError("Table name is required."); return; }
                    if (newTableCols.length === 0) { setError("At least one column is required."); return; }
                    
                    try {
                        const safeName = sanitizeName(newTableName);
                        const colDefs = newTableCols.map(c => {
                            const finalType = c.isArray ? `${c.type}[]` : c.type;
                            let def = `  "${c.name}" ${finalType}`;
                            if (c.isPrimaryKey) def += ' PRIMARY KEY';
                            if (!c.isNullable && !c.isPrimaryKey) def += ' NOT NULL';
                            if (c.defaultValue) def += ` DEFAULT ${c.defaultValue}`;
                            // CORRECTION: Only add UNIQUE if it's NOT a Primary Key (PK implies unique)
                            if (c.isUnique && !c.isPrimaryKey) def += ' UNIQUE';
                            if (c.foreignKey) def += ` REFERENCES public."${c.foreignKey.table}"("${c.foreignKey.column}")`;
                            return def;
                        });

                        let sql = `-- Generated by Table Designer\nCREATE TABLE public."${safeName}" (\n${colDefs.join(',\n')}\n);\n\n-- Security\nALTER TABLE public."${safeName}" ENABLE ROW LEVEL SECURITY;`;
                        
                        // Permissions
                        sql += `\n\n-- Permissions\nGRANT SELECT, INSERT, UPDATE, DELETE ON public."${safeName}" TO anon, authenticated, service_role;\nGRANT ALL ON public."${safeName}" TO service_role;`;

                        if (newTableDesc) sql += `\n\nCOMMENT ON TABLE public."${safeName}" IS '${newTableDesc.replace(/'/g, "''")}';`;
                        sql += `\n\n-- Realtime Trigger\nCREATE TRIGGER ${newTableName}_changes \nAFTER INSERT OR UPDATE OR DELETE ON public."${safeName}" \nFOR EACH ROW EXECUTE FUNCTION public.notify_changes();`;

                        if (importPendingData && importPendingData.length > 0) {
                            const limit = 500;
                            const dataToInsert = importPendingData.slice(0, limit);
                            sql += `\n\n-- Initial Data (${dataToInsert.length} rows)\n`;
                            const colNames = newTableCols.map(c => `"${c.name}"`).join(', ');
                            const values = dataToInsert.map(row => {
                                const rowVals = newTableCols.map(c => {
                                    const sourceKey = c.sourceHeader || c.name;
                                    let val = row[sourceKey];
                                    if (val === undefined || val === '' || val === null) return 'NULL';
                                    if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
                                    return val;
                                });
                                return `(${rowVals.join(', ')})`;
                            });
                            sql += `INSERT INTO public."${safeName}" (${colNames}) VALUES\n${values.join(',\n')};`;
                            if (importPendingData.length > limit) sql += `\n\n-- NOTE: Import truncated. ${importPendingData.length - limit} rows omitted for editor performance.`;
                        }

                        setQuery(sql);
                        setActiveTab('query');
                        setShowCreateTable(false);
                        setSuccessMsg("SQL generated in Editor.");
                        setNewTableName('');
                        setNewTableDesc('');
                        setImportPendingData(null);
                        setImportPreview([]);
                        setNewTableCols([
                            { id: getUUID(), name: 'id', type: 'uuid', defaultValue: 'gen_random_uuid()', isPrimaryKey: true, isNullable: false, isUnique: true, isArray: false, description: 'Unique Identifier' },
                            { id: '2', name: 'created_at', type: 'timestamptz', defaultValue: 'now()', isPrimaryKey: false, isNullable: false, isUnique: false, isArray: false, description: 'Creation Timestamp' },
                        ]);
                    } catch (e: any) { setError(e.message); }
                }} 
                disabled={executing} 
                className="flex-[2] bg-indigo-600 text-white py-3 rounded-xl text-xs font-black uppercase tracking-widest shadow-xl hover:bg-indigo-700 transition-all flex items-center justify-center gap-2"
             >
                {executing ? <Loader2 size={14} className="animate-spin"/> : 'Generate SQL'}
             </button>
          </div>
        </div>
      </div>

      {/* MODALS */}
      {showDeleteModal.active && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
           <div className="bg-white rounded-[3rem] p-10 max-w-md w-full shadow-2xl border border-slate-200 text-center">
              <div className="w-16 h-16 bg-rose-50 text-rose-600 rounded-2xl flex items-center justify-center mx-auto mb-6"><Trash2 size={32}/></div>
              <h3 className="text-2xl font-black text-slate-900 mb-2">Delete {showDeleteModal.table}</h3>
              <p className="text-xs text-slate-500 font-bold mb-8">Choose deletion strategy.</p>
              <div className="flex gap-2 p-1 bg-slate-100 rounded-2xl mb-6">
                 <button onClick={() => setShowDeleteModal({...showDeleteModal, mode: 'SOFT'})} className={`flex-1 py-3 rounded-xl text-[10px] font-black uppercase transition-all ${showDeleteModal.mode === 'SOFT' ? 'bg-white shadow text-indigo-600' : 'text-slate-400'}`}>Move to Trash</button>
                 <button onClick={() => setShowDeleteModal({...showDeleteModal, mode: 'HARD'})} className={`flex-1 py-3 rounded-xl text-[10px] font-black uppercase transition-all ${showDeleteModal.mode === 'HARD' ? 'bg-rose-600 shadow text-white' : 'text-slate-400'}`}>Destroy</button>
              </div>
              {showDeleteModal.mode === 'HARD' && (<input type="password" placeholder="Admin Password" value={verifyPassword} onChange={e => setVerifyPassword(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-center font-bold text-slate-900 outline-none mb-6 focus:ring-4 focus:ring-rose-500/10" />)}
              <button onClick={handleDeleteTable} disabled={executing || (showDeleteModal.mode === 'HARD' && !verifyPassword)} className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-600 transition-all">{executing ? <Loader2 className="animate-spin mx-auto"/> : 'Confirm Action'}</button>
              <button onClick={() => setShowDeleteModal({active:false, table:'', mode:'SOFT'})} className="mt-4 text-xs font-bold text-slate-400 hover:text-slate-600">Cancel</button>
           </div>
        </div>
      )}

      {showTrashModal && (
         <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
            <div className="bg-white rounded-[3rem] p-10 max-w-lg w-full shadow-2xl border border-slate-200 relative">
               <button onClick={() => setShowTrashModal(false)} className="absolute top-8 right-8 text-slate-300 hover:text-slate-900"><X size={24}/></button>
               <h3 className="text-2xl font-black text-slate-900 mb-6 flex items-center gap-3"><Trash2 size={24}/> Recycle Bin</h3>
               <div className="space-y-3 max-h-[400px] overflow-y-auto">
                  {recycleBin.length === 0 && <p className="text-center text-slate-400 py-10 font-bold text-xs uppercase">Bin is empty</p>}
                  {recycleBin.map(t => (
                      <div key={t.name} className="flex items-center justify-between bg-slate-50 p-4 rounded-2xl border border-slate-100 group">
                          <span className="text-xs font-bold text-slate-700 truncate max-w-[150px]">{t.name}</span>
                          <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button onClick={() => handleExportRecycled(t.name, 'sql')} className="p-2 bg-white text-indigo-600 rounded-lg shadow-sm hover:bg-indigo-50" title="Export SQL"><Code size={14}/></button>
                              <button onClick={() => handleExportRecycled(t.name, 'csv')} className="p-2 bg-white text-indigo-600 rounded-lg shadow-sm hover:bg-indigo-50" title="Export CSV"><FileSpreadsheet size={14}/></button>
                              <button onClick={() => handleRestore(t.name)} className="p-2 bg-emerald-100 text-emerald-700 rounded-lg hover:bg-emerald-200" title="Restore"><RotateCcw size={14}/></button>
                          </div>
                      </div>
                  ))}
               </div>
            </div>
         </div>
      )}

      {/* NEW: DUPLICATE TABLE MODAL */}
      {showDuplicateModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
           <div className="bg-white rounded-[3rem] w-full max-w-sm p-12 shadow-2xl border border-slate-100 relative">
              <h3 className="text-xl font-black text-slate-900 mb-6">Duplicate Table</h3>
              <div className="space-y-4 mb-6">
                 <div className="space-y-1"><label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">New Table Name</label><input autoFocus value={duplicateConfig.newName} onChange={(e) => setDuplicateConfig({...duplicateConfig, newName: e.target.value})} className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 font-bold text-sm outline-none" placeholder={duplicateConfig.source + '_copy'} /></div>
                 <div className="flex items-center gap-3 p-2 cursor-pointer" onClick={() => setDuplicateConfig({...duplicateConfig, withData: !duplicateConfig.withData})}><div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${duplicateConfig.withData ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300'}`}>{duplicateConfig.withData && <Check size={14} className="text-white"/>}</div><span className="text-xs font-bold text-slate-600">Copy Data Rows</span></div>
              </div>
              <button onClick={handleDuplicateTableSubmit} disabled={executing || !duplicateConfig.newName} className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-700 transition-all mb-3">{executing ? <Loader2 className="animate-spin mx-auto"/> : 'Duplicate'}</button>
              <button onClick={() => setShowDuplicateModal(false)} className="w-full py-2 text-xs font-bold text-slate-400 hover:text-slate-600">Cancel</button>
           </div>
        </div>
      )}

      {/* ADD COLUMN MODAL (ENHANCED) */}
      {showAddColumn && (
         <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
            <div className="bg-white rounded-[3rem] p-10 max-w-sm w-full shadow-2xl border border-slate-200 text-center">
               <h3 className="text-xl font-black text-slate-900 mb-6">Add New Column</h3>
               <div className="space-y-4 mb-6 text-left">
                  
                  {/* Name */}
                  <div className="space-y-1">
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">Column Name</label>
                    <input 
                        value={newColumn.name} 
                        onChange={e => setNewColumn({...newColumn, name: sanitizeName(e.target.value)})} 
                        placeholder="column_name" 
                        autoFocus
                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 font-bold text-sm outline-none focus:ring-2 focus:ring-indigo-500/20" 
                    />
                  </div>

                  {/* Description */}
                  <div className="space-y-1">
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">Description</label>
                    <input 
                        value={newColumn.description} 
                        onChange={e => setNewColumn({...newColumn, description: e.target.value})} 
                        placeholder="Semantic hint for AI..." 
                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 font-medium text-sm outline-none text-slate-600" 
                    />
                  </div>

                  {/* Smart Type Selector */}
                  <div className="space-y-1">
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">Data Type</label>
                    <select 
                        value={newColumn.type} 
                        onChange={e => setNewColumn({...newColumn, type: e.target.value})} 
                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 font-bold text-sm outline-none cursor-pointer"
                    >
                        <optgroup label="Numbers"><option value="int8">int8 (BigInt)</option><option value="int4">int4 (Integer)</option><option value="numeric">numeric</option><option value="float8">float8</option></optgroup>
                        <optgroup label="Text"><option value="text">text</option><option value="varchar">varchar</option><option value="uuid">uuid</option></optgroup>
                        <optgroup label="Date/Time"><option value="timestamptz">timestamptz</option><option value="date">date</option><option value="time">time</option></optgroup>
                        <optgroup label="JSON"><option value="jsonb">jsonb</option><option value="json">json</option></optgroup>
                        <optgroup label="Other"><option value="bool">boolean</option><option value="bytea">bytea</option></optgroup>
                    </select>
                  </div>

                  {/* Toggles & Options */}
                  <div className="flex items-center justify-between bg-slate-50 p-2 rounded-2xl border border-slate-100">
                      <div className="flex items-center gap-2">
                        <div title="Nullable" onClick={() => setNewColumn({...newColumn, isNullable: !newColumn.isNullable})} className={`px-2 py-1.5 rounded-xl text-[10px] font-black cursor-pointer select-none transition-all ${newColumn.isNullable ? 'bg-emerald-100 text-emerald-700' : 'text-slate-400 hover:bg-slate-200'}`}>NULL</div>
                        <div title="Unique" onClick={() => setNewColumn({...newColumn, isUnique: !newColumn.isUnique})} className={`px-2 py-1.5 rounded-xl text-[10px] font-black cursor-pointer select-none transition-all ${newColumn.isUnique ? 'bg-purple-100 text-purple-700' : 'text-slate-400 hover:bg-slate-200'}`}>UNIQ</div>
                      </div>
                      
                      {/* Foreign Key Toggle */}
                      <div 
                        onClick={async () => {
                            if (!newColumn.foreignKey) {
                                // Enable FK Mode
                                setNewColumn({...newColumn, foreignKey: { table: '', column: '' }});
                            } else {
                                // Disable FK Mode
                                setNewColumn({...newColumn, foreignKey: undefined});
                            }
                        }}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-[10px] font-black cursor-pointer select-none transition-all ${newColumn.foreignKey ? 'bg-blue-100 text-blue-700 shadow-sm' : 'text-slate-400 hover:bg-slate-200'}`}
                      >
                        <LinkIcon size={12} strokeWidth={3} /> {newColumn.foreignKey ? 'LINKED' : 'LINK'}
                      </div>
                  </div>

                  {/* Foreign Key Configuration (Conditional) */}
                  {newColumn.foreignKey && (
                      <div className="space-y-3 bg-blue-50/50 p-3 rounded-2xl border border-blue-100 animate-in slide-in-from-top-2">
                          <div className="space-y-1">
                              <label className="text-[9px] font-black text-blue-400 uppercase tracking-widest ml-1">Target Table</label>
                              <select 
                                value={newColumn.foreignKey.table}
                                onChange={async (e) => {
                                    const tbl = e.target.value;
                                    setNewColumn(prev => ({ ...prev, foreignKey: { table: tbl, column: '' } }));
                                    if (tbl) {
                                        setFkLoading(true);
                                        try {
                                            const res = await fetchWithAuth(`/api/data/${projectId}/tables/${tbl}/columns`);
                                            setFkTargetColumns(res.map((c:any) => c.name));
                                            if (res.length > 0) {
                                                const defaultCol = res.find((c:any) => c.name === 'id') ? 'id' : res[0].name;
                                                setNewColumn(prev => ({ ...prev, foreignKey: { table: tbl, column: defaultCol } }));
                                            }
                                        } catch(err) {} finally { setFkLoading(false); }
                                    }
                                }}
                                className="w-full bg-white border border-blue-200 rounded-xl py-2 px-3 text-xs font-bold text-slate-700 outline-none"
                              >
                                  <option value="">Select Table...</option>
                                  {tables.filter(t => t.name !== selectedTable).map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
                              </select>
                          </div>
                          {newColumn.foreignKey.table && (
                              <div className="space-y-1">
                                  <label className="text-[9px] font-black text-blue-400 uppercase tracking-widest ml-1">Target Column</label>
                                  {fkLoading ? <div className="py-2 flex justify-center"><Loader2 size={14} className="animate-spin text-blue-500"/></div> : (
                                      <select 
                                        value={newColumn.foreignKey.column}
                                        onChange={(e) => setNewColumn(prev => ({ ...prev, foreignKey: { ...prev.foreignKey!, column: e.target.value } }))}
                                        className="w-full bg-white border border-blue-200 rounded-xl py-2 px-3 text-xs font-bold text-slate-700 outline-none"
                                      >
                                          {fkTargetColumns.map(c => <option key={c} value={c}>{c}</option>)}
                                      </select>
                                  )}
                              </div>
                          )}
                      </div>
                  )}

                  {/* Smart Default Value */}
                  <div className="space-y-1">
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">Default Value</label>
                    <input 
                        list="modal-defaults"
                        value={newColumn.defaultValue} 
                        onChange={e => setNewColumn({...newColumn, defaultValue: e.target.value})} 
                        placeholder="NULL (Optional)" 
                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 font-mono text-xs font-medium text-slate-600 outline-none focus:ring-2 focus:ring-indigo-500/20" 
                    />
                    <datalist id="modal-defaults">
                        {getDefaultSuggestions(newColumn.type).map(s => <option key={s} value={s} />)}
                    </datalist>
                  </div>

               </div>
               <button onClick={handleAddColumn} disabled={executing} className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-700 transition-all flex items-center justify-center gap-2">
                  {executing ? <Loader2 className="animate-spin" size={16}/> : 'Create Column'}
               </button>
               <button onClick={() => setShowAddColumn(false)} className="mt-4 text-xs font-bold text-slate-400 hover:text-slate-600 transition-colors">Cancel</button>
            </div>
         </div>
      )}

      {/* IMPORT MODAL */}
      {showImportModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[250] flex items-center justify-center p-8 animate-in zoom-in-95">
           <div className="bg-white rounded-[3.5rem] w-full max-w-lg p-12 shadow-2xl border border-slate-100 relative">
              <button onClick={() => setShowImportModal(false)} className="absolute top-8 right-8 text-slate-300 hover:text-slate-900 transition-colors"><X size={24}/></button>
              <h3 className="text-3xl font-black text-slate-900 tracking-tighter mb-8">Data Import</h3>
              <div className="space-y-6">
                 {/* RESTORED TOGGLE */}
                 <div className="flex items-center justify-between bg-slate-50 p-4 rounded-2xl">
                    <span className="text-xs font-bold text-slate-700">Create new table from file</span>
                    <button onClick={() => setCreateTableFromImport(!createTableFromImport)} className={`w-12 h-7 rounded-full p-1 transition-colors ${createTableFromImport ? 'bg-indigo-600' : 'bg-slate-200'}`}>
                       <div className={`w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${createTableFromImport ? 'translate-x-5' : ''}`}></div>
                    </button>
                 </div>
                 
                 <div className="border-4 border-dashed border-slate-100 rounded-[2.5rem] p-10 text-center hover:border-emerald-300 hover:bg-emerald-50/10 transition-all cursor-pointer relative group">
                    <input type="file" accept=".csv, .xlsx, .json" onChange={(e) => setImportFile(e.target.files?.[0] || null)} className="absolute inset-0 opacity-0 cursor-pointer" />
                    {importFile ? <span className="font-bold text-slate-900">{importFile.name}</span> : <div className="flex flex-col items-center text-slate-300 group-hover:text-emerald-500"><Upload size={40} className="mb-2"/><span className="font-bold text-sm">Drop file here</span></div>}
                 </div>
                 
                 <button onClick={handleImport} disabled={!importFile || executing} className="w-full bg-slate-900 text-white py-5 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl flex items-center justify-center gap-3 disabled:opacity-50">
                    {executing ? <Loader2 className="animate-spin" size={18}/> : 'Start Ingestion'}
                 </button>
              </div>
           </div>
        </div>
      )}

      {/* CONTEXT MENU */}
      {contextMenu && (
        <div className="fixed z-[100] bg-white border border-slate-200 shadow-2xl rounded-2xl p-2 w-56 animate-in fade-in zoom-in-95" style={{ top: contextMenu.y, left: contextMenu.x }}>
           {/* VIEW SWITCHER */}
           {activeTab === 'tables' ? (
               <button onClick={() => { setActiveTab('query'); setSelectedTable(contextMenu.table); setQuery(`SELECT * FROM public."${contextMenu.table}" LIMIT 100;`); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl transition-all"><Terminal size={14}/> Open in SQL Editor</button>
           ) : (
               <button onClick={() => { setActiveTab('tables'); setSelectedTable(contextMenu.table); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl transition-all"><TableIcon size={14}/> Open in Grid View</button>
           )}
           
           <div className="h-[1px] bg-slate-100 my-1"></div>
           
           <button onClick={() => { setSelectedTable(contextMenu.table); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl transition-all"><MousePointer2 size={14}/> Select</button>
           <button onClick={() => { handleCopyStructure(); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl transition-all"><Code size={14}/> Copy SQL</button>
           <button onClick={() => { setDuplicateConfig({ source: contextMenu.table, newName: contextMenu.table + '_copy', withData: false }); setShowDuplicateModal(true); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl transition-all"><Layers size={14}/> Duplicate</button>
           
           <div className="h-[1px] bg-slate-100 my-1"></div>
           
           <button onClick={() => { setShowDeleteModal({ active: true, table: contextMenu.table, mode: 'SOFT' }); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-rose-600 hover:bg-rose-50 rounded-xl transition-all"><Trash2 size={14}/> Delete Table</button>
        </div>
      )}
    </div>
  );
};

export default DatabaseExplorer;
