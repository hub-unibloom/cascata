
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { X, Plus, Loader2, Link as LinkIcon, Shield, ShieldOff, Regex } from 'lucide-react';

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
    foreignKey?: { table: string; column: string };
    sourceHeader?: string;
    description?: string;
    formatPreset?: string;
    formatPattern?: string;
}

// Format presets for column validation (mirrored from backend)
// NOTE: This map is also used by the "Add Column" modal in DatabaseExplorer.tsx
// and enforced server-side in DataController.ts insertRows/updateRows.
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
    activeSchema: string;
    projectId: string;
    fetchWithAuth: (url: string, options?: any) => Promise<any>;
    onSqlGenerated: (sql: string) => void;
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

// Expanded default suggestions per type
const getDefaultSuggestions = (type: string): string[] => {
    const t = type.toLowerCase();
    if (t === 'uuid') return ['gen_random_uuid()'];
    if (t.includes('timestamp') || t === 'date') return ['now()', 'current_timestamp', 'current_date', "timezone('utc', now())"];
    if (t === 'time') return ['current_time', 'localtime'];
    if (t.includes('bool')) return ['true', 'false'];
    if (t.includes('int') || t.includes('numeric') || t.includes('float')) return ['0', '1'];
    if (t.includes('json')) return ["'{}'::jsonb", "'[]'::jsonb", "'null'::jsonb"];
    if (t === 'text' || t === 'varchar') return ["''"];
    if (t === 'bytea') return ["'\\x'::bytea"];
    return [];
};

// Smart quoting: wraps raw text defaults in single quotes,
// leaves functions, numbers, booleans, casts, and already-quoted values bare.
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
];

const formatDefaultValue = (type: string, raw: string): string => {
    const v = raw.trim();
    if (!v) return '';
    // Already single-quoted → pass through
    if (v.startsWith("'") && v.endsWith("'")) return v;
    // Type casts (e.g. '{}'::jsonb) → pass through
    if (v.includes('::')) return v;
    // Known SQL functions/keywords → bare
    if (BARE_PATTERNS.some(p => p.test(v))) return v;
    // Contains parens (function call) → bare
    if (v.includes('(') && v.includes(')')) return v;
    // Numeric types + valid number → bare
    const tn = type.toLowerCase();
    if (/^(int|float|numeric|real|double|serial|bigserial)/.test(tn) && !isNaN(Number(v))) return v;
    // Boolean types + bool value → bare
    if (/bool/.test(tn) && ['true', 'false'].includes(v.toLowerCase())) return v;
    // Everything else = string literal → wrap in single quotes
    return `'${v.replace(/'/g, "''")}'`;
};

const DEFAULT_COLUMNS: ColumnDef[] = [
    { id: '1', name: 'id', type: 'uuid', defaultValue: 'gen_random_uuid()', isPrimaryKey: true, isNullable: false, isUnique: true, isArray: false },
    { id: '2', name: 'created_at', type: 'timestamptz', defaultValue: 'now()', isPrimaryKey: false, isNullable: false, isUnique: false, isArray: false },
];

