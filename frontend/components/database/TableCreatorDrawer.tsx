
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { X, Plus, Loader2, Link as LinkIcon, Shield, ShieldOff, Regex, Cpu, Lock } from 'lucide-react';

// ============================================================
// TableCreatorDrawer — Enterprise Schema Designer
// ============================================================
// Generates idempotent, conflict-free SQL with professional formatting.
// Smart quoting: text defaults auto-wrapped, functions/numbers stay bare.
// ============================================================

interface ColumnDef {
    id: string;
    name: string;
    type: string;
    defaultValue: string;
    isPrimaryKey: boolean;
    isNullable: boolean;
    isUnique: boolean;
    isArray: boolean;
    identityGeneration?: 'always' | 'by_default'; // GENERATED {ALWAYS|BY DEFAULT} AS IDENTITY (PG10+)
    foreignKey?: { schema: string; table: string; column: string };
    sourceHeader?: string;
    description?: string;
    formatPreset?: string;
    formatPattern?: string;
    lockLevel?: 'unlocked' | 'immutable' | 'insert_only' | 'service_role_only' | 'otp_protected';
}

// Types that support GENERATED AS IDENTITY (only pure integer types — NOT serial/bigserial)
const IDENTITY_COMPATIBLE_TYPES = new Set(['int2', 'int4', 'int8']);

// Types that already have built-in auto-increment (legacy — identity not needed)
const SERIAL_TYPES = new Set(['serial', 'bigserial', 'smallserial']);

// Format presets for column validation (mirrored from backend)
const FORMAT_PRESETS: Record<string, { label: string; regex: string; example: string }> = {
    email: { label: 'Email', regex: '^[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}$', example: 'user@example.com' },
    cpf: { label: 'CPF', regex: '^\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}$', example: '123.456.789-00' },
    cnpj: { label: 'CNPJ', regex: '^\\d{2}\\.\\d{3}\\.\\d{3}\\/\\d{4}-\\d{2}$', example: '12.345.678/0001-99' },
    phone_br: { label: 'Phone (BR)', regex: '^\\+?55\\s?\\(?\\d{2}\\)?\\s?\\d{4,5}-?\\d{4}$', example: '+55 (11) 99999-1234' },
    cep: { label: 'CEP', regex: '^\\d{5}-?\\d{3}$', example: '01310-100' },
    url: { label: 'URL', regex: '^https?:\\/\\/[a-zA-Z0-9\\-]+(\\.[a-zA-Z0-9\\-]+)+(\\/.*)?$', example: 'https://example.com' },
    uuid_format: { label: 'UUID', regex: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', example: 'a1b2c3d4-...' },
    date_br: { label: 'Date (BR)', regex: '^\\d{2}\\/\\d{2}\\/\\d{4}$', example: '25/02/2026' },
};

interface TableCreatorDrawerProps {
    isOpen: boolean;
    onClose: () => void;
    tables: { name: string }[];
    schemas: string[];
    activeSchema: string;
    projectId: string;
    fetchWithAuth: (url: string, options?: any) => Promise<any>;
    onSqlGenerated: (sql: string, metaConfig: { tableName: string, mcpEnabled: boolean, mcpPerms: { r: boolean, c: boolean, u: boolean, d: boolean }, lockedColumns?: Record<string, string> }) => void;
    onSqlSaveToEditor?: (sql: string) => void;
    initialTableName?: string;
    initialColumns?: ColumnDef[];
}

// --- Helpers ---
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

const sanitizeName = (val: string) =>
    val.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^[0-9]/, "_$&");

// Expanded default suggestions per type — PostgreSQL 18 native capabilities
const getDefaultSuggestions = (type: string, hasIdentity?: boolean): string[] => {
    // If identity is active, no default needed (they're mutually exclusive in PG)
    if (hasIdentity) return [];
    const t = type.toLowerCase();
    if (t === 'uuid') return ['gen_random_uuid()'];
    if (t.includes('timestamp') || t === 'date') return ['now()', 'current_timestamp', 'current_date', "timezone('utc', now())"];
    if (t === 'time') return ['current_time', 'localtime'];
    if (t === 'interval') return ["'1 hour'::interval", "'30 days'::interval", "'0'::interval"];
    if (t.includes('bool')) return ['true', 'false'];
    if (IDENTITY_COMPATIBLE_TYPES.has(t)) return ['0', '1'];
    if (t.includes('numeric') || t.includes('float') || t === 'float8' || t === 'money') return ['0', '1'];
    if (t.includes('json')) return ["'{}'::jsonb", "'[]'::jsonb", "'null'::jsonb"];
    if (t === 'text' || t === 'varchar') return ["''", 'current_user', 'session_user'];
    if (t === 'inet') return ["'0.0.0.0'::inet", 'inet_client_addr()'];
    if (t === 'point') return ["'(0,0)'::point"];
    if (t === 'bytea') return ["'\\x'::bytea"];
    return [];
};

