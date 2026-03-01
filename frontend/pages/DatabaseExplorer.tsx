import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { TablePanelHandle } from '../components/database/TablePanel';
import {
  Database, Search, Table as TableIcon, Loader2, AlertCircle, Plus, X,
  Terminal, Trash2, Download, Upload, Copy, ChevronLeft, ChevronRight, ChevronDown, ChevronUp,
  CheckCircle2, Save, Key, RefreshCw, Puzzle, FileType, FileSpreadsheet, FileJson,
  RotateCcw, GripVertical, MousePointer2, Layers, AlertTriangle, Check, Link as LinkIcon, Code, Eye, Edit, Shield, Lock
} from 'lucide-react';
import jsPDF from 'jspdf';
import 'jspdf-autotable';

// Import New Modular Components
import ExtensionsModal from '../components/database/ExtensionsModal';
import SqlConsole from '../components/database/SqlConsole';
import TableCreatorDrawer from '../components/database/TableCreatorDrawer';
import ColumnImpactModal from '../components/database/ColumnImpactModal';
import { scanColumnDependencies, DependencyItem } from '../lib/ColumnImpactScanner';
import { scanTableDependencies, buildTableRenameCascadeSQL } from '../lib/TableImpactScanner';
import TablePanel from '../components/database/TablePanel';

// Helper Functions
const getUUID = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    try { return crypto.randomUUID(); } catch (e) { /* ignore */ }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c: any) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

const copyToClipboard = async (text: string) => {
  // Try modern Clipboard API first (requires HTTPS / secure context)
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  }
  // Fallback for HTTP contexts (VPS without HTTPS)
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch { return false; }
};

const sanitizeName = (val: string) => {
  return val.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^[0-9]/, "_");
};