const TableCreatorDrawer: React.FC<TableCreatorDrawerProps> = ({
    isOpen,
    onClose,
    tables,
    activeSchema,
    projectId,
    fetchWithAuth,
    onSqlGenerated,
    initialTableName = '',
    initialColumns,
}) => {
    const [tableName, setTableName] = useState(initialTableName);
    const [tableDesc, setTableDesc] = useState('');
    const [columns, setColumns] = useState<ColumnDef[]>(initialColumns || [...DEFAULT_COLUMNS]);
    const [enableRLS, setEnableRLS] = useState(true);
    const [activeFkEditor, setActiveFkEditor] = useState<string | null>(null);
    const [fkTargetColumns, setFkTargetColumns] = useState<string[]>([]);
    const [fkLoading, setFkLoading] = useState(false);

    const scrollRef = useRef<HTMLDivElement>(null);
    const lastAddedIdRef = useRef<string | null>(null);
    const columnInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

    // Validation: all columns must have names
    const hasEmptyColumn = columns.some(c => !c.name.trim());
    const canGenerate = !!tableName && !hasEmptyColumn;

    // Sync initial values when props change
    useEffect(() => {
        if (initialTableName) setTableName(initialTableName);
    }, [initialTableName]);

    useEffect(() => {
        if (initialColumns) setColumns(initialColumns);
    }, [initialColumns]);

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
        setColumns(prev => prev.map(c => c.id === id ? { ...c, [field]: value } : c));
    };

    const handleSetForeignKey = async (id: string, table: string, column: string) => {
        setColumns(prev => prev.map(c =>
            c.id === id ? { ...c, foreignKey: table ? { table, column: column || '' } : undefined } : c
        ));
        if (table) {
            setFkLoading(true);
            try {
                const res = await fetchWithAuth(`/api/data/${projectId}/tables/${table}/columns?schema=${activeSchema}`);
                const cols = res.map((c: any) => c.name);
                setFkTargetColumns(cols);
                const defaultCol = cols.includes('id') ? 'id' : cols[0] || '';
                setColumns(prev => prev.map(c =>
                    c.id === id ? { ...c, foreignKey: { table, column: defaultCol } } : c
                ));
            } catch (e) { /* ignore */ }
            finally { setFkLoading(false); }
        }
    };

    // --- Enterprise SQL Generator ---
    const generateSQL = useCallback(() => {
        if (!canGenerate) return;
        const safeName = sanitizeName(tableName);
        const schema = activeSchema || 'public';

        // Determine max column name length for alignment
        const colNames = columns.map(c => sanitizeName(c.name || 'unnamed'));
        const maxNameLen = Math.max(...colNames.map(n => n.length), 10);

        // Build column definitions
        const colDefs = columns.map((c) => {
            const name = sanitizeName(c.name || 'unnamed');
            const paddedName = name.padEnd(maxNameLen);
            const type = c.isArray ? `${c.type}[]` : c.type;

            let constraints: string[] = [];

            if (c.isPrimaryKey) constraints.push('PRIMARY KEY');
            if (!c.isNullable && !c.isPrimaryKey) constraints.push('NOT NULL');
            if (c.isUnique && !c.isPrimaryKey) constraints.push('UNIQUE');

            // Smart quoting for DEFAULT values
            if (c.defaultValue && c.defaultValue.trim()) {
                const formatted = formatDefaultValue(c.type, c.defaultValue);
                constraints.push(`DEFAULT ${formatted}`);
            }

            // Foreign key constraint
            if (c.foreignKey && c.foreignKey.table && c.foreignKey.column) {
                const fkTable = sanitizeName(c.foreignKey.table);
                const fkCol = sanitizeName(c.foreignKey.column);
                constraints.push(`REFERENCES ${schema}.${fkTable}(${fkCol})`);
            }

            const constraintStr = constraints.length > 0 ? ' ' + constraints.join(' ') : '';
            return `    ${paddedName} ${type}${constraintStr}`;
        });

        // Build complete SQL
        const lines: string[] = [];
        lines.push(`-- Create table: ${safeName}`);
        lines.push(`CREATE TABLE IF NOT EXISTS ${schema}.${safeName} (`);
        lines.push(colDefs.join(',\n'));
        lines.push(`);`);

        // Table comment (if provided)
        if (tableDesc.trim()) {
            lines.push('');
            lines.push(`COMMENT ON TABLE ${schema}.${safeName} IS '${tableDesc.replace(/'/g, "''").trim()}';`);
        }

        // RLS (optional)
        if (enableRLS) {
            lines.push('');
            lines.push(`-- Enable Row Level Security`);
            lines.push(`ALTER TABLE ${schema}.${safeName} ENABLE ROW LEVEL SECURITY;`);
        }

        // Column comments (descriptions + format patterns)
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

        const sql = lines.join('\n');
        onSqlGenerated(sql);
        onClose();
    }, [tableName, tableDesc, columns, enableRLS, activeSchema, onSqlGenerated, onClose, canGenerate]);

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
                                        onChange={(e: any) => handleColumnChange(col.id, 'type', e.target.value)}
                                        className="flex-1 bg-slate-100 border-none rounded-lg px-2 py-2 text-[10px] font-black uppercase text-slate-600 outline-none cursor-pointer"
                                    >
                                        <optgroup label="Numbers"><option value="int8">int8 (BigInt)</option><option value="int4">int4 (Integer)</option><option value="numeric">numeric</option><option value="float8">float8</option></optgroup>
                                        <optgroup label="Text"><option value="text">text</option><option value="varchar">varchar</option><option value="uuid">uuid</option></optgroup>
                                        <optgroup label="Date/Time"><option value="timestamptz">timestamptz</option><option value="date">date</option><option value="time">time</option></optgroup>
                                        <optgroup label="JSON"><option value="jsonb">jsonb</option><option value="json">json</option></optgroup>
                                        <optgroup label="Other"><option value="bool">boolean</option><option value="bytea">bytea</option><option value="vector">vector (Embedding)</option></optgroup>
                                    </select>
                                    <button onClick={() => handleRemoveColumn(col.id)} className="p-2 text-slate-300 hover:text-rose-500 transition-colors"><X size={14} /></button>
                                </div>

                                {/* Default Value + Constraint Toggles */}
                                <div className="flex items-center gap-3 bg-slate-50 p-2 rounded-lg relative">
                                    <input
                                        list={`defaults-${col.id}`}
                                        value={col.defaultValue}
                                        onChange={(e: any) => handleColumnChange(col.id, 'defaultValue', e.target.value)}
                                        placeholder="Default Value (NULL)"
                                        className="flex-1 bg-transparent border-none text-[10px] font-mono text-slate-600 outline-none placeholder:text-slate-300"
                                    />
                                    <datalist id={`defaults-${col.id}`}>
                                        {getDefaultSuggestions(col.type).map(s => <option key={s} value={s} />)}
                                    </datalist>
                                    <div className="h-4 w-[1px] bg-slate-200"></div>
                                    <div className="flex items-center gap-2">
                                        <div title="Primary Key" onClick={() => handleColumnChange(col.id, 'isPrimaryKey', !col.isPrimaryKey)} className={`px-1.5 py-1 rounded text-[9px] font-black cursor-pointer select-none transition-colors ${col.isPrimaryKey ? 'bg-amber-100 text-amber-700' : 'text-slate-300 hover:bg-slate-200'}`}>PK</div>
                                        <div title="Foreign Key" onClick={(e: any) => { e.stopPropagation(); setActiveFkEditor(activeFkEditor === col.id ? null : col.id); }} className={`px-1.5 py-1 rounded cursor-pointer select-none transition-colors flex items-center ${col.foreignKey ? 'bg-blue-100 text-blue-700' : 'text-slate-300 hover:bg-slate-200'}`}><LinkIcon size={12} strokeWidth={4} /></div>
                                        <div title="Array" onClick={() => handleColumnChange(col.id, 'isArray', !col.isArray)} className={`px-1.5 py-1 rounded text-[9px] font-black cursor-pointer select-none transition-colors ${col.isArray ? 'bg-indigo-100 text-indigo-700' : 'text-slate-300 hover:bg-slate-200'}`}>LIST</div>
                                        <div title="Nullable" onClick={() => handleColumnChange(col.id, 'isNullable', !col.isNullable)} className={`px-1.5 py-1 rounded text-[9px] font-black cursor-pointer select-none transition-colors ${col.isNullable ? 'bg-emerald-100 text-emerald-700' : 'text-slate-300 hover:bg-slate-200'}`}>NULL</div>
                                        <div title="Unique" onClick={() => handleColumnChange(col.id, 'isUnique', !col.isUnique)} className={`px-1.5 py-1 rounded text-[9px] font-black cursor-pointer select-none transition-colors ${col.isUnique ? 'bg-purple-100 text-purple-700' : 'text-slate-300 hover:bg-slate-200'}`}>UNIQ</div>
                                        {(col.type === 'text' || col.type === 'varchar') && (
                                            <div title="Format Validation" onClick={() => handleColumnChange(col.id, 'formatPreset', col.formatPreset ? undefined : 'email')} className={`px-1.5 py-1 rounded cursor-pointer select-none transition-colors flex items-center gap-0.5 ${col.formatPreset || col.formatPattern ? 'bg-amber-100 text-amber-700' : 'text-slate-300 hover:bg-slate-200'}`}><Regex size={10} strokeWidth={3} /></div>
                                        )}
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

                                {/* FK Editor Popover */}
                                {activeFkEditor === col.id && (
                                    <div data-fk-editor onClick={(e: any) => e.stopPropagation()} className="absolute z-50 top-full right-0 mt-2 w-64 bg-white border border-slate-200 shadow-xl rounded-xl p-4 animate-in fade-in zoom-in-95">
                                        <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Link to Table</h4>
                                        <div className="space-y-3">
                                            <select
                                                value={col.foreignKey?.table || ''}
                                                onChange={(e: any) => handleSetForeignKey(col.id, e.target.value, '')}
                                                className="w-full bg-slate-50 border border-slate-200 rounded-lg py-2 px-3 text-xs font-bold text-slate-700 outline-none"
                                            >
                                                <option value="">Select Target Table...</option>
                                                {tables.filter(t => t.name !== tableName).map(t => (
                                                    <option key={t.name} value={t.name}>{t.name}</option>
                                                ))}
                                            </select>
                                            {col.foreignKey?.table && (
                                                <div className="flex items-center gap-2">
                                                    <span className="text-xs text-slate-400">Column:</span>
                                                    {fkLoading
                                                        ? <Loader2 size={12} className="animate-spin text-indigo-500" />
                                                        : (
                                                            <select
                                                                value={col.foreignKey.column}
                                                                onChange={(e: any) => handleSetForeignKey(col.id, col.foreignKey!.table, e.target.value)}
                                                                className="flex-1 bg-slate-50 border-none rounded-lg py-1 px-2 text-xs font-mono font-bold outline-none"
                                                            >
                                                                <option value="">Select Column...</option>
                                                                {fkTargetColumns.map(c => <option key={c} value={c}>{c}</option>)}
                                                            </select>
                                                        )
                                                    }
                                                </div>
                                            )}
                                            <div className="flex justify-between items-center pt-2 border-t border-slate-100">
                                                <button onClick={() => { handleSetForeignKey(col.id, '', ''); setActiveFkEditor(null); }} className="text-[10px] font-bold text-rose-500 hover:underline">Remove Link</button>
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
            </div>

            {/* Footer */}
            <div className="p-6 border-t border-slate-100 bg-slate-50/50 flex gap-4">
                <button onClick={onClose} className="flex-1 py-3 text-xs font-black text-slate-400 uppercase tracking-widest hover:text-slate-600">Cancel</button>
                <button
                    onClick={generateSQL}
                    disabled={!canGenerate}
                    className="flex-[2] bg-indigo-600 text-white py-3 rounded-xl text-xs font-black uppercase tracking-widest shadow-xl hover:bg-indigo-700 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    Generate & Execute SQL
                </button>
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