// Smart quoting
const BARE_PATTERNS = [
    /^gen_random_uuid\(\)$/i,
    /^now\(\)$/i,
    /^current_(timestamp|date|time)$/i,
    /^localtime$/i,
    /^timezone\(/i,
    /^nextval\(/i,
    /^true$/i,
    /^false$/i,
    /^null$/i,
    /^current_user$/i,
    /^session_user$/i,
    /^inet_client_addr\(\)$/i,
];

const formatDefaultValue = (type: string, raw: string): string => {
    const v = raw.trim();
    if (!v) return '';
    if (v.startsWith("'") && v.endsWith("'")) return v;
    if (v.includes('::')) return v;
    if (BARE_PATTERNS.some(p => p.test(v))) return v;
    if (v.includes('(') && v.includes(')')) return v;
    const tn = type.toLowerCase();
    if (/^(int|float|numeric|real|double|serial|bigserial)/.test(tn) && !isNaN(Number(v))) return v;
    if (/bool/.test(tn) && ['true', 'false'].includes(v.toLowerCase())) return v;
    return `'${v.replace(/'/g, "''")}'`;
};

const DEFAULT_COLUMNS: ColumnDef[] = [
    { id: '1', name: 'id', type: 'uuid', defaultValue: 'gen_random_uuid()', isPrimaryKey: true, isNullable: false, isUnique: true, isArray: false, lockLevel: 'immutable' },
    { id: '2', name: 'created_at', type: 'timestamptz', defaultValue: 'now()', isPrimaryKey: false, isNullable: false, isUnique: false, isArray: false, lockLevel: 'insert_only' },
];

const TableCreatorDrawer: React.FC<TableCreatorDrawerProps> = ({
    isOpen,
    onClose,
    tables,
    schemas,
    activeSchema,
    projectId,
    fetchWithAuth,
    onSqlGenerated,
    onSqlSaveToEditor,
    initialTableName = '',
    initialColumns,
}) => {
    const [tableName, setTableName] = useState(initialTableName);
    const [tableDesc, setTableDesc] = useState('');
    const [columns, setColumns] = useState<ColumnDef[]>(initialColumns || [...DEFAULT_COLUMNS]);
    const [enableRLS, setEnableRLS] = useState(true);
    const [activeFkEditor, setActiveFkEditor] = useState<string | null>(null);
    const [fkTargetColumns, setFkTargetColumns] = useState<string[]>([]);
    const [fkTargetTables, setFkTargetTables] = useState<{ name: string }[]>([]);
    const [fkLoading, setFkLoading] = useState(false);

    const scrollRef = useRef<HTMLDivElement>(null);
    const lastAddedIdRef = useRef<string | null>(null);
    const columnInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

    // Validation
    const hasEmptyColumn = columns.some(c => !c.name.trim());
    const canGenerate = !!tableName && !hasEmptyColumn;

    useEffect(() => {
        if (initialTableName) setTableName(initialTableName);
    }, [initialTableName]);

    useEffect(() => {
        if (initialColumns) setColumns(initialColumns);
    }, [initialColumns]);

    // MCP Access state
    const [mcpEnabled, setMcpEnabled] = useState(false);
    const [mcpPerms, setMcpPerms] = useState(() => {
        try {
            const saved = localStorage.getItem(`cascata_mcp_defaults_${projectId}`);
            if (saved) return JSON.parse(saved);
        } catch { /* ignore */ }
        return { r: true, c: true, u: true, d: false };
    });

    useEffect(() => {
        if (!isOpen) return;
        (async () => {
            try {
                const res = await fetchWithAuth(`/api/data/${projectId}/metadata`);
                const gov = res?.metadata?.ai_governance;
                setMcpEnabled(gov?.mcp_enabled === true);
            } catch { setMcpEnabled(false); }
        })();
    }, [isOpen, projectId]);

    useEffect(() => {
        localStorage.setItem(`cascata_mcp_defaults_${projectId}`, JSON.stringify(mcpPerms));
    }, [mcpPerms, projectId]);

    // Reset when drawer opens fresh
    useEffect(() => {
        if (isOpen && !initialTableName && !initialColumns) {
            setTableName('');
            setTableDesc('');
            setColumns([...DEFAULT_COLUMNS]);
            setEnableRLS(true);
            setActiveFkEditor(null);
        }
    }, [isOpen]);

    // Auto-focus newly added column input
    useEffect(() => {
        if (lastAddedIdRef.current) {
            const id = lastAddedIdRef.current;
            lastAddedIdRef.current = null;
            requestAnimationFrame(() => {
                const input = columnInputRefs.current.get(id);
                if (input) {
                    input.focus();
                    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            });
        }
    }, [columns]);

    // --- Column Operations ---
    const handleAddColumn = () => {
        const newId = getUUID();
        lastAddedIdRef.current = newId;
        setColumns(prev => [...prev, {
            id: newId, name: '', type: 'text', defaultValue: '',
            isPrimaryKey: false, isNullable: true, isUnique: false, isArray: false
        }]);
    };

    const handleRemoveColumn = (id: string) => {
        setColumns(prev => prev.filter(c => c.id !== id));
        columnInputRefs.current.delete(id);
    };

    const handleColumnChange = (id: string, field: string, value: any) => {
        setColumns(prev => prev.map(c => {
            if (c.id !== id) return c;

            const updated = { ...c, [field]: value };

            // ── MUTUAL EXCLUSION: Array ↔ Foreign Key ↔ Identity ──
            // PostgreSQL constraints that are mutually exclusive:
            // - REFERENCES cannot be on array columns
            // - GENERATED AS IDENTITY cannot be on array columns
            // - SERIAL types cannot be array columns
            if (field === 'isArray' && value === true) {
                updated.foreignKey = undefined;
                updated.identityGeneration = undefined;
                if (activeFkEditor === id) setActiveFkEditor(null);
            }

            // Identity activated → clear default (mutually exclusive in PG)
            if (field === 'identityGeneration' && value) {
                updated.defaultValue = '';
                updated.isArray = false;
            }

            return updated;
        }));
    };

    const handleSetForeignKey = async (id: string, fkSchema: string, table: string, column: string) => {
        setColumns(prev => prev.map(c => {
            if (c.id !== id) return c;
            const updated = {
                ...c,
                foreignKey: table ? { schema: fkSchema || activeSchema, table, column: column || '' } : undefined,
                // ── MUTUAL EXCLUSION: FK activated → deactivate Array ──
                isArray: table ? false : c.isArray
            };
            return updated;
        }));

        if (table) {
            setFkLoading(true);
            try {
                const res = await fetchWithAuth(`/api/data/${projectId}/tables/${table}/columns?schema=${fkSchema || activeSchema}`);
                const cols = res.map((c: any) => c.name);
                setFkTargetColumns(cols);
                const defaultCol = cols.includes('id') ? 'id' : cols[0] || '';
                setColumns(prev => prev.map(c =>
                    c.id === id ? { ...c, foreignKey: { schema: fkSchema || activeSchema, table, column: defaultCol } } : c
                ));
            } catch (e) { /* ignore */ }
            finally { setFkLoading(false); }
        }
    };

    // Load tables for a specific FK schema
    const loadFkTablesForSchema = async (fkSchema: string) => {
        setFkLoading(true);
        try {
            const res = await fetchWithAuth(`/api/data/${projectId}/tables?schema=${fkSchema}`);
            setFkTargetTables(res || []);
        } catch { setFkTargetTables([]); }
        finally { setFkLoading(false); }
    };

    // Load tables for the current schema on FK editor open
    const handleOpenFkEditor = async (colId: string) => {
        if (activeFkEditor === colId) {
            setActiveFkEditor(null);
            return;
        }
        setActiveFkEditor(colId);
        // Default to current schema's tables
        const col = columns.find(c => c.id === colId);
        const fkSchema = col?.foreignKey?.schema || activeSchema;
        await loadFkTablesForSchema(fkSchema);
    };

    // --- Enterprise SQL Generator (pure text — no side effects) ---
    const generateSQLText = useCallback((): { sql: string; safeName: string; lockedColumns: Record<string, string> } | null => {
        if (!canGenerate) return null;
        const safeName = sanitizeName(tableName);
        const schema = activeSchema || 'public';

        const colNames = columns.map(c => sanitizeName(c.name || 'unnamed'));
        const maxNameLen = Math.max(...colNames.map(n => n.length), 10);

        const colDefs = columns.map((c) => {
            const name = sanitizeName(c.name || 'unnamed');
            const paddedName = name.padEnd(maxNameLen);
            const type = c.isArray ? `${c.type}[]` : c.type;

            let constraints: string[] = [];

            if (c.isPrimaryKey) constraints.push('PRIMARY KEY');
            if (!c.isNullable && !c.isPrimaryKey) constraints.push('NOT NULL');
            if (c.isUnique && !c.isPrimaryKey) constraints.push('UNIQUE');

            // GENERATED AS IDENTITY (modern auto-increment) — mutually exclusive with DEFAULT
            if (c.identityGeneration && IDENTITY_COMPATIBLE_TYPES.has(c.type)) {
                const gen = c.identityGeneration === 'always' ? 'ALWAYS' : 'BY DEFAULT';
                constraints.push(`GENERATED ${gen} AS IDENTITY`);
            } else if (c.defaultValue && c.defaultValue.trim() && !SERIAL_TYPES.has(c.type)) {
                // Serial types auto-create sequences — no DEFAULT needed
                const formatted = formatDefaultValue(c.type, c.defaultValue);
                constraints.push(`DEFAULT ${formatted}`);
            }

            // Foreign key constraint — includes schema for cross-schema references
            if (c.foreignKey && c.foreignKey.table && c.foreignKey.column) {
                const fkSchema = c.foreignKey.schema || schema;
                const fkTable = sanitizeName(c.foreignKey.table);
                const fkCol = sanitizeName(c.foreignKey.column);
                constraints.push(`REFERENCES ${fkSchema}.${fkTable}(${fkCol})`);
            }

            const constraintStr = constraints.length > 0 ? ' ' + constraints.join(' ') : '';
            return `    ${paddedName} ${type}${constraintStr}`;
        });

        const lines: string[] = [];
        lines.push(`-- Create table: ${safeName}`);
        lines.push(`CREATE TABLE IF NOT EXISTS ${schema}.${safeName} (`);
        lines.push(colDefs.join(',\n'));
        lines.push(`);`);

        if (enableRLS) {
            lines.push('');
            lines.push(`-- Enable Row Level Security`);
            lines.push(`ALTER TABLE ${schema}.${safeName} ENABLE ROW LEVEL SECURITY;`);
        }

        // Column comments
        const commentLines: string[] = [];
        columns.forEach((c) => {
            const name = sanitizeName(c.name || 'unnamed');
            const formatStr = c.formatPreset && c.formatPreset !== 'custom' ? c.formatPreset : c.formatPattern;
            const desc = c.description || '';
            const commentBody = formatStr ? `${desc}||FORMAT:${formatStr}` : desc;
            if (commentBody) {
                commentLines.push(`COMMENT ON COLUMN ${schema}.${safeName}.${name} IS '${commentBody.replace(/'/g, "''")}';`);
            }
        });
        if (commentLines.length > 0) {
            lines.push('');
            lines.push('-- Column format validation & descriptions');
            commentLines.forEach(l => lines.push(l));
        }

        const hasDesc = tableDesc.trim().length > 0;
        if (hasDesc || mcpEnabled) {
            lines.push('');
            lines.push('-- Table Comment & Governance');
            const cleanDesc = hasDesc ? tableDesc.replace(/'/g, "''").trim() : '';
            if (mcpEnabled) {
                const mcpFlag = `MCP:${mcpPerms.r ? 'R' : ''}${mcpPerms.c ? 'C' : ''}${mcpPerms.u ? 'U' : ''}${mcpPerms.d ? 'D' : ''}`;
                lines.push(`COMMENT ON TABLE ${schema}.${safeName} IS '${cleanDesc}||${mcpFlag}';`);
            } else {
                lines.push(`COMMENT ON TABLE ${schema}.${safeName} IS '${cleanDesc}';`);
            }
        }

        // TIER-3 PADLOCK
        const lockedColumns: Record<string, string> = {};
        columns.forEach(c => {
            if (c.lockLevel && c.lockLevel !== 'unlocked') {
                lockedColumns[sanitizeName(c.name || 'unnamed')] = c.lockLevel;
            }
        });

        return { sql: lines.join('\n'), safeName, lockedColumns };
    }, [tableName, tableDesc, columns, enableRLS, activeSchema, mcpEnabled, mcpPerms, canGenerate]);

    // --- Execute SQL (Generate + Fire callback + Close) ---
    const generateSQL = useCallback(() => {
        const result = generateSQLText();
        if (!result) return;
        onSqlGenerated(result.sql, {
            tableName: result.safeName,
            mcpEnabled,
            mcpPerms,
            lockedColumns: result.lockedColumns
        });
        onClose();
    }, [generateSQLText, mcpEnabled, mcpPerms, onSqlGenerated, onClose]);

    // --- Save SQL to Editor (Generate + Send to console + Close) ---
    const saveToEditor = useCallback(() => {
        const result = generateSQLText();
        if (!result) return;
        if (onSqlSaveToEditor) onSqlSaveToEditor(result.sql);
        onClose();
    }, [generateSQLText, onSqlSaveToEditor, onClose]);

    // --- Keyboard Shortcuts (Ctrl+Enter = Execute, Ctrl+S = Save to Editor) ---
    useEffect(() => {
        if (!isOpen) return;
        const handler = (e: KeyboardEvent) => {
            // Ctrl+S → Save SQL to editor without executing
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                saveToEditor();
                return;
            }
            // Ctrl+Enter → Generate & Execute SQL
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                generateSQL();
                return;
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [isOpen, generateSQL, saveToEditor]);

    // Click outside handler for FK editor
    useEffect(() => {
        if (!activeFkEditor) return;
        const handler = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (!target.closest('[data-fk-editor]')) {
                setActiveFkEditor(null);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [activeFkEditor]);

    return (
        <div className={`fixed inset-y-0 right-0 w-[500px] bg-white shadow-2xl z-[100] transform transition-transform duration-300 ease-in-out flex flex-col border-l border-slate-200 ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}>
            {/* Header */}
            <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                <div>
                    <h3 className="text-xl font-black text-slate-900 tracking-tight">Create New Table</h3>
                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Schema Designer</p>
                </div>
                <button onClick={onClose} className="p-2 hover:bg-slate-200 rounded-lg text-slate-400">
                    <X size={20} />
                </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6 space-y-8" ref={scrollRef}>
                {/* Table Name + Description */}
                <div className="space-y-4">
                    <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Table Name</label>
                        <input
                            autoFocus
                            value={tableName}
                            onChange={(e: any) => setTableName(sanitizeName(e.target.value))}
                            placeholder="users"
                            className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 px-4 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-500/20"
                        />
                    </div>
                    <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Description (for AI)</label>
                        <input
                            value={tableDesc}
                            onChange={(e: any) => setTableDesc(e.target.value)}
                            placeholder="e.g. Stores registered users."
                            className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 px-4 text-sm font-medium outline-none focus:ring-2 focus:ring-indigo-500/20 text-slate-600"
                        />
                    </div>
                </div>

                {/* Column Definitions */}
                <div className="space-y-4">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Column Definitions</label>
                    <div className="space-y-3">
                        {columns.map((col) => (
                            <div key={col.id} className={`bg-white border rounded-xl p-3 shadow-sm hover:shadow-md transition-all group relative ${!col.name.trim() ? 'border-amber-300 bg-amber-50/30' : 'border-slate-200'}`}>
                                <div className="flex gap-3 mb-3">
                                    <input
                                        ref={(el) => { if (el) columnInputRefs.current.set(col.id, el); }}
                                        value={col.name}
                                        onChange={(e: any) => handleColumnChange(col.id, 'name', sanitizeName(e.target.value))}
                                        onKeyDown={(e: any) => { if (e.key === 'Enter') { e.preventDefault(); handleAddColumn(); } }}
                                        placeholder="column_name"
                                        className={`flex-[2] bg-slate-50 border-none rounded-lg px-3 py-2 text-xs font-bold outline-none ${!col.name.trim() ? 'placeholder:text-amber-400' : ''}`}
                                    />
                                    <select
                                        value={col.type}
                                        onChange={(e: any) => {
                                            const newType = e.target.value;
                                            handleColumnChange(col.id, 'type', newType);
                                            // AUTO-CLEAR identity if new type doesn't support it
                                            if (!IDENTITY_COMPATIBLE_TYPES.has(newType) && col.identityGeneration) {
                                                handleColumnChange(col.id, 'identityGeneration', undefined);
                                            }
                                            // AUTO-CLEAR identity if switching to serial (has built-in auto-inc)
                                            if (SERIAL_TYPES.has(newType) && col.identityGeneration) {
                                                handleColumnChange(col.id, 'identityGeneration', undefined);
                                            }
                                        }}
                                        className="flex-1 bg-slate-100 border-none rounded-lg px-2 py-2 text-[10px] font-black uppercase text-slate-600 outline-none cursor-pointer"
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
                                            <option value="vector">vector (Embedding)</option>
                                        </optgroup>
                                    </select>
                                    <button onClick={() => handleRemoveColumn(col.id)} className="p-2 text-slate-300 hover:text-rose-500 transition-colors"><X size={14} /></button>
                                </div>

                                {/* Default Value + Constraint Toggles */}
                                <div className="flex items-center gap-3 bg-slate-50 p-2 rounded-lg relative">
                                    {col.identityGeneration ? (
                                        <span className="flex-1 text-[10px] font-mono text-teal-600 font-bold select-none" title="Default value is disabled when Identity (auto-increment) is active">
                                            ⚡ GENERATED {col.identityGeneration === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY
                                        </span>
                                    ) : SERIAL_TYPES.has(col.type) ? (
                                        <span className="flex-1 text-[10px] font-mono text-amber-600 font-bold select-none" title="Serial types have built-in auto-increment sequence">
                                            ⚡ AUTO-INCREMENT (sequence)
                                        </span>
                                    ) : (
                                        <>
                                            <input
                                                list={`defaults-${col.id}`}
                                                value={col.defaultValue}
                                                onChange={(e: any) => handleColumnChange(col.id, 'defaultValue', e.target.value)}
                                                placeholder="Default Value (NULL)"
                                                className="flex-1 bg-transparent border-none text-[10px] font-mono text-slate-600 outline-none placeholder:text-slate-300"
                                            />
                                            <datalist id={`defaults-${col.id}`}>
                                                {getDefaultSuggestions(col.type, !!col.identityGeneration).map(s => <option key={s} value={s} />)}
                                            </datalist>
                                        </>
                                    )}
                                    <div className="h-4 w-[1px] bg-slate-200"></div>
                                    <div className="flex items-center gap-2">
                                        <div title="Primary Key" onClick={() => handleColumnChange(col.id, 'isPrimaryKey', !col.isPrimaryKey)} className={`px-1.5 py-1 rounded text-[9px] font-black cursor-pointer select-none transition-colors ${col.isPrimaryKey ? 'bg-amber-100 text-amber-700' : 'text-slate-300 hover:bg-slate-200'}`}>PK</div>
                                        {/* AUTO — Identity (Auto-Increment) — only for int2/int4/int8, not serial/bigserial */}
                                        {IDENTITY_COMPATIBLE_TYPES.has(col.type) && !SERIAL_TYPES.has(col.type) && (
                                            <div
                                                title={col.isArray
                                                    ? "Auto-increment (disabled — Array columns cannot use IDENTITY)"
                                                    : col.identityGeneration
                                                        ? `Auto-increment: GENERATED ${col.identityGeneration === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY (click to cycle/disable)`
                                                        : "Auto-increment (GENERATED AS IDENTITY)"
                                                }
                                                onClick={() => {
                                                    if (col.isArray) return; // Identity incompatible with arrays
                                                    // Cycle: off → always → by_default → off
                                                    if (!col.identityGeneration) {
                                                        handleColumnChange(col.id, 'identityGeneration', 'always');
                                                        handleColumnChange(col.id, 'defaultValue', ''); // Clear default (mutually exclusive)
                                                    } else if (col.identityGeneration === 'always') {
                                                        handleColumnChange(col.id, 'identityGeneration', 'by_default');
                                                    } else {
                                                        handleColumnChange(col.id, 'identityGeneration', undefined);
                                                    }
                                                }}
                                                className={`px-1.5 py-1 rounded text-[9px] font-black cursor-pointer select-none transition-colors ${col.isArray ? 'text-slate-200 cursor-not-allowed' :
                                                    col.identityGeneration === 'always' ? 'bg-teal-100 text-teal-700 ring-1 ring-teal-300' :
                                                        col.identityGeneration === 'by_default' ? 'bg-cyan-100 text-cyan-700 ring-1 ring-cyan-300' :
                                                            'text-slate-300 hover:bg-slate-200'
                                                    }`}
                                            >
                                                AUTO
                                            </div>
                                        )}
                                        <div
                                            title={col.isArray ? "Foreign Key (disabled — Array columns cannot have REFERENCES)" : "Foreign Key"}
                                            onClick={(e: any) => {
                                                e.stopPropagation();
                                                if (col.isArray) return;
                                                handleOpenFkEditor(col.id);
                                            }}
                                            className={`px-1.5 py-1 rounded cursor-pointer select-none transition-colors flex items-center ${col.isArray ? 'text-slate-200 cursor-not-allowed' : col.foreignKey ? 'bg-blue-100 text-blue-700' : 'text-slate-300 hover:bg-slate-200'}`}
                                        >
                                            <LinkIcon size={12} strokeWidth={4} />
                                        </div>
                                        <div
                                            title={
                                                col.foreignKey ? "Array (disabled — FK columns cannot be arrays)" :
                                                    col.identityGeneration ? "Array (disabled — Identity columns cannot be arrays)" :
                                                        SERIAL_TYPES.has(col.type) ? "Array (disabled — Serial types cannot be arrays)" :
                                                            "Array"
                                            }
                                            onClick={() => {
                                                if (col.foreignKey || col.identityGeneration || SERIAL_TYPES.has(col.type)) return;
                                                handleColumnChange(col.id, 'isArray', !col.isArray);
                                            }}
                                            className={`px-1.5 py-1 rounded text-[9px] font-black cursor-pointer select-none transition-colors ${(col.foreignKey || col.identityGeneration || SERIAL_TYPES.has(col.type))
                                                ? 'text-slate-200 cursor-not-allowed'
                                                : col.isArray ? 'bg-indigo-100 text-indigo-700' : 'text-slate-300 hover:bg-slate-200'
                                                }`}
                                        >
                                            LIST
                                        </div>
                                        <div title="Nullable" onClick={() => handleColumnChange(col.id, 'isNullable', !col.isNullable)} className={`px-1.5 py-1 rounded text-[9px] font-black cursor-pointer select-none transition-colors ${col.isNullable ? 'bg-emerald-100 text-emerald-700' : 'text-slate-300 hover:bg-slate-200'}`}>NULL</div>
                                        <div title="Unique" onClick={() => handleColumnChange(col.id, 'isUnique', !col.isUnique)} className={`px-1.5 py-1 rounded text-[9px] font-black cursor-pointer select-none transition-colors ${col.isUnique ? 'bg-purple-100 text-purple-700' : 'text-slate-300 hover:bg-slate-200'}`}>UNIQ</div>
                                        {(col.type === 'text' || col.type === 'varchar') && (
                                            <div title="Format Validation" onClick={() => handleColumnChange(col.id, 'formatPreset', col.formatPreset ? undefined : 'email')} className={`px-1.5 py-1 rounded cursor-pointer select-none transition-colors flex items-center gap-0.5 ${col.formatPreset || col.formatPattern ? 'bg-amber-100 text-amber-700' : 'text-slate-300 hover:bg-slate-200'}`}><Regex size={10} strokeWidth={3} /></div>
                                        )}
                                        <div title="Security Lock (Immutability)" onClick={() => handleColumnChange(col.id, 'lockLevel', col.lockLevel && col.lockLevel !== 'unlocked' ? 'unlocked' : 'immutable')} className={`px-1.5 py-1 rounded cursor-pointer select-none transition-colors flex items-center gap-0.5 ${col.lockLevel && col.lockLevel !== 'unlocked' ? 'bg-rose-100 text-rose-700 border border-rose-300' : 'text-slate-300 hover:bg-slate-200'}`}><Lock size={10} strokeWidth={3} /></div>
                                    </div>
                                </div>

                                {/* Format Validation Editor (inline) */}
                                {(col.formatPreset || col.formatPattern) && (col.type === 'text' || col.type === 'varchar') && (
                                    <div className="mt-2 bg-amber-50/50 border border-amber-100 rounded-lg p-2 animate-in slide-in-from-top-1">
                                        <select
                                            value={col.formatPreset || 'custom'}
                                            onChange={(e) => {
                                                const val = e.target.value;
                                                if (val === 'custom') {
                                                    handleColumnChange(col.id, 'formatPreset', 'custom');
                                                    handleColumnChange(col.id, 'formatPattern', '');
                                                } else if (val === '') {
                                                    handleColumnChange(col.id, 'formatPreset', undefined);
                                                    handleColumnChange(col.id, 'formatPattern', undefined);
                                                } else {
                                                    handleColumnChange(col.id, 'formatPreset', val);
                                                    handleColumnChange(col.id, 'formatPattern', undefined);
                                                }
                                            }}
                                            className="w-full bg-white border border-amber-200 rounded py-1.5 px-2 text-[10px] font-bold text-slate-700 outline-none cursor-pointer"
                                        >
                                            <option value="">Remove Format</option>
                                            {Object.entries(FORMAT_PRESETS).map(([key, p]) => (
                                                <option key={key} value={key}>{p.label} ({p.example})</option>
                                            ))}
                                            <option value="custom">Custom Regex...</option>
                                        </select>
                                        {col.formatPreset === 'custom' && (
                                            <input
                                                value={col.formatPattern || ''}
                                                onChange={(e) => handleColumnChange(col.id, 'formatPattern', e.target.value)}
                                                placeholder="^[A-Z]{2}\d{4}$"
                                                className="w-full mt-1.5 bg-white border border-amber-200 rounded py-1.5 px-2 text-[10px] font-mono text-slate-600 outline-none"
                                            />
                                        )}
                                    </div>
                                )}

                                {/* Security Lock Editor (inline) */}
                                {col.lockLevel && col.lockLevel !== 'unlocked' && (
                                    <div className="mt-2 bg-rose-50/50 border border-rose-200 rounded-lg p-2 animate-in slide-in-from-top-1">
                                        <div className="flex items-center gap-2 mb-2">
                                            <Lock size={12} className="text-rose-500" />
                                            <span className="text-[10px] font-black text-rose-600 uppercase tracking-widest">Universal Security Lock</span>
                                        </div>
                                        <select
                                            value={col.lockLevel}
                                            onChange={(e) => handleColumnChange(col.id, 'lockLevel', e.target.value)}
                                            className="w-full bg-white border border-rose-200 rounded py-1.5 px-2 text-[10px] font-bold text-slate-700 outline-none cursor-pointer"
                                        >
                                            <option value="immutable">IMMUTABLE (API Blocks both INSERT & UPDATE)</option>
                                            <option value="insert_only">INSERT ONLY (API Blocks UPDATE)</option>
                                            <option value="service_role_only">SERVICE ROLE ONLY (API Blocks Anon & Authenticated users)</option>
                                            <option value="otp_protected">OTP PROTECTED (API Blocks UPDATE unless step-up challenge is provided)</option>
                                        </select>
                                    </div>
                                )}

                                {/* FK Editor Popover — with Schema Selector */}
                                {activeFkEditor === col.id && (
                                    <div data-fk-editor onClick={(e: any) => e.stopPropagation()} className="absolute z-50 top-full right-0 mt-2 w-72 bg-white border border-slate-200 shadow-xl rounded-xl p-4 animate-in fade-in zoom-in-95">
                                        <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Link to Table</h4>
                                        <div className="space-y-3">
                                            {/* Schema Selector */}
                                            <div className="space-y-1">
                                                <label className="text-[9px] font-black text-blue-400 uppercase tracking-widest ml-0.5">Schema</label>
                                                <select
                                                    value={col.foreignKey?.schema || activeSchema}
                                                    onChange={async (e: any) => {
                                                        const newSchema = e.target.value;
                                                        // Update FK schema and clear table/column
                                                        setColumns(prev => prev.map(c =>
                                                            c.id === col.id ? { ...c, foreignKey: { schema: newSchema, table: '', column: '' }, isArray: false } : c
                                                        ));
                                                        // Load tables for the selected schema
                                                        await loadFkTablesForSchema(newSchema);
                                                        setFkTargetColumns([]);
                                                    }}
                                                    className="w-full bg-slate-50 border border-slate-200 rounded-lg py-2 px-3 text-xs font-bold text-slate-700 outline-none"
                                                >
                                                    {schemas.map(s => (
                                                        <option key={s} value={s}>{s}</option>
                                                    ))}
                                                </select>
                                            </div>

                                            {/* Table Selector */}
                                            <div className="space-y-1">
                                                <label className="text-[9px] font-black text-blue-400 uppercase tracking-widest ml-0.5">Table</label>
                                                <select
                                                    value={col.foreignKey?.table || ''}
                                                    onChange={(e: any) => {
                                                        const fkSchema = col.foreignKey?.schema || activeSchema;
                                                        handleSetForeignKey(col.id, fkSchema, e.target.value, '');
                                                    }}
                                                    className="w-full bg-slate-50 border border-slate-200 rounded-lg py-2 px-3 text-xs font-bold text-slate-700 outline-none"
                                                >
                                                    <option value="">Select Target Table...</option>
                                                    {fkTargetTables.filter(t => t.name !== tableName).map(t => (
                                                        <option key={t.name} value={t.name}>{t.name}</option>
                                                    ))}
                                                </select>
                                            </div>

                                            {/* Column Selector */}
                                            {col.foreignKey?.table && (
                                                <div className="space-y-1">
                                                    <label className="text-[9px] font-black text-blue-400 uppercase tracking-widest ml-0.5">Column</label>
                                                    {fkLoading
                                                        ? <div className="py-2 flex justify-center"><Loader2 size={12} className="animate-spin text-indigo-500" /></div>
                                                        : (
                                                            <select
                                                                value={col.foreignKey.column}
                                                                onChange={(e: any) => {
                                                                    const fkSchema = col.foreignKey?.schema || activeSchema;
                                                                    handleSetForeignKey(col.id, fkSchema, col.foreignKey!.table, e.target.value);
                                                                }}
                                                                className="w-full bg-slate-50 border-none rounded-lg py-2 px-3 text-xs font-mono font-bold outline-none"
                                                            >
                                                                <option value="">Select Column...</option>
                                                                {fkTargetColumns.map(c => <option key={c} value={c}>{c}</option>)}
                                                            </select>
                                                        )
                                                    }
                                                </div>
                                            )}

                                            <div className="flex justify-between items-center pt-2 border-t border-slate-100">
                                                <button onClick={() => { handleSetForeignKey(col.id, '', '', ''); setActiveFkEditor(null); }} className="text-[10px] font-bold text-rose-500 hover:underline">Remove Link</button>
                                                <button onClick={() => setActiveFkEditor(null)} className="px-3 py-1.5 bg-indigo-600 text-white text-[10px] font-black rounded-lg hover:bg-indigo-700 transition-colors">OK</button>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>

                    {/* Add Column Button */}
                    <button
                        onClick={handleAddColumn}
                        className="w-full py-3 border border-dashed border-slate-300 rounded-xl text-slate-400 text-xs font-bold hover:bg-slate-50 hover:text-indigo-600 hover:border-indigo-300 transition-all flex items-center justify-center gap-2"
                    >
                        <Plus size={14} /> Add Column
                    </button>
                </div>

                {/* RLS Toggle */}
                <div className="flex items-center justify-between bg-slate-50 p-4 rounded-xl border border-slate-200">
                    <div className="flex items-center gap-3">
                        {enableRLS
                            ? <Shield size={18} className="text-emerald-600" />
                            : <ShieldOff size={18} className="text-slate-400" />
                        }
                        <div>
                            <span className="text-xs font-bold text-slate-700 block">Row Level Security</span>
                            <span className="text-[10px] text-slate-400 font-medium">{enableRLS ? 'Enabled — recommended for multi-tenant' : 'Disabled — open access'}</span>
                        </div>
                    </div>
                    <button
                        onClick={() => setEnableRLS(!enableRLS)}
                        className={`w-12 h-7 rounded-full p-1 transition-colors ${enableRLS ? 'bg-emerald-600' : 'bg-slate-200'}`}
                    >
                        <div className={`w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${enableRLS ? 'translate-x-5' : ''}`}></div>
                    </button>
                </div>

                {/* MCP Access Card */}
                {mcpEnabled && (
                    <div className="bg-slate-900 p-4 rounded-xl border border-slate-700">
                        <div className="flex items-center gap-3 mb-3">
                            <div className="w-8 h-8 bg-emerald-500 rounded-lg flex items-center justify-center shadow-lg shadow-emerald-500/30">
                                <Cpu size={16} className="text-white" />
                            </div>
                            <div>
                                <span className="text-xs font-bold text-white block">MCP Access (AI Agents)</span>
                                <span className="text-[10px] text-slate-400 font-medium">Permissions for Cursor, Windsurf, etc.</span>
                            </div>
                        </div>
                        <div className="flex gap-2">
                            {(['r', 'c', 'u', 'd'] as const).map(perm => {
                                const labels = { r: 'READ', c: 'CREATE', u: 'UPDATE', d: 'DELETE' };
                                const colors = {
                                    r: mcpPerms[perm] ? 'bg-blue-500 text-white border-blue-400' : 'bg-slate-800 text-slate-500 border-slate-600',
                                    c: mcpPerms[perm] ? 'bg-emerald-500 text-white border-emerald-400' : 'bg-slate-800 text-slate-500 border-slate-600',
                                    u: mcpPerms[perm] ? 'bg-amber-500 text-white border-amber-400' : 'bg-slate-800 text-slate-500 border-slate-600',
                                    d: mcpPerms[perm] ? 'bg-rose-500 text-white border-rose-400' : 'bg-slate-800 text-slate-500 border-slate-600',
                                };
                                return (
                                    <button
                                        key={perm}
                                        onClick={() => setMcpPerms((prev: any) => ({ ...prev, [perm]: !prev[perm] }))}
                                        className={`flex-1 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest border transition-all ${colors[perm]}`}
                                    >
                                        {labels[perm]}
                                    </button>
                                );
                            })}
                        </div>
                        {mcpPerms.d && (
                            <p className="text-[9px] text-rose-400 font-bold mt-2 text-center animate-pulse">
                                ⚠ DELETE enabled — AI agents will be able to delete rows
                            </p>
                        )}
                    </div>
                )}
            </div>

            {/* Footer */}
            <div className="p-6 border-t border-slate-100 bg-slate-50/50 space-y-3">
                <div className="flex gap-4">
                    <button onClick={onClose} className="flex-1 py-3 text-xs font-black text-slate-400 uppercase tracking-widest hover:text-slate-600">Cancel</button>
                    <button
                        onClick={generateSQL}
                        disabled={!canGenerate}
                        className="flex-[2] bg-indigo-600 text-white py-3 rounded-xl text-xs font-black uppercase tracking-widest shadow-xl hover:bg-indigo-700 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        Generate & Execute SQL
                    </button>
                </div>
                <div className="flex items-center justify-center gap-4 text-[9px] font-bold text-slate-400">
                    <span className="flex items-center gap-1"><kbd className="px-1.5 py-0.5 bg-slate-200 rounded text-[8px] font-black text-slate-500">Ctrl+Enter</kbd> Execute</span>
                    <span className="text-slate-200">·</span>
                    <span className="flex items-center gap-1"><kbd className="px-1.5 py-0.5 bg-slate-200 rounded text-[8px] font-black text-slate-500">Ctrl+S</kbd> Save to Editor</span>
                </div>
            </div>

            {/* Validation hint */}
            {hasEmptyColumn && tableName && (
                <div className="px-6 pb-4 -mt-2">
                    <p className="text-[10px] font-bold text-amber-600 text-center">⚠ All columns must have a name</p>
                </div>
            )}
        </div>
    );
};

export default TableCreatorDrawer;