const sanitizeForCSV = (value: any) => {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
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

const IDENTITY_COMPATIBLE_TYPES_SET = new Set(['int2', 'int4', 'int8']);
const SERIAL_TYPES_SET = new Set(['serial', 'bigserial', 'smallserial']);

const getDefaultSuggestions = (type: string, hasIdentity?: boolean) => {
  if (hasIdentity) return [];
  const t = type.toLowerCase();
  if (t === 'uuid') return ['gen_random_uuid()'];
  if (t.includes('timestamp') || t === 'date') return ['now()', 'current_timestamp', 'current_date', "timezone('utc', now())"];
  if (t === 'time') return ['current_time', 'localtime'];
  if (t === 'interval') return ["'1 hour'::interval", "'30 days'::interval", "'0'::interval"];
  if (t === 'boolean' || t === 'bool') return ['true', 'false'];
  if (IDENTITY_COMPATIBLE_TYPES_SET.has(t)) return ['0', '1'];
  if (t.includes('numeric') || t.includes('float') || t === 'float8' || t === 'money') return ['0', '1'];
  if (t.includes('json')) return ["'{}'::jsonb", "'[]'::jsonb", "'null'::jsonb"];
  if (t === 'text' || t === 'varchar') return ["''", 'current_user', 'session_user'];
  if (t === 'inet') return ["'0.0.0.0'::inet", 'inet_client_addr()'];
  if (t === 'point') return ["'(0,0)'::point"];
  if (t === 'bytea') return ["'\\x'::bytea"];
  return [];
};

// Column definition type (shared with TableCreatorDrawer)
interface ColumnDef {
  id: string;
  name: string;
  type: string;
  defaultValue: string;
  isPrimaryKey: boolean;
  isNullable: boolean;
  isUnique: boolean;
  isArray: boolean;
  foreignKey?: { schema: string; table: string; column: string };
  sourceHeader?: string;
  description?: string;
  formatPreset?: string;
  formatPattern?: string;
}

// Format presets for column validation (mirrored from backend)
const FORMAT_PRESETS: Record<string, { label: string; regex: string; example: string; description: string }> = {
  email: { label: 'Email', regex: '^[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}$', example: 'user@example.com', description: 'Endereço de e-mail válido' },
  cpf: { label: 'CPF', regex: '^\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}$', example: '123.456.789-00', description: 'CPF no formato XXX.XXX.XXX-XX' },
  cnpj: { label: 'CNPJ', regex: '^\\d{2}\\.\\d{3}\\.\\d{3}\\/\\d{4}-\\d{2}$', example: '12.345.678/0001-99', description: 'CNPJ no formato XX.XXX.XXX/XXXX-XX' },
  phone_br: { label: 'Phone (BR)', regex: '^\\+?55\\s?\\(?\\d{2}\\)?\\s?\\d{4,5}-?\\d{4}$', example: '+55 (11) 99999-1234', description: 'Telefone brasileiro com DDD' },
  cep: { label: 'CEP', regex: '^\\d{5}-?\\d{3}$', example: '01310-100', description: 'CEP brasileiro' },
  url: { label: 'URL', regex: '^https?:\\/\\/[a-zA-Z0-9\\-]+(\\.[a-zA-Z0-9\\-]+)+(\\/.*)?$', example: 'https://example.com', description: 'URL com http ou https' },
  uuid_format: { label: 'UUID', regex: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID v4 padrão' },
  date_br: { label: 'Date (BR)', regex: '^\\d{2}\\/\\d{2}\\/\\d{4}$', example: '25/02/2026', description: 'Data no formato DD/MM/AAAA' },
};

// Main Component
const DatabaseExplorer: React.FC<{ projectId: string }> = ({ projectId }) => {
  // --- STATE ---
  const [activeSchema, setActiveSchema] = useState('public');
  const [schemas, setSchemas] = useState<string[]>(['public']);
  const [activeTab, setActiveTab] = useState<'tables' | 'query'>('tables');
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<{ schema: string, table: string }[]>([]);
  const [dbInfo, setDbInfo] = useState<any>(null);
  const [clipboardFallbackSQL, setClipboardFallbackSQL] = useState<string | null>(null);

  // Focus and select textarea text automatically when the fallback modal appears
  const fallbackTextareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (clipboardFallbackSQL && fallbackTextareaRef.current) {
      fallbackTextareaRef.current.focus();
      fallbackTextareaRef.current.select();
    }
  }, [clipboardFallbackSQL]);

  // Auth/Init logic
  const [tables, setTables] = useState<any[]>([]);
  const [recycleBin, setRecycleBin] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRealtimeActive, setIsRealtimeActive] = useState(false);

  // --- State also used by modals/export/import/realtime (TablePanel has own copies) ---
  const [tableData, setTableData] = useState<any[]>([]);
  const [columns, setColumns] = useState<any[]>([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [pageStart, setPageStart] = useState(0);
  const [sortConfig, setSortConfig] = useState<{ column: string, direction: 'asc' | 'desc' } | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [selectedRows, setSelectedRows] = useState<Set<any>>(new Set());
  const [columnOrder, setColumnOrder] = useState<string[]>([]);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [draggingColumn, setDraggingColumn] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);

  // --- PINNED TABLES (Multi-table side-by-side) ---
  const [pinnedTables, setPinnedTables] = useState<string[]>([]);

  // Additional Features State
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [showRecycleBinModal, setShowRecycleBinModal] = useState(false);
  const [recycleBinPassword, setRecycleBinPassword] = useState('');
  const [recycleBinAction, setRecycleBinAction] = useState<{ type: 'restore' | 'purge'; table: string } | null>(null);
  const [recycleBinError, setRecycleBinError] = useState('');
  const [searchFilter, setSearchFilter] = useState('');
  const [columnContextMenu, setColumnContextMenu] = useState<{ x: number; y: number; col: string; table: string; lockLevel: string } | null>(null);
  const [editLock, setEditLock] = useState<{ column: string; table: string; currentLevel: string } | null>(null);
  const [dragOverTable, setDragOverTable] = useState<string | null>(null);

  // Protocolo Cascata — Column Impact Scan State
  const [impactScan, setImpactScan] = useState<{
    action: 'rename' | 'delete';
    column: string;
    newName?: string;
    dependencies: DependencyItem[];
    isScanning: boolean;
  } | null>(null);

  // Protocolo Cascata — Table Rename Impact Scan State
  const [tableImpactScan, setTableImpactScan] = useState<{
    oldName: string;
    newName: string;
    dependencies: DependencyItem[];
    cascadeSQL: string;
    isScanning: boolean;
  } | null>(null);

  // --- NEW: ADD COLUMN MODAL ---
  const [showAddColumn, setShowAddColumn] = useState(false);
  const [newColumn, setNewColumn] = useState<{
    name: string;
    type: string;
    isNullable: boolean;
    isArray: boolean;
    defaultValue: string;
    isUnique: boolean;
    description: string;
    identityGeneration?: 'always' | 'by_default';
    foreignKey?: { schema: string, table: string, column: string };
    fkSchema: string;
    formatPreset: string;
    formatPattern: string;
  }>({
    name: '', type: 'text', isNullable: true, isArray: false, defaultValue: '', isUnique: false, description: '', fkSchema: 'public', formatPreset: '', formatPattern: ''
  });
  const [fkTargetColumns, setFkTargetColumns] = useState<string[]>([]);
  const [fkTargetTables, setFkTargetTables] = useState<any[]>([]);
  const [fkLoading, setFkLoading] = useState(false);

  // --- TablePanel Refs (for imperative refresh) ---
  const tablePanelRefs = useRef<Map<string, TablePanelHandle>>(new Map());

  // UI State
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);

  // Modals
  const [showExtensions, setShowExtensions] = useState(false);
  const [extensions, setExtensions] = useState<any[]>([]);
  const [extensionLoadingName, setExtensionLoadingName] = useState<string | null>(null);

  // --- RESTORED DRAWER STATE ---
  const [showCreateTable, setShowCreateTable] = useState(false);
  const [newTableName, setNewTableName] = useState('');
  const [initialColumns, setInitialColumns] = useState<ColumnDef[] | undefined>(undefined);

  // --- IMPORT STATE ---
  const [importPendingData, setImportPendingData] = useState<any[] | null>(null);
  const [importPreview, setImportPreview] = useState<any[]>([]);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [createTableFromImport, setCreateTableFromImport] = useState(false);

  // Feedback
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  // Editing State (still used by surviving functions)
  const [editingCell, setEditingCell] = useState<{ rowId: any, col: string } | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  const [inlineNewRow, setInlineNewRow] = useState<any>({});
  const firstInputRef = useRef<HTMLInputElement>(null);

  // Drag State
  const [draggedTable, setDraggedTable] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, table: string } | null>(null);

  // --- DUPLICATE MODAL ---
  const [showDuplicateModal, setShowDuplicateModal] = useState(false);
  const [duplicateConfig, setDuplicateConfig] = useState({ source: '', newName: '', withData: false });

  // --- EDIT FORMAT MODAL ---
  const [editFormat, setEditFormat] = useState<{
    column: string;
    preset: string;
    customPattern: string;
    columnType: string;
  } | null>(null);

  // Refs for Sql Console State Lifting
  const [sqlInitial, setSqlInitial] = useState('');

  // --- GLOBAL ESC HANDLER: CLOSE ANY OPEN MODAL/DRAWER/POPUP ---
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Priority order: innermost popups first, then modals, then drawers
      if (recycleBinAction) { setRecycleBinAction(null); setRecycleBinPassword(''); setRecycleBinError(''); return; }
      if (showRecycleBinModal) { setShowRecycleBinModal(false); return; }
      if (editLock) { setEditLock(null); return; }
      if (columnContextMenu) { setColumnContextMenu(null); return; }
      if (impactScan) { setImpactScan(null); return; }
      if (tableImpactScan) { setTableImpactScan(null); return; }
      if (showAddColumn) { setShowAddColumn(false); return; }
      if (showImportModal) { setShowImportModal(false); return; }
      if (showExportMenu) { setShowExportMenu(false); return; }
      if (showExtensions) { setShowExtensions(false); return; }
      if (showCreateTable) { setShowCreateTable(false); setInitialColumns(undefined); return; }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [recycleBinAction, showRecycleBinModal, editLock, columnContextMenu, impactScan, tableImpactScan, showAddColumn, showImportModal, showExportMenu, showExtensions, showCreateTable]);

  // --- NOTIFICATION AUTO-DISMISS (3.8s with hover pause) ---
  const notifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notifyStartRef = useRef<number>(0);
  const notifyRemainingRef = useRef<number>(3800);

  const clearNotifyTimer = useCallback(() => {
    if (notifyTimerRef.current) { clearTimeout(notifyTimerRef.current); notifyTimerRef.current = null; }
  }, []);

  const startNotifyTimer = useCallback((ms: number) => {
    clearNotifyTimer();
    notifyStartRef.current = Date.now();
    notifyRemainingRef.current = ms;
    notifyTimerRef.current = setTimeout(() => {
      setError(null);
      setSuccessMsg(null);
    }, ms);
  }, [clearNotifyTimer]);

  const handleNotifyPause = useCallback(() => {
    clearNotifyTimer();
    const elapsed = Date.now() - notifyStartRef.current;
    notifyRemainingRef.current = Math.max(0, notifyRemainingRef.current - elapsed);
  }, [clearNotifyTimer]);

  const handleNotifyResume = useCallback(() => {
    if (notifyRemainingRef.current > 0) startNotifyTimer(notifyRemainingRef.current);
  }, [startNotifyTimer]);

  // Triggers auto-dismiss whenever error/successMsg changes
  useEffect(() => {
    if (error || successMsg) {
      notifyRemainingRef.current = 3800;
      startNotifyTimer(3800);
    } else {
      clearNotifyTimer();
    }
    return clearNotifyTimer;
  }, [error, successMsg, startNotifyTimer, clearNotifyTimer]);

  const pkCol = columns.find(c => c.isPrimaryKey)?.name || columns[0]?.name;
  const displayColumns = columnOrder.length > 0 ? columnOrder.map(name => columns.find(c => c.name === name)).filter(Boolean) : columns;

  // --- ATOMIC SCHEMA SWITCH ---
  // This MUST be used everywhere instead of raw setActiveSchema to prevent 404 race conditions.
  // It clears all table-related state in the SAME React batch as the schema change,
  // so no render ever has newSchema + oldTable.
  const switchSchema = useCallback((newSchema: string) => {
    if (newSchema === activeSchema) return;
    setSelectedTable(null);
    setPinnedTables([]);
    setPageStart(0);
    setActiveSchema(newSchema);
  }, [activeSchema]);

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
  const fetchSchemas = async () => {
    try {
      const data = await fetchWithAuth(`/api/data/${projectId}/schemas`);
      const mapped = data.map((s: any) => s.name);
      setSchemas(mapped.length > 0 ? mapped : ['public']);
    } catch (e) {
      console.error('Failed to load schemas', e);
    }
  };

  const fetchTables = async () => {
    setLoading(true);
    try {
      const data = await fetchWithAuth(`/api/data/${projectId}/tables?schema=${activeSchema}`);
      const recycleBinData = await fetchWithAuth(`/api/data/${projectId}/recycle-bin?schema=${activeSchema}`).catch(() => []);
      setRecycleBin(recycleBinData);

      // Apply persisted table order from localStorage
      const savedOrder = localStorage.getItem(`cascata_table_order_${projectId}_${activeSchema}`);
      let sortedData = data;
      if (savedOrder) {
        try {
          const order: string[] = JSON.parse(savedOrder);
          const ordered = order.map(name => data.find((t: any) => t.name === name)).filter(Boolean);
          const remaining = data.filter((t: any) => !order.includes(t.name));
          sortedData = [...ordered, ...remaining];
        } catch { /* ignore parse errors */ }
      }
      setTables(sortedData);

      // Auto select first table if current is wiped
      if (sortedData.length > 0 && !sortedData.find((t: any) => t.name === selectedTable)) {
        setSelectedTable(sortedData[0].name);
        setPinnedTables([sortedData[0].name]);
      } else if (sortedData.length === 0) {
        setSelectedTable(null);
        setPinnedTables([]);
        setTableData([]);
      }
    } catch (e: any) { setError(translateError(e)); }
    finally { setLoading(false); }
  };

  const fetchTableData = async (tableName: string, keepSelection = false) => {
    setDataLoading(true);
    if (!keepSelection) setSelectedRows(new Set());
    try {
      let url = `/api/data/${projectId}/tables/${tableName}/data?limit=100&offset=${pageStart}&schema=${activeSchema}`;
      if (sortConfig) url += `&sortColumn=${sortConfig.column}&sortDirection=${sortConfig.direction}`;

      const [rows, cols, settings] = await Promise.all([
        fetchWithAuth(url),
        fetchWithAuth(`/api/data/${projectId}/tables/${tableName}/columns?schema=${activeSchema}`),
        fetchWithAuth(`/api/data/${projectId}/ui-settings/${tableName}?schema=${activeSchema}`)
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
        body: JSON.stringify({ name, schema: 'extensions' })
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

  const verifyAdminPassword = async (password: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/control/auth/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`
        },
        body: JSON.stringify({ password })
      });
      return res.ok;
    } catch { return false; }
  };

  const handleRestoreTable = async (forceTableName?: string) => {
    const target = forceTableName || restoreTarget;
    if (!target) return;
    setExecuting(true);
    try {
      await fetchWithAuth(`/api/data/${projectId}/recycle-bin/${target}/restore?schema=${activeSchema}`, { method: 'POST' });
      setSuccessMsg(`Table restored.`);
      setRestoreTarget(null);
      setRecycleBinAction(null);
      setRecycleBinPassword('');
      setRecycleBinError('');
      fetchTables();
    } catch (err: any) { setError(translateError(err)); }
    finally { setExecuting(false); }
  };

  const handlePurgeTable = async (tableName: string) => {
    setExecuting(true);
    try {
      await fetchWithAuth(`/api/data/${projectId}/tables/${tableName}`, {
        method: 'DELETE',
        body: JSON.stringify({ mode: 'CASCADE' })
      });
      setSuccessMsg(`Table permanently deleted.`);
      setRecycleBinAction(null);
      setRecycleBinPassword('');
      setRecycleBinError('');
      fetchTables();
    } catch (err: any) { setError(translateError(err)); }
    finally { setExecuting(false); }
  };

  const handleRecycleBinConfirm = async () => {
    if (!recycleBinAction) return;
    setRecycleBinError('');
    const valid = await verifyAdminPassword(recycleBinPassword);
    if (!valid) { setRecycleBinError('Invalid admin password.'); return; }
    if (recycleBinAction.type === 'restore') {
      await handleRestoreTable(recycleBinAction.table);
    } else {
      await handlePurgeTable(recycleBinAction.table);
    }
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

      if (isDate) {
        const d = Date.parse(str);
        if (isNaN(d) || !str.match(/\d/)) isDate = false;
      }

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
    setInitialColumns(inferredCols);
    setImportPendingData(data);
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

  const handleImport = async () => {
    if (!importFile) return;
    setExecuting(true);
    try {
      const reader = new FileReader();
      reader.readAsArrayBuffer(importFile);
      reader.onload = async (e: any) => {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        let json: any[] = [];
        const fileName = importFile.name.split('.')[0];
        const ext = importFile.name.split('.').pop()?.toLowerCase();

        if (ext === 'json') {
          try {
            const text = new TextDecoder("utf-8").decode(data);
            json = JSON.parse(text);
          } catch (e) { alert("Invalid JSON"); return; }
        } else if (['csv', 'xlsx'].includes(ext || '')) {
          const wb = window.XLSX.read(data, { type: 'array' });
          const wsName = wb.SheetNames[0];
          json = window.XLSX.utils.sheet_to_json(wb.Sheets[wsName]);
        }

        if (createTableFromImport) {
          inferSchemaAndOpenModal(json, fileName);
          setShowImportModal(false);
          setExecuting(false);
          return;
        }

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

  const handleExport = async (format: string, sourceData?: any[]) => {
    let rows = sourceData;
    if (!rows) {
      if (selectedRows.size > 0) {
        rows = tableData.filter(r => selectedRows.has(r[pkCol]));
      } else if (selectedTable) {
        // P10: Fetch ALL rows for complete export
        try {
          const res = await fetchWithAuth(`/api/data/${projectId}/query?schema=${activeSchema}`, {
            method: 'POST',
            body: JSON.stringify({ sql: `SELECT * FROM ${activeSchema}."${selectedTable}"` })
          });
          rows = res.rows || tableData;
        } catch (e) {
          rows = tableData; // Fallback to page
        }
      } else {
        rows = tableData;
      }
    }

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
    else if (format === 'pdf' || format.startsWith('pdf-')) {
      const orient = format === 'pdf-landscape' ? 'landscape' : 'portrait';
      const doc = new jsPDF({ orientation: orient as any });
      doc.autoTable({
        head: [Object.keys(sanitized[0] || {})],
        body: sanitized.map((r: any) => Object.values(r)),
        styles: { fontSize: orient === 'landscape' ? 7 : 8, cellPadding: 2 },
        margin: { top: 10, left: 5, right: 5 },
      });
      doc.save(`${fileName}.pdf`);
    }
    else if (format === 'sql') {
      const sql = sanitized.map((row: any) => {
        const keys = Object.keys(row);
        const vals = keys.map(k => typeof row[k] === 'string' ? `'${row[k].replace(/'/g, "''")}'` : row[k]);
        return `INSERT INTO "${selectedTable || 'export_table'}" (${keys.map(k => `"${k}"`).join(',')}) VALUES (${vals.join(',')});`;
      }).join('\n');
      const blob = new Blob([sql], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `${fileName}.sql`; a.click();
    }
    else if ((window as any).XLSX) {
      const ws = (window as any).XLSX.utils.json_to_sheet(sanitized);
      if (format === 'csv') {
        const csv = (window as any).XLSX.utils.sheet_to_csv(ws);
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `${fileName}.csv`; a.click();
      } else {
        const wb = (window as any).XLSX.utils.book_new();
        (window as any).XLSX.utils.book_append_sheet(wb, ws, "Data");
        (window as any).XLSX.writeFile(wb, `${fileName}.xlsx`);
      }
    }
  };

  const handleExportRecycled = async (tableName: string, format: 'sql' | 'csv') => {
    setExecuting(true);
    try {
      const res = await fetchWithAuth(`/api/data/${projectId}/query?schema=${activeSchema}`, {
        method: 'POST',
        body: JSON.stringify({ sql: `SELECT * FROM ${activeSchema}."${tableName}" LIMIT 1000` })
      });
      if (!res.rows) throw new Error("No data found");
      handleExport(format, res.rows);
      setSuccessMsg("Export initiated.");
    } catch (e: any) { setError(translateError(e)); }
    finally { setExecuting(false); }
  };

  const getDefaultSuggestions = (type: string, hasIdentity?: boolean) => {
    if (hasIdentity) return [];
    const t = type.toLowerCase();
    if (t.includes('timestamp') || t === 'date') return ['now()', "timezone('utc', now())", 'current_date'];
    if (t === 'time') return ['current_time', 'localtime'];
    if (t === 'interval') return ["'1 hour'::interval", "'30 days'::interval", "'0'::interval"];
    if (t === 'uuid') return ['gen_random_uuid()'];
    if (t.includes('bool')) return ['true', 'false'];
    if (IDENTITY_COMPATIBLE_TYPES_SET.has(t)) return ['0', '1'];
    if (t.includes('numeric') || t.includes('float') || t === 'float8' || t === 'money') return ['0', '1'];
    if (t.includes('json')) return ["'{}'::jsonb", "'[]'::jsonb", "'null'::jsonb"];
    if (t === 'text' || t === 'varchar') return ["''", 'current_user', 'session_user'];
    if (t === 'inet') return ["'0.0.0.0'::inet", 'inet_client_addr()'];
    if (t === 'point') return ["'(0,0)'::point"];
    if (t === 'bytea') return ["'\\x'::bytea"];
    return [];
  };

  const sanitizeColName = (name: string) => name.toLowerCase().replace(/[^a-z0-9_]/g, '_');

  const handleAddColumn = async () => {
    if (!newColumn.name || !selectedTable) return;
    setExecuting(true);
    try {
      // GENERATE SQL FOR ALTER TABLE — with array, identity, and serial support
      const colType = newColumn.isArray ? `${newColumn.type}[]` : newColumn.type;
      let sql = `ALTER TABLE ${activeSchema}."${selectedTable}" ADD COLUMN "${sanitizeColName(newColumn.name)}" ${colType}`;

      if (!newColumn.isNullable) sql += ' NOT NULL';

      // GENERATED AS IDENTITY (modern auto-increment) — mutually exclusive with DEFAULT
      if (newColumn.identityGeneration && IDENTITY_COMPATIBLE_TYPES_SET.has(newColumn.type)) {
        const gen = newColumn.identityGeneration === 'always' ? 'ALWAYS' : 'BY DEFAULT';
        sql += ` GENERATED ${gen} AS IDENTITY`;
      } else if (newColumn.defaultValue && !SERIAL_TYPES_SET.has(newColumn.type)) {
        sql += ` DEFAULT ${newColumn.defaultValue}`;
      }

      if (newColumn.isUnique) sql += ' UNIQUE';

      if (newColumn.foreignKey && newColumn.foreignKey.table && newColumn.foreignKey.column) {
        const fkSchema = newColumn.foreignKey.schema || activeSchema;
        sql += ` REFERENCES ${fkSchema}."${newColumn.foreignKey.table}"("${newColumn.foreignKey.column}")`;
      }

      // Execute via Query Endpoint
      await fetchWithAuth(`/api/data/${projectId}/query?schema=${activeSchema}`, {
        method: 'POST',
        body: JSON.stringify({ sql })
      });

      // Build comment with format pattern
      const formatStr = newColumn.formatPreset || newColumn.formatPattern;
      const commentBody = formatStr
        ? `${newColumn.description.replace(/'/g, "''")}||FORMAT:${formatStr}`
        : newColumn.description.replace(/'/g, "''");

      // Add Comment/Description + Format if provided
      if (commentBody) {
        await fetchWithAuth(`/api/data/${projectId}/query?schema=${activeSchema}`, {
          method: 'POST',
          body: JSON.stringify({
            sql: `COMMENT ON COLUMN ${activeSchema}."${selectedTable}"."${sanitizeColName(newColumn.name)}" IS '${commentBody}'`
          })
        });
      }

      setSuccessMsg("Column added.");
      setShowAddColumn(false);
      setNewColumn({ name: '', type: 'text', isNullable: true, isArray: false, defaultValue: '', isUnique: false, description: '', fkSchema: activeSchema, formatPreset: '', formatPattern: '' });
      // Refresh the active TablePanel (Point 8)
      tablePanelRefs.current.get(selectedTable)?.refresh();
    } catch (e: any) { setError(translateError(e)); }
    finally { setExecuting(false); }
  };

  // --- SAVE COLUMN FORMAT (Edit existing column) ---
  const handleSaveColumnFormat = async () => {
    if (!editFormat || !selectedTable) return;
    setExecuting(true);
    try {
      const colMeta = columns.find((c: any) => c.name === editFormat.column);
      const existingDesc = colMeta?.description || '';

      const formatStr = editFormat.preset === 'custom' ? editFormat.customPattern : editFormat.preset;
      const commentBody = formatStr
        ? `${existingDesc.replace(/'/g, "'''")}||FORMAT:${formatStr}`
        : existingDesc.replace(/'/g, "''");

      await fetchWithAuth(`/api/data/${projectId}/query?schema=${activeSchema}`, {
        method: 'POST',
        body: JSON.stringify({
          sql: `COMMENT ON COLUMN ${activeSchema}."${selectedTable}"."${editFormat.column}" IS '${commentBody}'`
        })
      });

      setSuccessMsg(`Format updated for column "${editFormat.column}".`);
      setEditFormat(null);
      if (selectedTable) fetchTableData(selectedTable);
    } catch (e: any) { setError(translateError(e)); }
    finally { setExecuting(false); }
  };

  // --- EFFECT HOOKS ---
  useEffect(() => { fetchSchemas(); }, [projectId]);
  // fetchTables when schema changes — switchSchema already cleared stale state atomically
  useEffect(() => { fetchTables(); }, [projectId, activeSchema]);

  // Refetch parent data when table changes (for modals/export that still use parent state)
  useEffect(() => {
    if (selectedTable && activeTab === 'tables' && tables.length > 0 && tables.some((t: any) => t.name === selectedTable)) {
      fetchTableData(selectedTable);
    }
  }, [selectedTable, activeTab, pageStart, sortConfig, tables]);

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
      eventSource.onmessage = (e: any) => {
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
    const result = await fetchWithAuth(`/api/data/${projectId}/query?schema=${activeSchema}`, {
      method: 'POST',
      body: JSON.stringify({ sql })
    });
    // Smart refresh: detect DDL and refresh sidebar automatically
    const cmd = (result.command || '').toUpperCase();
    if (['CREATE', 'ALTER', 'DROP'].includes(cmd)) {
      fetchSchemas();
      fetchTables();
    }
    return result;
  };

  const handleInterceptCreateTable = (tableName: string, cols: any[]) => {
    setNewTableName(tableName);
    setInitialColumns(cols);
    setShowCreateTable(true);
  };

  const handleRenameTable = async (oldName: string) => {
    const newName = prompt("Rename table to:", oldName);
    if (!newName || newName === oldName) return;
    const safeName = sanitizeName(newName);

    // Phase 1: Start scanning — show modal with spinner
    setTableImpactScan({ oldName, newName: safeName, dependencies: [], cascadeSQL: '', isScanning: true });

    // Phase 2: Run 7 catalog queries
    const deps = await scanTableDependencies(
      fetchWithAuth, projectId, activeSchema, oldName, safeName
    );

    // Phase 3: Build cascade SQL
    const cascadeSQL = buildTableRenameCascadeSQL(activeSchema, oldName, safeName, deps);

    // Phase 4: Show results in modal
    setTableImpactScan({ oldName, newName: safeName, dependencies: deps, cascadeSQL, isScanning: false });
  };

  const executeTableCascade = async (sql: string) => {
    if (!tableImpactScan) return;
    try {
      setExecuting(true);
      await fetchWithAuth(`/api/data/${projectId}/query?schema=${activeSchema}`, {
        method: 'POST',
        body: JSON.stringify({ sql })
      });
      const oldName = tableImpactScan.oldName;
      const newName = tableImpactScan.newName;
      setTableImpactScan(null);
      setSuccessMsg(`Table renamed: ${oldName} → ${newName}`);

      // ── Client-side migrations ──
      // 1. Migrate localStorage sort config key
      const oldSortKey = `cascata_sort_${projectId}_${activeSchema}_${oldName}`;
      const newSortKey = `cascata_sort_${projectId}_${activeSchema}_${newName}`;
      const sortData = localStorage.getItem(oldSortKey);
      if (sortData) {
        localStorage.setItem(newSortKey, sortData);
        localStorage.removeItem(oldSortKey);
      }

      // 2. Update table order in localStorage
      const orderKey = `cascata_table_order_${projectId}_${activeSchema}`;
      const orderData = localStorage.getItem(orderKey);
      if (orderData) {
        try {
          const order: string[] = JSON.parse(orderData);
          const updated = order.map(t => t === oldName ? newName : t);
          localStorage.setItem(orderKey, JSON.stringify(updated));
        } catch { /* ignore parse errors */ }
      }

      // 3. Update React state
      fetchTables();
      if (selectedTable === oldName) {
        setSelectedTable(newName);
      }
      setPinnedTables(prev => prev.map(t => t === oldName ? newName : t));
      setOpenTabs(prev => prev.map(t => t.table === oldName && t.schema === activeSchema ? { ...t, table: newName } : t));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setExecuting(false);
    }
  };

  const handleDuplicateTable = (source: string) => {
    setDuplicateConfig({ source, newName: `${source}_copy`, withData: false });
    setShowDuplicateModal(true);
    setContextMenu(null);
  };

  const handleDuplicateTableSubmit = async () => {
    if (!duplicateConfig.newName || !duplicateConfig.source) return;
    setExecuting(true);
    try {
      const withDataSql = duplicateConfig.withData ? '' : 'WITH NO DATA';
      const sql = `CREATE TABLE ${activeSchema}."${sanitizeColName(duplicateConfig.newName)}" AS TABLE ${activeSchema}."${duplicateConfig.source}" ${withDataSql};`;

      await fetchWithAuth(`/api/data/${projectId}/query?schema=${activeSchema}`, {
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
      const cols = await fetchWithAuth(`/api/data/${projectId}/tables/${tableName}/columns?schema=${activeSchema}`);
      const sql = `CREATE TABLE ${activeSchema}."${tableName}" (\n${cols.map((c: any) => {
        let def = `  "${c.name}" ${c.type}`;
        if (c.isPrimaryKey) def += ' PRIMARY KEY';
        if (c.is_nullable === 'NO' && !c.isPrimaryKey) def += ' NOT NULL';
        if (c.defaultValue) def += ` DEFAULT ${c.defaultValue}`;
        return def;
      }).join(',\n')}\n);`;
      const ok = await copyToClipboard(sql);
      if (ok) {
        setSuccessMsg("SQL Copied");
      } else {
        setClipboardFallbackSQL(sql);
      }
    } catch (e: any) {
      setError(e.message || "Failed to generate SQL");
    }
  };

  // --- TABLE CREATOR CALLBACK & GOVERNANCE SYNC ---
  const handleSqlFromDrawer = async (
    sql: string,
    metaConfig?: { tableName: string, mcpEnabled: boolean, mcpPerms: { r: boolean, c: boolean, u: boolean, d: boolean }, lockedColumns?: Record<string, string> }
  ) => {
    try {
      // 1. Execute Table Creation DDL
      await fetchWithAuth(`/api/data/${projectId}/query?schema=${activeSchema}`, {
        method: 'POST',
        body: JSON.stringify({ sql })
      });
      setSuccessMsg(`Table '${metaConfig?.tableName || 'new'}' created successfully.`);
      fetchTables();
      fetchSchemas(); // P6: refresh schemas after table creation

      // 2. Synchronize Metadata (MCP Governance & Universal Padlock) to Backend Engine
      if (metaConfig && (metaConfig.mcpEnabled || metaConfig.lockedColumns)) {
        try {
          // Fetch current project metadata
          const resProj = await fetchWithAuth(`/api/control/projects`);
          const currentProject = resProj.find((p: any) => p.slug === projectId);

          if (currentProject) {
            const currentMetadata = currentProject.metadata || {};
            const gov = currentMetadata.ai_governance || { mcp_enabled: true, tables: {}, rpcs: [] };
            const lockedCols = currentMetadata.locked_columns || {};

            // Inject new table permissions
            const updatedGov = {
              ...gov,
              tables: {
                ...gov.tables,
                ...(metaConfig.mcpEnabled ? { [metaConfig.tableName]: metaConfig.mcpPerms } : {})
              }
            };

            // Inject locked columns
            if (metaConfig.lockedColumns && Object.keys(metaConfig.lockedColumns).length > 0) {
              Object.assign(lockedCols, metaConfig.lockedColumns);
            }

            // Patch backend
            await fetch(`/api/control/projects/${projectId}`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`
              },
              body: JSON.stringify({ metadata: { ...currentMetadata, ai_governance: updatedGov, locked_columns: lockedCols } })
            });
            console.log(`[Metadata] Sync complete for table ${metaConfig.tableName}`);
          }
        } catch (govErr: any) {
          console.error("Metadata Sync Failed:", govErr);
          // Don't fail the whole creation process, but alert user
          setError(`Table created, but Metadata sync failed.`);
        }
      }
    } catch (e: any) {
      // If auto-execute DDL fails, send to console for manual review
      setSqlInitial(sql);
      setActiveTab('query');
      setError(`Auto-execute failed: ${e.message}. SQL sent to console.`);
    }
  };

  // --- UNIVERSAL PADLOCK — Toggle Column Immutability ---
  const handleToggleLock = async () => {
    if (!editLock) return;
    try {
      setExecuting(true);
      const resProj = await fetchWithAuth(`/api/control/projects`);
      const currentProject = resProj.find((p: any) => p.slug === projectId);

      if (currentProject) {
        const currentMetadata = currentProject.metadata || {};
        const lockedCols = { ...(currentMetadata.locked_columns || {}) };

        if (editLock.currentLevel === 'unlocked') {
          delete lockedCols[editLock.column];
        } else {
          lockedCols[editLock.column] = editLock.currentLevel;
        }

        await fetch(`/api/control/projects/${projectId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`
          },
          body: JSON.stringify({ metadata: { ...currentMetadata, locked_columns: lockedCols } })
        });

        setSuccessMsg(`Column '${editLock.column}' lock initialized. Reloading structure...`);
        setEditLock(null);
        // Refresh tables/schemas to propagate the lock UI updates across the IDE
        fetchSchemas();
        fetchTables();
      }
    } catch (e: any) {
      setError(`Failed to update security lock: ${e.message}`);
    } finally {
      setExecuting(false);
    }
  };

  // --- PROTOCOLO CASCATA — Column Operations with Impact Analysis ---
  const startCascadeProtocol = async (action: 'rename' | 'delete', colName: string) => {
    if (!selectedTable) return;
    setColumnContextMenu(null);

    let newName: string | undefined;
    if (action === 'rename') {
      const input = prompt(`Rename column "${colName}" to:`, colName);
      if (!input || input === colName) return;
      newName = input.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    }

    // Phase 1: Start scanning — show modal with spinner
    setImpactScan({ action, column: colName, newName, dependencies: [], isScanning: true });

    // Phase 2: Run 7 catalog queries
    const deps = await scanColumnDependencies(
      fetchWithAuth, projectId, activeSchema, selectedTable, colName, action, newName
    );

    // Phase 3: Show results in modal
    setImpactScan({ action, column: colName, newName, dependencies: deps, isScanning: false });
  };

  const executeCascade = async (sql: string) => {
    if (!selectedTable) return;
    try {
      setExecuting(true);
      await fetchWithAuth(`/api/data/${projectId}/query?schema=${activeSchema}`, {
        method: 'POST',
        body: JSON.stringify({ sql })
      });
      const action = impactScan?.action;
      const col = impactScan?.column;
      const newN = impactScan?.newName;
      setImpactScan(null);
      setSuccessMsg(
        action === 'rename'
          ? `Column renamed: ${col} → ${newN}`
          : `Column "${col}" deleted with cascade.`
      );
      fetchTableData(selectedTable);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setExecuting(false);
    }
  };

  const handleColumnDrop = (targetCol: string) => {
    // Column drop is now handled inside TablePanel
  };

  const handleTableDrop = (targetTable: string) => {
    if (!draggedTable || draggedTable === targetTable) { setDragOverTable(null); return; }
    setTables(prev => {
      const newList = [...prev];
      const fromIdx = newList.findIndex(t => t.name === draggedTable);
      const toIdx = newList.findIndex(t => t.name === targetTable);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const [moved] = newList.splice(fromIdx, 1);
      newList.splice(toIdx, 0, moved);
      // Persist table order in localStorage
      localStorage.setItem(`cascata_table_order_${projectId}_${activeSchema}`, JSON.stringify(newList.map(t => t.name)));
      return newList;
    });
    setDraggedTable(null);
    setDragOverTable(null);
  };

  // --- RENDER HELPERS ---

  const renderSidebar = () => (
    <aside className="bg-white border-r border-slate-200 flex flex-col shrink-0 relative z-10" style={{ width: sidebarWidth }}>
      <div className="p-6 border-b border-slate-100 bg-white sticky top-0 z-10">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2 bg-slate-50 hover:bg-slate-100 transition-colors p-1.5 pr-3 rounded-xl border border-slate-200/60 cursor-pointer relative group">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white shadow-lg shadow-indigo-200">
              <Database size={16} />
            </div>
            <select
              value={activeSchema}
              onChange={(e: any) => switchSchema(e.target.value)}
              className="text-sm font-black text-slate-900 tracking-tight bg-transparent border-none outline-none cursor-pointer appearance-none pl-1 pr-6"
            >
              {schemas.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <ChevronDown size={14} className="text-slate-400 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none group-hover:text-indigo-500" />
          </div>
          <button onClick={() => setShowExtensions(true)} className="p-2 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-purple-600 transition-colors" title="Manage Extensions">
            <Puzzle size={20} />
          </button>
        </div>

        <div className="relative group">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
          <input
            value={searchFilter}
            onChange={(e: any) => setSearchFilter(e.target.value)}
            placeholder="Search tables..."
            className="w-full bg-slate-50 border border-slate-100 rounded-xl pl-10 pr-4 py-3 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-500/20"
          />
          {searchFilter && (
            <button onClick={() => setSearchFilter('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-600">
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-1 custom-scrollbar">
        <div className="flex items-center justify-between mb-4 px-2">
          <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest">{activeSchema} Tables</h2>
          <div className="flex gap-1">
            <button onClick={() => { fetchTables(); tablePanelRefs.current.forEach(panel => panel?.refresh()); }} className="p-1 hover:bg-slate-100 rounded text-slate-400 hover:text-indigo-600"><RefreshCw size={14} /></button>
            <button onClick={() => setShowCreateTable(true)} className="p-1 hover:bg-slate-100 rounded text-slate-400 hover:text-indigo-600"><Plus size={14} /></button>
          </div>
        </div>

        {tables.filter(t => !searchFilter || t.name.toLowerCase().includes(searchFilter.toLowerCase())).map(table => (
          <div
            key={table.name}
            draggable
            onDragStart={() => setDraggedTable(table.name)}
            onDragOver={(e: any) => { e.preventDefault(); setDragOverTable(table.name); }}
            onDragLeave={() => setDragOverTable(null)}
            onDrop={(e: any) => { e.preventDefault(); handleTableDrop(table.name); }}
            onDragEnd={() => { setDraggedTable(null); setDragOverTable(null); }}
            onClick={(e: any) => {
              setActiveTab('tables');
              if (e.shiftKey) {
                // Shift+click: add to pinned tables for side-by-side view
                setPinnedTables(prev => prev.includes(table.name) ? prev : [...prev, table.name]);
                setOpenTabs(prev => prev.some(t => t.schema === activeSchema && t.table === table.name) ? prev : [...prev, { schema: activeSchema, table: table.name }]);
              } else {
                // Normal click — single table, reset pinned
                setPinnedTables([table.name]);
                setSelectedTable(table.name);
                setOpenTabs(prev => prev.some(t => t.schema === activeSchema && t.table === table.name) ? prev : [...prev, { schema: activeSchema, table: table.name }]);
              }
            }}
            onContextMenu={(e: any) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, table: table.name }); }}
            className={`
                          group flex items-center justify-between px-3 py-2.5 rounded-xl cursor-pointer transition-all border
                          ${dragOverTable === table.name ? 'border-indigo-400 bg-indigo-50' : 'border-transparent'}
                          ${selectedTable === table.name && activeTab === 'tables' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200' : pinnedTables.includes(table.name) && activeTab === 'tables' ? 'bg-indigo-100 text-indigo-700 border-indigo-300' : 'text-slate-600 hover:bg-slate-50'}
                      `}
          >
            <div className="flex items-center gap-3 overflow-hidden">
              <GripVertical size={12} className={`opacity-0 group-hover:opacity-60 shrink-0 ${selectedTable === table.name && activeTab === 'tables' ? 'text-white' : pinnedTables.includes(table.name) && activeTab === 'tables' ? 'text-indigo-400' : 'text-slate-300'}`} />
              <TableIcon size={16} className={selectedTable === table.name && activeTab === 'tables' ? 'text-white' : pinnedTables.includes(table.name) && activeTab === 'tables' ? 'text-indigo-500' : 'text-slate-400'} />
              <span className="font-bold text-xs truncate">{table.name}</span>
            </div>
          </div>
        ))}

        {recycleBin.length > 0 && (
          <div className="mt-8 pt-4 border-t border-slate-100">
            <button onClick={() => setShowRecycleBinModal(true)} className="w-full flex items-center gap-3 px-3 py-2 text-xs font-bold text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-xl transition-all">
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

  // isCompareMode: true when multiple tables are pinned
  const isCompareMode = pinnedTables.length > 1;

  return (
    <div
      className={`flex h-full flex-row bg-[#F8FAFC] text-slate-900 overflow-hidden font-sans relative transition-colors ${isDraggingOver ? 'bg-indigo-50/50' : ''}`}
      onDrop={handleGlobalDrop}
      onDragOver={(e: any) => { e.preventDefault(); if (!draggingColumn && !draggedTable) setIsDraggingOver(true); }}
      onDragLeave={() => setIsDraggingOver(false)}
    >
      {/* Drag Overlay — only for external file drops, NOT internal reorders */}
      {isDraggingOver && !draggingColumn && !draggedTable && (
        <div className="absolute inset-0 z-[1000] border-8 border-indigo-500 border-dashed bg-indigo-50/80 flex items-center justify-center p-8 pointer-events-none">
          <div className="bg-white rounded-3xl p-10 shadow-2xl text-indigo-600 flex flex-col items-center animate-bounce">
            <Upload size={64} className="mb-4" />
            <h2 className="text-3xl font-black uppercase tracking-tighter">Drop to Import</h2>
            <p className="text-indigo-400 font-bold mt-2">CSV, JSON, or XLSX files supported.</p>
          </div>
        </div>
      )}

      {/* Notifications — Auto-dismiss 3.8s, pause on hover, copy icon */}
      {(successMsg || error) && (
        <div
          onMouseEnter={handleNotifyPause}
          onMouseLeave={handleNotifyResume}
          className={`fixed top-8 left-1/2 -translate-x-1/2 z-[100] px-6 py-4 rounded-full shadow-2xl flex items-center gap-3 animate-in slide-in-from-top-4 cursor-default select-none ${error ? 'bg-rose-600 text-white' : 'bg-emerald-600 text-white'}`}
        >
          {error ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
          <span className="text-xs font-bold">{error || successMsg}</span>
          <button
            onClick={async () => {
              const msg = error || successMsg || '';
              await copyToClipboard(msg);
              setError(null);
              setSuccessMsg(null);
            }}
            title="Copy message"
            className="ml-2 opacity-60 hover:opacity-100 transition-opacity"
          >
            <Copy size={14} />
          </button>
        </div>
      )}

      {renderSidebar()}

      <main className="flex-1 overflow-hidden relative flex flex-col bg-white">
        {activeTab === 'tables' && openTabs.length > 0 && (
          <div className="flex items-center px-4 pt-2 bg-slate-50 border-b border-slate-200 overflow-x-auto gap-1 shrink-0 scrollbar-hide">
            {openTabs.map((tab, idx) => (
              <div key={`${tab.schema}.${tab.table}`} className={`group flex items-center gap-2 px-4 py-2 rounded-t-lg border border-b-0 cursor-pointer select-none transition-colors ${selectedTable === tab.table && activeSchema === tab.schema ? 'bg-white border-slate-200 text-indigo-700 shadow-[0_1px_0_white]' : pinnedTables.includes(tab.table) ? 'bg-indigo-50 border-indigo-200 text-indigo-600' : 'bg-slate-100 border-transparent text-slate-500 hover:bg-slate-200'}`} style={{ marginBottom: '-1px' }} onClick={(e: any) => {
                if (e.shiftKey) {
                  // Shift+click on tab: toggle pinned
                  setPinnedTables(prev => prev.includes(tab.table) ? (prev.length > 1 ? prev.filter(t => t !== tab.table) : prev) : [...prev, tab.table]);
                } else {
                  if (tab.schema !== activeSchema) switchSchema(tab.schema);
                  setSelectedTable(tab.table);
                  setPinnedTables([tab.table]);
                }
              }}>
                <TableIcon size={14} className={selectedTable === tab.table && activeSchema === tab.schema ? 'text-indigo-600' : 'text-slate-400'} />
                {tab.schema !== activeSchema && <span className="text-[9px] font-bold uppercase tracking-wider bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">{tab.schema}</span>}
                <span className="text-xs font-bold truncate max-w-[150px]">{tab.table}</span>
                <button className={`p-0.5 rounded-md transition-colors ${selectedTable === tab.table && activeSchema === tab.schema ? 'opacity-100 hover:bg-indigo-50 text-indigo-400 hover:text-indigo-600' : 'opacity-0 group-hover:opacity-100 hover:bg-slate-300 text-slate-400 hover:text-slate-600'}`} onClick={(e: any) => {
                  e.stopPropagation();
                  const newTabs = openTabs.filter((_, i) => i !== idx);
                  setOpenTabs(newTabs);
                  setPinnedTables(prev => prev.filter(t => t !== tab.table));
                  if (selectedTable === tab.table && activeSchema === tab.schema) {
                    if (newTabs.length > 0) {
                      const last = newTabs[newTabs.length - 1];
                      switchSchema(last.schema);
                      setSelectedTable(last.table);
                      setPinnedTables([last.table]);
                    } else {
                      setSelectedTable(null);
                      setPinnedTables([]);
                    }
                  }
                }}>                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )
        }

        {
          activeTab === 'tables' && pinnedTables.length > 0 ? (
            <div className={`flex-1 flex ${isCompareMode ? 'flex-row divide-x divide-slate-200' : 'flex-col'} overflow-hidden`}>
              {pinnedTables.map(tName => (
                <TablePanel
                  key={`${activeSchema}-${tName}`}
                  ref={(el: TablePanelHandle | null) => {
                    if (el) tablePanelRefs.current.set(tName, el);
                    else tablePanelRefs.current.delete(tName);
                  }}
                  projectId={projectId}
                  tableName={tName}
                  schema={activeSchema}
                  isCompareMode={isCompareMode}
                  onClose={() => {
                    setPinnedTables(prev => {
                      const next = prev.filter(t => t !== tName);
                      if (next.length > 0 && selectedTable === tName) setSelectedTable(next[0]);
                      if (next.length === 0) setSelectedTable(null);
                      return next;
                    });
                    setOpenTabs(prev => prev.filter(t => !(t.table === tName && t.schema === activeSchema)));
                  }}
                  onColumnContextMenu={(x, y, col) => setColumnContextMenu({ x, y, col })}
                  onAddColumn={() => setShowAddColumn(true)}
                  onError={setError}
                  onSuccess={setSuccessMsg}
                  onExport={(name, data, fmt) => handleExport(fmt as any, data?.length ? data : undefined)}
                  onImport={() => setShowImportModal(true)}
                  isRealtimeActive={isRealtimeActive}
                />
              ))}
            </div>
          ) : activeTab === 'query' ? (
            <SqlConsole onExecute={handleExecuteSql} onFix={handleFixSql} onInterceptCreateTable={handleInterceptCreateTable} initialQuery={sqlInitial} projectId={projectId} />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-300">
              <Database size={64} className="mb-4 opacity-20" />
              <span className="font-bold uppercase tracking-widest text-xs">Select a table</span>
            </div>
          )
        }
      </main >

      {/* TABLE CREATOR DRAWER */}
      < TableCreatorDrawer
        isOpen={showCreateTable}
        onClose={() => { setShowCreateTable(false); setInitialColumns(undefined); }}
        tables={tables}
        schemas={schemas}
        activeSchema={activeSchema}
        projectId={projectId}
        fetchWithAuth={fetchWithAuth}
        onSqlGenerated={handleSqlFromDrawer}
        onSqlSaveToEditor={(sql: string) => {
          setSqlInitial(sql);
          setActiveTab('query');
          // Also save to SQL history (localStorage) so it appears in the history sidebar
          try {
            const histKey = `cascata_sql_history_${projectId}`;
            const raw = localStorage.getItem(histKey);
            const hist: string[] = raw ? JSON.parse(raw) : [];
            const filtered = hist.filter((h: string) => h !== sql);
            const next = [sql, ...filtered].slice(0, 50);
            localStorage.setItem(histKey, JSON.stringify(next));
          } catch { /* non-fatal */ }
        }}
        initialTableName={newTableName}
        initialColumns={initialColumns}
      />

      {/* IMPORT MODAL */}
      {
        showImportModal && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[250] flex items-center justify-center p-8 animate-in zoom-in-95">
            <div className="bg-white rounded-[3.5rem] w-full max-w-lg p-12 shadow-2xl border border-slate-100 relative">
              <button onClick={() => setShowImportModal(false)} className="absolute top-8 right-8 text-slate-300 hover:text-slate-900 transition-colors"><X size={24} /></button>
              <h3 className="text-3xl font-black text-slate-900 tracking-tighter mb-8">Data Import</h3>
              <div className="space-y-6">
                <div className="border-4 border-dashed border-slate-100 rounded-[2.5rem] p-10 text-center hover:border-emerald-300 hover:bg-emerald-50/10 transition-all cursor-pointer relative group">
                  <input type="file" accept=".csv, .xlsx, .json" onChange={(e: any) => setImportFile(e.target.files?.[0] || null)} className="absolute inset-0 opacity-0 cursor-pointer" />
                  {importFile ? <span className="font-bold text-slate-900">{importFile.name}</span> : <div className="flex flex-col items-center text-slate-300 group-hover:text-emerald-500"><Upload size={40} className="mb-2" /><span className="font-bold text-sm">Drop file here</span></div>}
                </div>
              </div>
            </div>
          </div>
        )
      }

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
      {
        contextMenu && (
          <>
            <div className="fixed inset-0 z-[90]" onClick={() => setContextMenu(null)} />
            <div className="fixed z-[100] bg-white border border-slate-200 shadow-2xl rounded-2xl p-2 w-56 animate-in fade-in zoom-in-95" style={{ top: contextMenu.y, left: contextMenu.x }}>
              <button onClick={() => { handleRenameTable(contextMenu.table); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl transition-all"><Edit size={14} /> Rename</button>
              <button onClick={() => { handleDuplicateTable(contextMenu.table); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl transition-all"><Layers size={14} /> Duplicate</button>
              <button onClick={() => { handleCopyStructure(contextMenu.table); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl transition-all"><Code size={14} /> Copy SQL</button>
              <div className="h-[1px] bg-slate-100 my-1"></div>
              <button onClick={() => { handleDeleteTable(contextMenu.table); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-rose-600 hover:bg-rose-50 rounded-xl transition-all"><Trash2 size={14} /> Delete Table</button>
            </div>
          </>
        )
      }

      {/* COLUMN CONTEXT MENU */}
      {
        columnContextMenu && (
          <>
            <div className="fixed inset-0 z-[90]" onClick={() => setColumnContextMenu(null)} />
            <div className="fixed z-[100] bg-white border border-slate-200 shadow-2xl rounded-2xl p-2 w-52 animate-in fade-in zoom-in-95" style={{ top: columnContextMenu.y, left: columnContextMenu.x }}>
              <button onClick={() => { startCascadeProtocol('rename', columnContextMenu.col); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl transition-all"><Edit size={14} /> Rename Column</button>
              <button onClick={() => { copyToClipboard(columnContextMenu.col); setSuccessMsg('Column name copied'); setColumnContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl transition-all"><Copy size={14} /> Copy Name</button>
              {/* Edit Format — only for text/varchar columns */}
              {(() => {
                const colMeta = columns.find((c: any) => c.name === columnContextMenu.col);
                const isTextType = colMeta && (colMeta.type === 'text' || colMeta.type?.includes('character'));
                return isTextType ? (
                  <button onClick={() => {
                    setEditFormat({
                      column: columnContextMenu.col,
                      preset: colMeta.formatPattern || '',
                      customPattern: '',
                      columnType: colMeta.type,
                    });
                    setColumnContextMenu(null);
                  }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-amber-600 hover:bg-amber-50 rounded-xl transition-all">
                    <Shield size={14} /> Edit Format
                  </button>
                ) : null;
              })()}
              <button onClick={() => {
                setEditLock({ column: columnContextMenu.col, table: columnContextMenu.table, currentLevel: columnContextMenu.lockLevel });
                setColumnContextMenu(null);
              }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-rose-600 hover:bg-rose-50 rounded-xl transition-all">
                <Lock size={14} /> Security Lock
              </button>
              <div className="h-[1px] bg-slate-100 my-1"></div>
              <button onClick={() => { startCascadeProtocol('delete', columnContextMenu.col); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-rose-600 hover:bg-rose-50 rounded-xl transition-all"><Trash2 size={14} /> Delete Column</button>
            </div>
          </>
        )
      }

      {/* UNIVERSAL SECURITY PADLOCK MODAL */}
      {
        editLock && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
            <div className="bg-white rounded-[3rem] p-10 max-w-sm w-full shadow-2xl border border-slate-200 text-center">
              <div className="w-16 h-16 bg-rose-100 text-rose-600 rounded-full flex items-center justify-center mx-auto mb-6 shadow-inner">
                <Lock size={32} />
              </div>
              <h3 className="text-xl font-black text-slate-900 mb-2">Universal Padlock</h3>
              <p className="text-xs text-slate-500 font-medium mb-6">
                Protect column <strong>{editLock.column}</strong> from arbitrary API mutations. This applies <em>project-wide</em>.
              </p>

              <div className="space-y-4 mb-8 text-left">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Lock Security Tier</label>
                <select
                  value={editLock.currentLevel}
                  onChange={(e) => setEditLock({ ...editLock, currentLevel: e.target.value })}
                  className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-xs font-bold text-slate-700 outline-none cursor-pointer focus:ring-2 focus:ring-rose-500/20"
                >
                  <option value="unlocked">UNLOCKED (Open Access)</option>
                  <option value="immutable">IMMUTABLE (Blocks INSERT & UPDATE)</option>
                  <option value="insert_only">INSERT ONLY (Blocks UPDATE)</option>
                  <option value="service_role_only">SERVICE ROLE ONLY (Blocks Anon/Auth)</option>
                  <option value="otp_protected">OTP PROTECTED (Blocks UPDATE unless step-up challenge is provided)</option>
                </select>

                {editLock.currentLevel !== 'unlocked' && (
                  <div className="bg-rose-50 border border-rose-100 rounded-xl p-3 text-[10px] text-rose-700 font-medium mt-2">
                    <strong className="block mb-1 font-black">Intrusion Alerting Active</strong>
                    Any API request violating this tier will be scrubbed automatically and an alert will be logged to <em>system.security_events</em>.
                  </div>
                )}
              </div>

              <div className="flex gap-4">
                <button onClick={() => setEditLock(null)} disabled={executing} className="flex-1 py-4 text-xs font-black text-slate-400 hover:text-slate-600 uppercase tracking-widest transition-colors disabled:opacity-50">Cancel</button>
                <button onClick={handleToggleLock} disabled={executing} className="flex-[2] py-4 bg-rose-600 hover:bg-rose-700 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-xl shadow-rose-600/20 transition-all flex justify-center items-center gap-2 disabled:opacity-50">
                  {executing ? <Loader2 size={16} className="animate-spin" /> : <><Shield size={16} /> Enforce Lock</>}
                </button>
              </div>
            </div>
          </div>
        )
      }

      {/* PROTOCOLO CASCATA — Column Impact Modal */}
      <ColumnImpactModal
        isOpen={!!impactScan}
        action={impactScan?.action || 'rename'}
        schema={activeSchema}
        table={selectedTable || ''}
        column={impactScan?.column || ''}
        newName={impactScan?.newName}
        dependencies={impactScan?.dependencies || []}
        isScanning={impactScan?.isScanning || false}
        onClose={() => setImpactScan(null)}
        onExecute={executeCascade}
      />

      {/* PROTOCOLO CASCATA — Table Rename Impact Modal */}
      <ColumnImpactModal
        isOpen={!!tableImpactScan}
        action="rename"
        targetType="table"
        schema={activeSchema}
        table={tableImpactScan?.oldName || ''}
        column={tableImpactScan?.oldName || ''}
        newName={tableImpactScan?.newName}
        dependencies={tableImpactScan?.dependencies || []}
        isScanning={tableImpactScan?.isScanning || false}
        onClose={() => setTableImpactScan(null)}
        onExecute={executeTableCascade}
        cascadeSQLOverride={tableImpactScan?.cascadeSQL}
      />

      {/* ADD COLUMN MODAL (ENHANCED) */}
      {
        showAddColumn && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
            <div className="bg-white rounded-[3rem] p-10 max-w-sm w-full shadow-2xl border border-slate-200 text-center">
              <h3 className="text-xl font-black text-slate-900 mb-6">Add New Column</h3>
              <div className="space-y-4 mb-6 text-left">

                {/* Name */}
                <div className="space-y-1">
                  <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">Column Name</label>
                  <input
                    value={newColumn.name}
                    onChange={e => setNewColumn({ ...newColumn, name: sanitizeColName(e.target.value) })}
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
                    onChange={e => setNewColumn({ ...newColumn, description: e.target.value })}
                    placeholder="Semantic hint for AI..."
                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 font-medium text-sm outline-none text-slate-600"
                  />
                </div>

                {/* Smart Type Selector */}
                <div className="space-y-1">
                  <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">Data Type</label>
                  <select
                    value={newColumn.type}
                    onChange={e => {
                      const newType = e.target.value;
                      const updates: any = { ...newColumn, type: newType };
                      // AUTO-CLEAR identity if new type doesn't support it
                      if (!IDENTITY_COMPATIBLE_TYPES_SET.has(newType)) updates.identityGeneration = undefined;
                      // AUTO-CLEAR identity if switching to serial (has built-in auto-inc)
                      if (SERIAL_TYPES_SET.has(newType)) updates.identityGeneration = undefined;
                      // AUTO-CLEAR array if switching to serial
                      if (SERIAL_TYPES_SET.has(newType)) updates.isArray = false;
                      setNewColumn(updates);
                    }}
                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 font-bold text-sm outline-none cursor-pointer"
                  >
                    <optgroup label="Numbers">
                      <option value="int8">int8 (BigInt)</option>
                      <option value="int4">int4 (Integer)</option>
                      <option value="int2">int2 (SmallInt)</option>
                      <option value="numeric">numeric</option>
                      <option value="float8">float8</option>
                      <option value="money">money</option>
                    </optgroup>
                    <optgroup label="Auto-Increment (Legacy)">
                      <option value="serial">serial (Auto Int4)</option>
                      <option value="bigserial">bigserial (Auto Int8)</option>
                    </optgroup>
                    <optgroup label="Text">
                      <option value="text">text</option>
                      <option value="varchar">varchar</option>
                      <option value="uuid">uuid</option>
                    </optgroup>
                    <optgroup label="Date/Time">
                      <option value="timestamptz">timestamptz</option>
                      <option value="date">date</option>
                      <option value="time">time</option>
                      <option value="interval">interval</option>
                    </optgroup>
                    <optgroup label="JSON">
                      <option value="jsonb">jsonb</option>
                      <option value="json">json</option>
                    </optgroup>
                    <optgroup label="Network & Geo">
                      <option value="inet">inet (IP Address)</option>
                      <option value="point">point (2D Coord)</option>
                    </optgroup>
                    <optgroup label="Other">
                      <option value="bool">boolean</option>
                      <option value="bytea">bytea</option>
                    </optgroup>
                  </select>
                </div>

                {/* Toggles & Options */}
                <div className="flex items-center justify-between bg-slate-50 p-2 rounded-2xl border border-slate-100">
                  <div className="flex items-center gap-2">
                    <div title="Nullable" onClick={() => setNewColumn({ ...newColumn, isNullable: !newColumn.isNullable })} className={`px-2 py-1.5 rounded-xl text-[10px] font-black cursor-pointer select-none transition-all ${newColumn.isNullable ? 'bg-emerald-100 text-emerald-700' : 'text-slate-400 hover:bg-slate-200'}`}>NULL</div>
                    <div title="Unique" onClick={() => setNewColumn({ ...newColumn, isUnique: !newColumn.isUnique })} className={`px-2 py-1.5 rounded-xl text-[10px] font-black cursor-pointer select-none transition-all ${newColumn.isUnique ? 'bg-purple-100 text-purple-700' : 'text-slate-400 hover:bg-slate-200'}`}>UNIQ</div>
                    {/* AUTO — Identity (Auto-Increment) — only for int2/int4/int8, not serial/bigserial */}
                    {IDENTITY_COMPATIBLE_TYPES_SET.has(newColumn.type) && !SERIAL_TYPES_SET.has(newColumn.type) && (
                      <div
                        title={
                          newColumn.isArray ? "Auto-increment (disabled — arrays cannot use IDENTITY)" :
                            newColumn.identityGeneration
                              ? `GENERATED ${newColumn.identityGeneration === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY (click to cycle)`
                              : "Auto-increment (GENERATED AS IDENTITY)"
                        }
                        onClick={() => {
                          if (newColumn.isArray) return;
                          if (!newColumn.identityGeneration) {
                            setNewColumn({ ...newColumn, identityGeneration: 'always', defaultValue: '' });
                          } else if (newColumn.identityGeneration === 'always') {
                            setNewColumn({ ...newColumn, identityGeneration: 'by_default' });
                          } else {
                            setNewColumn({ ...newColumn, identityGeneration: undefined });
                          }
                        }}
                        className={`px-2 py-1.5 rounded-xl text-[10px] font-black cursor-pointer select-none transition-all ${newColumn.isArray ? 'text-slate-200 cursor-not-allowed' :
                          newColumn.identityGeneration === 'always' ? 'bg-teal-100 text-teal-700 ring-1 ring-teal-300' :
                            newColumn.identityGeneration === 'by_default' ? 'bg-cyan-100 text-cyan-700 ring-1 ring-cyan-300' :
                              'text-slate-400 hover:bg-slate-200'
                          }`}
                      >AUTO</div>
                    )}
                    {/* Array Toggle — mutually exclusive with FK, Identity, Serial */}
                    <div
                      title={
                        newColumn.foreignKey ? 'Array (disabled — FK columns cannot be arrays)' :
                          newColumn.identityGeneration ? 'Array (disabled — Identity columns cannot be arrays)' :
                            SERIAL_TYPES_SET.has(newColumn.type) ? 'Array (disabled — Serial types cannot be arrays)' :
                              'Array'
                      }
                      onClick={() => {
                        if (newColumn.foreignKey || newColumn.identityGeneration || SERIAL_TYPES_SET.has(newColumn.type)) return;
                        setNewColumn({ ...newColumn, isArray: !newColumn.isArray, identityGeneration: newColumn.isArray ? newColumn.identityGeneration : undefined });
                      }}
                      className={`px-2 py-1.5 rounded-xl text-[10px] font-black cursor-pointer select-none transition-all ${(newColumn.foreignKey || newColumn.identityGeneration || SERIAL_TYPES_SET.has(newColumn.type))
                        ? 'text-slate-200 cursor-not-allowed'
                        : newColumn.isArray ? 'bg-indigo-100 text-indigo-700' : 'text-slate-400 hover:bg-slate-200'
                        }`}
                    >LIST</div>
                  </div>

                  {/* Foreign Key Toggle — mutually exclusive with Array */}
                  <div
                    onClick={async () => {
                      if (newColumn.isArray) return;
                      if (!newColumn.foreignKey) {
                        const fkSch = newColumn.fkSchema || activeSchema;
                        setNewColumn({ ...newColumn, foreignKey: { schema: fkSch, table: '', column: '' } });
                        setFkLoading(true);
                        try {
                          const res = await fetchWithAuth(`/api/data/${projectId}/tables?schema=${fkSch}`);
                          setFkTargetTables(res || []);
                        } catch { setFkTargetTables(tables); }
                        finally { setFkLoading(false); }
                      } else {
                        setNewColumn({ ...newColumn, foreignKey: undefined });
                      }
                    }}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-[10px] font-black cursor-pointer select-none transition-all ${newColumn.isArray ? 'text-slate-200 cursor-not-allowed' : newColumn.foreignKey ? 'bg-blue-100 text-blue-700 shadow-sm' : 'text-slate-400 hover:bg-slate-200'}`}
                  >
                    <LinkIcon size={12} strokeWidth={3} /> {newColumn.foreignKey ? 'LINKED' : 'LINK'}
                  </div>
                </div>

                {/* Foreign Key Configuration (Conditional) */}
                {newColumn.foreignKey && (
                  <div className="space-y-3 bg-blue-50/50 p-3 rounded-2xl border border-blue-100 animate-in slide-in-from-top-2">
                    {/* FK Schema Selector */}
                    <div className="space-y-1">
                      <label className="text-[9px] font-black text-blue-400 uppercase tracking-widest ml-1">Schema</label>
                      <select
                        value={newColumn.foreignKey.schema || activeSchema}
                        onChange={async (e: any) => {
                          const newFkSchema = e.target.value;
                          setNewColumn(prev => ({ ...prev, fkSchema: newFkSchema, foreignKey: { schema: newFkSchema, table: '', column: '' } }));
                          setFkTargetColumns([]);
                          setFkLoading(true);
                          try {
                            const res = await fetchWithAuth(`/api/data/${projectId}/tables?schema=${newFkSchema}`);
                            setFkTargetTables(res || []);
                          } catch { setFkTargetTables([]); }
                          finally { setFkLoading(false); }
                        }}
                        className="w-full bg-white border border-blue-200 rounded-xl py-2 px-3 text-xs font-bold text-slate-700 outline-none"
                      >
                        {schemas.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    {/* FK Target Table */}
                    <div className="space-y-1">
                      <label className="text-[9px] font-black text-blue-400 uppercase tracking-widest ml-1">Target Table</label>
                      <select
                        value={newColumn.foreignKey.table}
                        onChange={async (e: any) => {
                          const tbl = e.target.value;
                          const fkSch = newColumn.foreignKey?.schema || activeSchema;
                          setNewColumn(prev => ({ ...prev, foreignKey: { schema: fkSch, table: tbl, column: '' } }));
                          if (tbl) {
                            setFkLoading(true);
                            try {
                              const res = await fetchWithAuth(`/api/data/${projectId}/tables/${tbl}/columns?schema=${fkSch}`);
                              setFkTargetColumns(res.map((c: any) => c.name));
                              if (res.length > 0) {
                                const defaultCol = res.find((c: any) => c.name === 'id') ? 'id' : res[0].name;
                                setNewColumn(prev => ({ ...prev, foreignKey: { schema: fkSch, table: tbl, column: defaultCol } }));
                              }
                            } catch (err) { } finally { setFkLoading(false); }
                          }
                        }}
                        className="w-full bg-white border border-blue-200 rounded-xl py-2 px-3 text-xs font-bold text-slate-700 outline-none"
                      >
                        <option value="">Select Table...</option>
                        {(fkTargetTables.length > 0 ? fkTargetTables : tables).filter(t => t.name !== selectedTable).map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
                      </select>
                    </div>
                    {/* FK Target Column */}
                    {newColumn.foreignKey.table && (
                      <div className="space-y-1">
                        <label className="text-[9px] font-black text-blue-400 uppercase tracking-widest ml-1">Target Column</label>
                        {fkLoading ? <div className="py-2 flex justify-center"><Loader2 size={14} className="animate-spin text-blue-500" /></div> : (
                          <select
                            value={newColumn.foreignKey.column}
                            onChange={(e: any) => setNewColumn(prev => ({ ...prev, foreignKey: { ...prev.foreignKey!, column: e.target.value } }))}
                            className="w-full bg-white border border-blue-200 rounded-xl py-2 px-3 text-xs font-bold text-slate-700 outline-none"
                          >
                            {fkTargetColumns.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Smart Default Value — disabled when Identity or Serial is active */}
                <div className="space-y-1">
                  <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">Default Value</label>
                  {newColumn.identityGeneration ? (
                    <div className="w-full bg-teal-50 border border-teal-200 rounded-2xl py-3 px-4 font-mono text-xs font-bold text-teal-600 select-none">
                      ⚡ GENERATED {newColumn.identityGeneration === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY
                    </div>
                  ) : SERIAL_TYPES_SET.has(newColumn.type) ? (
                    <div className="w-full bg-amber-50 border border-amber-200 rounded-2xl py-3 px-4 font-mono text-xs font-bold text-amber-600 select-none">
                      ⚡ AUTO-INCREMENT (sequence)
                    </div>
                  ) : (
                    <>
                      <input
                        list="modal-defaults"
                        value={newColumn.defaultValue}
                        onChange={e => setNewColumn({ ...newColumn, defaultValue: e.target.value })}
                        placeholder="NULL (Optional)"
                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 font-mono text-xs font-medium text-slate-600 outline-none focus:ring-2 focus:ring-indigo-500/20"
                      />
                      <datalist id="modal-defaults">
                        {getDefaultSuggestions(newColumn.type, !!newColumn.identityGeneration).map(s => <option key={s} value={s} />)}
                      </datalist>
                    </>
                  )}
                </div>

                {/* Format Validation */}
                {(newColumn.type === 'text' || newColumn.type === 'varchar') && (
                  <div className="space-y-2 bg-amber-50/50 p-3 rounded-2xl border border-amber-100 animate-in slide-in-from-top-2">
                    <label className="text-[9px] font-black text-amber-500 uppercase tracking-widest ml-1 flex items-center gap-1">
                      <Shield size={10} /> Format Validation
                    </label>
                    <select
                      value={newColumn.formatPreset}
                      onChange={e => {
                        const val = e.target.value;
                        if (val === 'custom') {
                          setNewColumn({ ...newColumn, formatPreset: 'custom', formatPattern: '' });
                        } else {
                          setNewColumn({ ...newColumn, formatPreset: val, formatPattern: '' });
                        }
                      }}
                      className="w-full bg-white border border-amber-200 rounded-xl py-2 px-3 text-xs font-bold text-slate-700 outline-none cursor-pointer"
                    >
                      <option value="">None (No Validation)</option>
                      {Object.entries(FORMAT_PRESETS).map(([key, preset]) => (
                        <option key={key} value={key}>{preset.label} — {preset.description}</option>
                      ))}
                      <option value="custom">Custom Regex...</option>
                    </select>

                    {newColumn.formatPreset === 'custom' && (
                      <input
                        value={newColumn.formatPattern}
                        onChange={e => setNewColumn({ ...newColumn, formatPattern: e.target.value })}
                        placeholder="^[A-Z]{2}\d{4}$"
                        className="w-full bg-white border border-amber-200 rounded-xl py-2 px-3 text-xs font-mono font-medium text-slate-600 outline-none focus:ring-2 focus:ring-amber-400/30"
                      />
                    )}

                    {/* Live Preview */}
                    {(newColumn.formatPreset && newColumn.formatPreset !== 'custom') || newColumn.formatPattern ? (() => {
                      const pattern = newColumn.formatPreset !== 'custom'
                        ? FORMAT_PRESETS[newColumn.formatPreset]?.regex
                        : newColumn.formatPattern;
                      const example = newColumn.formatPreset !== 'custom'
                        ? FORMAT_PRESETS[newColumn.formatPreset]?.example
                        : '';
                      if (!pattern) return null;
                      const testOk = example ? new RegExp(pattern).test(example) : false;
                      return (
                        <div className="flex items-center gap-2 text-[10px] font-bold mt-1">
                          <div className={`w-2 h-2 rounded-full ${testOk ? 'bg-emerald-500' : 'bg-red-500'}`} />
                          <span className="text-slate-500">
                            Example: <span className="font-mono text-slate-700">{example || '—'}</span>
                            {testOk ? <span className="text-emerald-600 ml-1">✓ Match</span> : <span className="text-red-500 ml-1">✗ No match</span>}
                          </span>
                        </div>
                      );
                    })() : null}
                  </div>
                )}

              </div>
              <button onClick={handleAddColumn} disabled={executing} className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-700 transition-all flex items-center justify-center gap-2">
                {executing ? <Loader2 className="animate-spin" size={16} /> : 'Create Column'}
              </button>
              <button onClick={() => setShowAddColumn(false)} className="mt-4 text-xs font-bold text-slate-400 hover:text-slate-600 transition-colors">Cancel</button>
            </div>
          </div>
        )
      }

      {/* EDIT FORMAT MODAL — Column format validation editor */}
      {/* NOTE: Works with the "Add Column" modal and TableCreatorDrawer format system. */}
      {/* Server-side enforcement is in DataController.ts insertRows/updateRows. */}
      {
        editFormat && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
            <div className="bg-white rounded-[3rem] p-10 max-w-sm w-full shadow-2xl border border-slate-200 text-center">
              <div className="flex items-center justify-center gap-2 mb-6">
                <Shield size={18} className="text-amber-500" />
                <h3 className="text-xl font-black text-slate-900">Edit Format</h3>
              </div>
              <p className="text-xs text-slate-400 mb-6">Column: <span className="font-mono font-bold text-slate-700">{editFormat.column}</span></p>

              <div className="space-y-4 text-left">
                <select
                  value={editFormat.preset || ''}
                  onChange={e => {
                    const val = e.target.value;
                    setEditFormat({ ...editFormat, preset: val, customPattern: val === 'custom' ? '' : '' });
                  }}
                  className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-xs font-bold text-slate-700 outline-none cursor-pointer"
                >
                  <option value="">None (Remove Format)</option>
                  {Object.entries(FORMAT_PRESETS).map(([key, preset]) => (
                    <option key={key} value={key}>{preset.label} — {preset.example}</option>
                  ))}
                  <option value="custom">Custom Regex...</option>
                </select>

                {editFormat.preset === 'custom' && (
                  <input
                    value={editFormat.customPattern}
                    onChange={e => setEditFormat({ ...editFormat, customPattern: e.target.value })}
                    placeholder="^[A-Z]{2}\d{4}$"
                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-xs font-mono text-slate-600 outline-none focus:ring-2 focus:ring-amber-400/30"
                  />
                )}
              </div>

              <button
                onClick={handleSaveColumnFormat}
                disabled={executing}
                className="w-full mt-6 bg-amber-500 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-amber-600 transition-all flex items-center justify-center gap-2"
              >
                {executing ? <Loader2 className="animate-spin" size={16} /> : 'Save Format'}
              </button>
              <button onClick={() => setEditFormat(null)} className="mt-4 text-xs font-bold text-slate-400 hover:text-slate-600 transition-colors">Cancel</button>
            </div>
          </div>
        )
      }

      {/* NEW: DUPLICATE TABLE MODAL */}
      {
        showDuplicateModal && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
            <div className="bg-white rounded-[3rem] w-full max-w-sm p-12 shadow-2xl border border-slate-100 relative">
              <h3 className="text-xl font-black text-slate-900 mb-6">Duplicate Table</h3>
              <div className="space-y-4 mb-6">
                <div className="space-y-1"><label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">New Table Name</label><input autoFocus value={duplicateConfig.newName} onChange={(e: any) => setDuplicateConfig({ ...duplicateConfig, newName: e.target.value })} className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 font-bold text-sm outline-none" placeholder={duplicateConfig.source + '_copy'} /></div>
                <div className="flex items-center gap-3 p-2 cursor-pointer" onClick={() => setDuplicateConfig({ ...duplicateConfig, withData: !duplicateConfig.withData })}><div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${duplicateConfig.withData ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300'}`}>{duplicateConfig.withData && <Check size={14} className="text-white" />}</div><span className="text-xs font-bold text-slate-600">Copy Data Rows</span></div>
              </div>
              <button onClick={handleDuplicateTableSubmit} disabled={executing || !duplicateConfig.newName} className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-700 transition-all mb-3">{executing ? <Loader2 className="animate-spin mx-auto" /> : 'Duplicate'}</button>
              <button onClick={() => setShowDuplicateModal(false)} className="w-full py-2 text-xs font-bold text-slate-400 hover:text-slate-600">Cancel</button>
            </div>
          </div>
        )
      }

      {/* RECYCLE BIN MODAL */}
      {
        showRecycleBinModal && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[250] flex items-center justify-center p-8 animate-in zoom-in-95">
            <div className="bg-white rounded-[2.5rem] w-full max-w-xl shadow-2xl border border-slate-100 relative overflow-hidden">
              {/* Header */}
              <div className="p-8 pb-4 border-b border-slate-100">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-2xl bg-rose-100 flex items-center justify-center"><Trash2 size={20} className="text-rose-600" /></div>
                    <div>
                      <h3 className="text-xl font-black text-slate-900 tracking-tight">Recycle Bin</h3>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{recycleBin.length} table{recycleBin.length !== 1 ? 's' : ''} · {activeSchema}</p>
                    </div>
                  </div>
                  <button onClick={() => { setShowRecycleBinModal(false); setRecycleBinAction(null); setRecycleBinPassword(''); setRecycleBinError(''); }} className="text-slate-300 hover:text-slate-900 transition-colors"><X size={24} /></button>
                </div>
              </div>

              {/* Content */}
              <div className="p-6 max-h-[50vh] overflow-y-auto space-y-2">
                {recycleBin.length === 0 ? (
                  <div className="text-center py-12">
                    <Trash2 size={40} className="mx-auto text-slate-200 mb-4" />
                    <p className="text-sm font-bold text-slate-400">Recycle bin is empty</p>
                    <p className="text-[10px] text-slate-300 mt-1">Deleted tables will appear here</p>
                  </div>
                ) : recycleBin.map((item: any) => {
                  const originalName = item.name.replace(/^_deleted_\d+_/, '');
                  const deletedTs = item.name.match(/_deleted_(\d+)_/);
                  const deletedDate = deletedTs ? new Date(parseInt(deletedTs[1])).toLocaleString() : 'Unknown';
                  return (
                    <div key={item.name} className="flex items-center justify-between bg-slate-50 hover:bg-slate-100 rounded-2xl px-5 py-4 transition-all group">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-black text-slate-700 truncate">{originalName}</p>
                        <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">Deleted {deletedDate}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => { setRecycleBinAction({ type: 'restore', table: item.name }); setRecycleBinPassword(''); setRecycleBinError(''); }}
                          className="px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest bg-indigo-50 text-indigo-600 hover:bg-indigo-100 border border-indigo-200 transition-all"
                        >Restore</button>
                        <button
                          onClick={() => { setRecycleBinAction({ type: 'purge', table: item.name }); setRecycleBinPassword(''); setRecycleBinError(''); }}
                          className="px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest bg-rose-50 text-rose-600 hover:bg-rose-100 border border-rose-200 transition-all"
                        >Purge</button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Password Prompt (shows when action selected) */}
              {recycleBinAction && (
                <div className="p-6 pt-0 border-t border-slate-100 bg-slate-50/50">
                  <div className="mt-4 p-4 rounded-2xl border border-slate-200 bg-white space-y-3">
                    <div className="flex items-center gap-2">
                      <Shield size={14} className={recycleBinAction.type === 'purge' ? 'text-rose-500' : 'text-indigo-500'} />
                      <p className="text-xs font-black text-slate-700">
                        {recycleBinAction.type === 'purge' ? 'Permanently delete' : 'Restore'}{' '}
                        <span className="text-slate-900 bg-slate-100 px-1.5 py-0.5 rounded">
                          {recycleBinAction.table.replace(/^_deleted_\d+_/, '')}
                        </span>
                        ?
                      </p>
                    </div>
                    {recycleBinAction.type === 'purge' && (
                      <p className="text-[10px] font-bold text-rose-500 bg-rose-50 px-3 py-2 rounded-lg">⚠ This action is IRREVERSIBLE. All data will be permanently lost.</p>
                    )}
                    <input
                      type="password"
                      placeholder="Admin password required"
                      value={recycleBinPassword}
                      onChange={(e: any) => setRecycleBinPassword(e.target.value)}
                      onKeyDown={(e: any) => e.key === 'Enter' && handleRecycleBinConfirm()}
                      className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm font-medium text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all"
                      autoFocus
                    />
                    {recycleBinError && <p className="text-[10px] font-bold text-rose-500">{recycleBinError}</p>}
                    <div className="flex gap-3">
                      <button
                        onClick={() => { setRecycleBinAction(null); setRecycleBinPassword(''); setRecycleBinError(''); }}
                        className="flex-1 py-2.5 text-xs font-black text-slate-400 uppercase tracking-widest hover:text-slate-600"
                      >Cancel</button>
                      <button
                        onClick={handleRecycleBinConfirm}
                        disabled={executing || !recycleBinPassword}
                        className={`flex-1 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed ${recycleBinAction.type === 'purge'
                          ? 'bg-rose-600 text-white hover:bg-rose-700'
                          : 'bg-indigo-600 text-white hover:bg-indigo-700'
                          }`}
                      >
                        {executing ? <Loader2 size={14} className="animate-spin mx-auto" /> : recycleBinAction.type === 'purge' ? 'Purge Forever' : 'Restore Table'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      }

      {/* IMPORT MODAL */}
      {
        showImportModal && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[250] flex items-center justify-center p-8 animate-in zoom-in-95">
            <div className="bg-white rounded-[3.5rem] w-full max-w-lg p-12 shadow-2xl border border-slate-100 relative">
              <button onClick={() => setShowImportModal(false)} className="absolute top-8 right-8 text-slate-300 hover:text-slate-900 transition-colors"><X size={24} /></button>
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
                  <input type="file" accept=".csv, .xlsx, .json" onChange={(e: any) => setImportFile(e.target.files?.[0] || null)} className="absolute inset-0 opacity-0 cursor-pointer" />
                  {importFile ? <span className="font-bold text-slate-900">{importFile.name}</span> : <div className="flex flex-col items-center text-slate-300 group-hover:text-emerald-500"><Upload size={40} className="mb-2" /><span className="font-bold text-sm">Drop file here</span></div>}
                </div>

                <button onClick={handleImport} disabled={!importFile || executing} className="w-full bg-slate-900 text-white py-5 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl flex items-center justify-center gap-3 disabled:opacity-50">
                  {executing ? <Loader2 className="animate-spin" size={18} /> : 'Start Ingestion'}
                </button>
              </div>
            </div>
          </div>
        )
      }

      {/* Clipboard Fallback Modal (HTTP Environment Support) */}
      {clipboardFallbackSQL && (
        <div className="fixed inset-0 z-[60] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden border border-slate-200">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-amber-50">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center text-amber-600">
                  <Copy size={16} />
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-800">Cópia Manual Necessária</h3>
                  <p className="text-[10px] text-slate-500 font-medium tracking-wide">
                    Pressione <kbd className="bg-slate-200 px-1 py-0.5 rounded text-slate-700">Ctrl+C</kbd> para copiar o código abaixo.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setClipboardFallbackSQL(null)}
                className="w-8 h-8 rounded-full hover:bg-slate-200 flex items-center justify-center text-slate-400"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-4 bg-slate-50">
              <textarea
                ref={fallbackTextareaRef}
                value={clipboardFallbackSQL}
                readOnly
                className="w-full h-48 bg-slate-900 text-emerald-400 font-mono text-xs p-4 rounded-xl outline-none resize-none border border-slate-800 selection:bg-indigo-500/50"
              />
            </div>
            <div className="px-4 py-3 bg-white border-t border-slate-100 flex justify-end">
              <button
                onClick={() => setClipboardFallbackSQL(null)}
                className="px-6 py-2 bg-indigo-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-indigo-700 transition-colors"
              >
                Feito, fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div >
  );
};

export default DatabaseExplorer;