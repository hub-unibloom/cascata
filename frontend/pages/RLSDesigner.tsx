
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { 
  Shield, Play, Plus, X, Save, ArrowLeft, Loader2, 
  User, Database, Lock, Eye, CheckCircle2, GripVertical, 
  Trash2, Copy, GitBranch, Zap, Box, Key, AlignLeft, MousePointer2,
  ChevronDown, ShieldCheck, Link as LinkIcon, Layers, Workflow,
  FileJson, BookOpen, AlertTriangle, ArrowRight, CheckSquare, Sparkles, 
  Bot, Wand2, Terminal, Activity, Search, RefreshCw, Hammer,
  Network, Cpu, Scale, Stethoscope, Microscope, Split, Info, History,
  GitCommit, Gauge, Scale as ScaleIcon, Fingerprint, RefreshCcw,
  Undo2, Redo2, ScanEye, LayoutList, MoreHorizontal, AtSign, Columns
} from 'lucide-react';

interface RLSDesignerProps {
  projectId: string;
  entityType: 'table' | 'bucket';
  entityName: string;
  onBack: () => void;
}

// --- CORE TYPES & INTERFACES ---

type LogicOperator = 'AND' | 'OR';
type Comparator = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'IN' | 'IS' | 'LIKE' | 'ILIKE';

interface ForeignKeyDefinition {
  constraint_name: string;
  table_name: string; // Source Table
  column_name: string; // Source Column
  foreign_table_name: string; // Target Table
  foreign_column_name: string; // Target Column
}

interface ColumnDefinition {
  name: string;
  type: string;
  isIndex: boolean;
  isPrimaryKey: boolean;
  isNullable: boolean;
  isUnique: boolean;
}

interface LogicNode {
  id: string;
  type: 'group' | 'condition' | 'relation';
  operator?: LogicOperator;
  children?: LogicNode[];
  field?: string;
  comparator?: Comparator;
  value?: string;
  valueType?: 'static' | 'dynamic' | 'auth' | 'sql_expression';
  relationTable?: string;
  relationLocalKey?: string;
  relationForeignKey?: string;
  relationAlias?: string;
  isCollapsed?: boolean;
}

interface SecurityAudit {
  score: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  issues: { severity: 'info' | 'warning' | 'critical', message: string, suggestion?: string }[];
  performanceTips: string[];
  compliance: { lgpd: boolean; gdpr: boolean; fields: string[] };
}

interface SimulationResult {
  success: boolean;
  cost?: number;
  rows?: number;
  time?: number;
  planNodes?: any;
  error?: string;
  rawPlan?: string;
}

interface PolicyVersion {
  id: string;
  timestamp: Date;
  logic: LogicNode;
  sql: string;
  score: number;
  name: string;
}

// --- UTILS ---
const getUUID = () => Math.random().toString(36).substring(2, 15);

const cleanTree = (node: LogicNode): LogicNode => {
    const { isCollapsed, ...rest } = node;
    if (rest.children) rest.children = rest.children.map(cleanTree);
    return rest as LogicNode;
};

const RLSDesigner: React.FC<RLSDesignerProps> = ({ projectId, entityType, entityName, onBack }) => {
  
  // --- STATE: SCHEMA INTELLIGENCE ---
  const [columns, setColumns] = useState<ColumnDefinition[]>([]);
  const [schemaGraph, setSchemaGraph] = useState<ForeignKeyDefinition[]>([]);
  const [allTables, setAllTables] = useState<string[]>([]);
  const [dbUsers, setDbUsers] = useState<any[]>([]);
  const [existingPolicies, setExistingPolicies] = useState<any[]>([]);
  
  // --- STATE: MENTIONS & CONTEXT ---
  const [mentionedTables, setMentionedTables] = useState<Set<string>>(new Set());
  const [externalColumns, setExternalColumns] = useState<Record<string, ColumnDefinition[]>>({});
  
  // --- STATE: POLICY DEFINITION ---
  const [policyName, setPolicyName] = useState('');
  const [command, setCommand] = useState('SELECT');
  const [role, setRole] = useState('authenticated');
  const [logicTree, setLogicTree] = useState<LogicNode>({ 
      id: 'root', type: 'group', operator: 'AND', children: [] 
  });

  // --- STATE: UI & CONTROL ---
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'visual' | 'sql' | 'simulator' | 'topology' | 'history'>('visual');
  const [activePanel, setActivePanel] = useState<'audit' | 'simulate'>('audit');
  
  // --- STATE: AI COPILOT & SUGGESTIONS ---
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [suggestionBox, setSuggestionBox] = useState<{ visible: boolean, type: 'table' | 'column', query: string, triggerIdx: number } | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement>(null);

  // --- STATE: INTELLIGENCE ENGINE ---
  const [simUser, setSimUser] = useState<string>(''); 
  const [simResult, setSimResult] = useState<SimulationResult | null>(null);
  const [simLoading, setSimLoading] = useState(false);
  const [auditData, setAuditData] = useState<SecurityAudit>({ score: 100, riskLevel: 'LOW', issues: [], performanceTips: [], compliance: { lgpd: false, gdpr: false, fields: [] } });
  const [sqlPreview, setSqlPreview] = useState('');
  
  // --- STATE: TIME TRAVEL ---
  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // --- INITIALIZATION ---
  const fetchDeepSchema = async () => {
    setLoading(true);
    const token = localStorage.getItem('cascata_token');
    try {
        const colsRes = await fetch(`/api/data/${projectId}/tables/${entityName}/columns`, { headers: { 'Authorization': `Bearer ${token}` } });
        const colsData = await colsRes.json();
        
        const topologyQuery = `
            SELECT
                tc.constraint_name, tc.table_name, kcu.column_name, 
                ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name 
            FROM information_schema.table_constraints AS tc 
            JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name
            JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
            WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public';
        `;
        const topRes = await fetch(`/api/data/${projectId}/query`, { 
            method: 'POST', 
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ sql: topologyQuery })
        });
        const topData = await topRes.json();

        // Fetch All Table Names for the @ autocomplete
        const allTablesQuery = `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
        const tablesRes = await fetch(`/api/data/${projectId}/query`, { 
            method: 'POST', 
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ sql: allTablesQuery })
        });
        const tablesData = await tablesRes.json();

        const policiesRes = await fetch(`/api/data/${projectId}/policies`, { headers: { 'Authorization': `Bearer ${token}` } });
        const policiesData = await policiesRes.json();
        const myPolicies = policiesData.filter((p: any) => p.tablename === entityName);

        const usersRes = await fetch(`/api/data/${projectId}/auth/users?limit=10`, { headers: { 'Authorization': `Bearer ${token}` } });
        const usersData = await usersRes.json();
        const usersList = Array.isArray(usersData) ? usersData : (usersData.data || []);

        setColumns(colsData.map((c: any) => ({ 
            name: c.name, type: c.type, isIndex: c.isPrimaryKey || c.name.endsWith('_id'), 
            isPrimaryKey: c.isPrimaryKey, isNullable: c.isNullable, isUnique: false 
        })));
        
        setSchemaGraph(topData.rows || []);
        
        const tList = (tablesData.rows || []).map((r: any) => r.table_name);
        setAllTables(tList);

        setExistingPolicies(myPolicies);
        setDbUsers(usersList);
        if (usersList.length > 0) setSimUser(usersList[0].id);

        saveSnapshot({ id: 'root', type: 'group', operator: 'AND', children: [] }, '', 100);

    } catch (e) { 
        console.error("Critical Schema Load Failure", e);
        setDeployError("Failed to load database topology.");
    } finally { 
        setLoading(false); 
    }
  };

  useEffect(() => { fetchDeepSchema(); }, [projectId, entityName]);

  // --- MENTION SYSTEM LOGIC ---
  const fetchExternalColumns = async (tableName: string) => {
      if (externalColumns[tableName]) return; // Already cached
      try {
          const token = localStorage.getItem('cascata_token');
          const res = await fetch(`/api/data/${projectId}/tables/${tableName}/columns`, { headers: { 'Authorization': `Bearer ${token}` } });
          const data = await res.json();
          setExternalColumns(prev => ({
              ...prev,
              [tableName]: data.map((c: any) => ({ name: c.name, type: c.type }))
          }));
      } catch (e) { console.error("Failed to fetch ext columns", e); }
  };

  const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      setAiPrompt(val);

      const cursor = e.target.selectionStart;
      const textBeforeCursor = val.slice(0, cursor);
      const words = textBeforeCursor.split(/\s+/);
      const lastWord = words[words.length - 1];

      if (lastWord.startsWith('@')) {
          setSuggestionBox({ visible: true, type: 'table', query: lastWord.slice(1), triggerIdx: cursor - lastWord.length });
      } else if (lastWord.startsWith('/')) {
          setSuggestionBox({ visible: true, type: 'column', query: lastWord.slice(1), triggerIdx: cursor - lastWord.length });
      } else {
          setSuggestionBox(null);
      }
  };

  const handleSelectSuggestion = (value: string, type: 'table' | 'column') => {
      if (!suggestionBox) return;
      
      const before = aiPrompt.slice(0, suggestionBox.triggerIdx);
      const after = aiPrompt.slice(promptInputRef.current?.selectionStart || 0);
      const newValue = before + (type === 'table' ? '@' : '/') + value + ' ' + after;
      
      setAiPrompt(newValue);
      
      if (type === 'table') {
          const newSet = new Set(mentionedTables);
          newSet.add(value);
          setMentionedTables(newSet);
          fetchExternalColumns(value); // Lazy load metadata
      }
      
      setSuggestionBox(null);
      setTimeout(() => promptInputRef.current?.focus(), 50);
  };

  // --- ENGINE: SQL COMPILER (Recursive Tree -> SQL) ---
  const compileNode = useCallback((node: LogicNode, depth: number = 0): string => {
      if (node.type === 'group') {
          if (!node.children || node.children.length === 0) return '';
          const parts = node.children.map(c => compileNode(c, depth + 1)).filter(Boolean);
          if (parts.length === 0) return '';
          const joined = parts.join(` ${node.operator} `);
          return depth === 0 ? joined : `(${joined})`;
      } 
      
      if (node.type === 'relation') {
          if (!node.relationTable || !node.children || node.children.length === 0) return '';
          const innerLogic = compileNode({ id: 'temp', type: 'group', operator: 'AND', children: node.children }, depth + 1);
          if (!innerLogic) return '';
          return `EXISTS (
            SELECT 1 FROM public."${node.relationTable}" 
            WHERE public."${node.relationTable}"."${node.relationForeignKey}" = "${entityName}"."${node.relationLocalKey}" 
            AND ${innerLogic}
          )`;
      }

      if (node.type === 'condition') {
          if (node.field === 'true') return 'true';
          if (!node.field) return '';
          let val = node.value;
          if (node.valueType === 'static') {
              if (val === 'null') return `"${node.field}" IS NULL`;
              const isNum = !isNaN(Number(val)) && val !== '';
              const isBool = val === 'true' || val === 'false';
              if (!isNum && !isBool && val !== 'null') {
                  val = `'${val?.replace(/'/g, "''")}'`;
              }
          } else if (node.valueType === 'auth') {
              if (!val?.startsWith('auth.')) val = 'auth.uid()'; 
          }
          return `"${node.field}" ${node.comparator} ${val}`;
      }
      return '';
  }, [entityName]);

  // --- ENGINE: SECURITY AUDITOR 2.0 ---
  useEffect(() => {
      const sql = compileNode(logicTree) || 'false';
      setSqlPreview(sql);

      const audit: SecurityAudit = {
          score: 100, riskLevel: 'LOW', issues: [], performanceTips: [], compliance: { lgpd: false, gdpr: false, fields: [] }
      };

      const conflicting = existingPolicies.find(p => p.cmd === command && (p.roles.includes(role) || p.roles.includes('public')) && p.qual === 'true');
      if (conflicting) {
          audit.score -= 40;
          audit.issues.push({ severity: 'critical', message: `Conflict: Policy "${conflicting.policyname}" already allows ALL access.` });
      }

      if (sql.includes('true') && sql.length < 10) {
          audit.score -= 60;
          audit.riskLevel = 'CRITICAL';
          audit.issues.push({ severity: 'critical', message: 'Logic evaluates to TRUE (Public Access).' });
      }
      if (role === 'authenticated' && !sql.includes('auth.uid()') && !sql.includes('auth.email()')) {
          audit.score -= 20;
          audit.issues.push({ severity: 'warning', message: 'No ownership check (auth.uid) for authenticated users.' });
      }

      const piiFields = ['email', 'cpf', 'cnpj', 'phone', 'address', 'password', 'birth'];
      const foundPii = columns.filter(c => piiFields.some(pii => c.name.toLowerCase().includes(pii))).map(c => c.name);
      if (foundPii.length > 0) {
          audit.compliance.lgpd = true;
          audit.compliance.fields = foundPii;
          audit.issues.push({ severity: 'info', message: `Sensitive Data: ${foundPii.length} PII columns detected.` });
      }

      setAuditData(audit);
  }, [logicTree, role, command, columns, existingPolicies, compileNode]);

  // --- ENGINE: TIME TRAVEL ---
  const saveSnapshot = (tree: LogicNode, sql: string, score: number) => {
      const ver: PolicyVersion = {
          id: getUUID(), timestamp: new Date(), logic: JSON.parse(JSON.stringify(tree)), sql, score, name: policyName || 'Draft'
      };
      const newHistory = versions.slice(0, historyIndex + 1);
      newHistory.push(ver);
      if (newHistory.length > 20) newHistory.shift();
      setVersions(newHistory);
      setHistoryIndex(newHistory.length - 1);
  };

  const handleUndo = () => { if (historyIndex > 0) { const prev = versions[historyIndex - 1]; setLogicTree(prev.logic); setPolicyName(prev.name); setHistoryIndex(historyIndex - 1); } };
  const handleRedo = () => { if (historyIndex < versions.length - 1) { const next = versions[historyIndex + 1]; setLogicTree(next.logic); setPolicyName(next.name); setHistoryIndex(historyIndex + 1); } };
  const updateTree = (newTree: LogicNode) => { setLogicTree(newTree); saveSnapshot(newTree, compileNode(newTree), auditData.score); };

  // --- ACTIONS ---
  const handleSimulate = async () => {
      if (!simUser) { alert("Select a user to simulate."); return; }
      setSimLoading(true); setSimResult(null);
      try {
          const simulationQuery = `
            BEGIN;
            SELECT set_config('request.jwt.claim.sub', '${simUser}', true);
            SELECT set_config('request.jwt.claim.role', '${role}', true);
            EXPLAIN (FORMAT JSON, ANALYZE) SELECT count(*) FROM public."${entityName}" WHERE ${sqlPreview};
            ROLLBACK;
          `;
          const res = await fetch(`/api/data/${projectId}/query`, {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
              body: JSON.stringify({ sql: simulationQuery })
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          
          let planRow = data.rows?.[0];
          if (planRow) {
              const plan = planRow['QUERY PLAN'][0];
              setSimResult({ success: true, cost: plan.Plan['Total Cost'], rows: plan.Plan['Actual Rows'], time: plan['Execution Time'], planNodes: plan.Plan, rawPlan: JSON.stringify(plan, null, 2) });
          } else { setSimResult({ success: true, rows: 0, time: 0, cost: 0, error: 'Could not parse Explain Plan' }); }
      } catch (e: any) { setSimResult({ success: false, error: e.message }); } finally { setSimLoading(false); }
  };

  const handleDeploy = async () => {
      if (!policyName) { alert("Policy Name is required."); return; }
      setSaving(true);
      setDeployError(null);
      try {
          const sql = `
            ALTER TABLE public."${entityName}" ENABLE ROW LEVEL SECURITY;
            DROP POLICY IF EXISTS "${policyName}" ON public."${entityName}";
            CREATE POLICY "${policyName}" ON public."${entityName}" FOR ${command} TO ${role} USING (${sqlPreview}) ${['INSERT', 'UPDATE', 'ALL'].includes(command) ? `WITH CHECK (${sqlPreview})` : ''};
          `;
          const res = await fetch(`/api/data/${projectId}/query`, {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
              body: JSON.stringify({ sql })
          });
          
          const data = await res.json();
          if (!res.ok) {
              // Critical Fix: Capture DB Error
              throw new Error(data.error || "Database rejected policy.");
          }
          
          saveSnapshot(logicTree, sqlPreview, auditData.score);
          onBack();
      } catch (e: any) { 
          setDeployError(e.message); 
      } finally { 
          setSaving(false); 
      }
  };

  // --- AI PATHFINDER V3 (CONTEXT AWARE) ---
  const handleAiGenerate = async () => {
      if (!aiPrompt) return;
      setAiLoading(true);
      try {
          // FILTERED CONTEXT GENERATION
          const relevantTables = Array.from(mentionedTables).concat(entityName);
          
          // 1. Filter Topology: Only edges connecting relevant tables
          const relevantTopology = schemaGraph.filter(fk => 
              relevantTables.includes(fk.table_name) || relevantTables.includes(fk.foreign_table_name)
          ).map(fk => `${fk.table_name}.${fk.column_name} -> ${fk.foreign_table_name}.${fk.foreign_column_name}`);

          // 2. Filter Columns: Current Entity + Mentioned Tables
          const contextColumns: Record<string, string[]> = {
              [entityName]: columns.map(c => `${c.name} (${c.type})`)
          };
          for (const tbl of mentionedTables) {
              if (externalColumns[tbl]) {
                  contextColumns[tbl] = externalColumns[tbl].map(c => `${c.name} (${c.type})`);
              }
          }

          const context = { targetTable: entityName, columns: contextColumns, topology: relevantTopology, userRequest: aiPrompt };
          
          const systemPrompt = `
            You are 'Cascata Guardian'. Convert the user's rule into a strict JSON object.
            
            Context: ${JSON.stringify(context, null, 2)}

            Output Format (STRICT JSON):
            {
              "policyName": "string", "command": "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "ALL", "role": "authenticated" | "anon" | "service_role",
              "tree": {
                 "type": "group" | "condition" | "relation",
                 "operator": "AND" | "OR", "children": [],
                 "field": "string", "comparator": "=" | "!=" | ">" | "<" | "IN" | "IS", "value": "string", "valueType": "static" | "auth",
                 "relationTable": "string", "relationLocalKey": "string", "relationForeignKey": "string"
              }
            }
            Rules:
            1. Use 'relation' for cross-table. "relationLocalKey" in "${entityName}", "relationForeignKey" in "relationTable".
            2. Use valueType="auth" and value="auth.uid()" for user checks.
          `;

          const res = await fetch(`/api/data/${projectId}/ai/chat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
              body: JSON.stringify({ 
                  messages: [{ role: 'user', content: systemPrompt }],
                  config: { skip_db_context: true } // VITAL: Skip global schema to prevent hallucination
              })
          });
          const data = await res.json();
          let content = data.choices[0].message.content.replace(/```json/g, '').replace(/```/g, '').trim();
          const payload = JSON.parse(content);
          
          const hydrate = (node: any): LogicNode => {
              return {
                  id: getUUID(),
                  type: node.type || 'group',
                  operator: node.operator || 'AND',
                  children: node.children ? node.children.map(hydrate) : [],
                  field: node.field, comparator: node.comparator || '=', value: node.value, valueType: node.valueType || 'static',
                  relationTable: node.relationTable, relationLocalKey: node.relationLocalKey, relationForeignKey: node.relationForeignKey
              };
          };

          if (payload.tree) {
              updateTree(hydrate(payload.tree));
              if (payload.policyName) setPolicyName(payload.policyName);
              if (payload.command) setCommand(payload.command);
              if (payload.role) setRole(payload.role);
          }
      } catch (e) { alert("AI generation failed."); } 
      finally { setAiLoading(false); }
  };

  return (
    <div className="h-screen flex flex-col bg-[#F8FAFC]">
      {/* HEADER */}
      <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-6 shrink-0 z-30 shadow-sm relative">
        <div className="flex items-center gap-4">
          <button onClick={onBack} className="p-2 hover:bg-slate-100 rounded-lg text-slate-500"><ArrowLeft size={20} /></button>
          <div>
            <h1 className="text-lg font-black text-slate-900 flex items-center gap-2">
              <ShieldCheck size={20} className="text-emerald-500" /> Cascata Guardian <span className="bg-slate-900 text-white px-1.5 py-0.5 rounded text-[9px] uppercase font-black">V7 Smart</span>
            </h1>
            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest flex items-center gap-2">Securing: <span className="text-indigo-600 font-mono bg-indigo-50 px-1.5 rounded">{entityName}</span></p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 mr-4 bg-slate-50 rounded-lg p-1">
              <button onClick={handleUndo} disabled={historyIndex <= 0} className="p-2 hover:bg-white rounded-md disabled:opacity-30"><Undo2 size={16}/></button>
              <button onClick={handleRedo} disabled={historyIndex >= versions.length - 1} className="p-2 hover:bg-white rounded-md disabled:opacity-30"><Redo2 size={16}/></button>
          </div>
          <div className="bg-slate-100 p-1 rounded-lg flex gap-1">
              {['visual', 'sql', 'topology', 'history'].map(t => (
                  <button key={t} onClick={() => setActiveTab(t as any)} className={`px-3 py-1.5 rounded-md text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === t ? 'bg-white shadow text-indigo-600' : 'text-slate-400'}`}>{t}</button>
              ))}
          </div>
          <button onClick={handleDeploy} disabled={saving || !policyName} className="bg-indigo-600 text-white px-5 py-2 rounded-lg font-black text-xs uppercase tracking-widest hover:bg-indigo-700 transition-all flex items-center gap-2 shadow-lg disabled:opacity-50">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Deploy
          </button>
        </div>
      </header>

      {/* ERROR BANNER (PERSISTENT) */}
      {deployError && (
          <div className="bg-rose-50 border-b border-rose-200 p-4 flex items-center justify-between shrink-0 animate-in slide-in-from-top-2">
              <div className="flex items-center gap-3">
                  <AlertTriangle className="text-rose-600" size={20}/>
                  <div><h4 className="text-sm font-black text-rose-900">Deployment Failed</h4><p className="text-xs text-rose-700 font-mono">{deployError}</p></div>
              </div>
              <button onClick={() => setDeployError(null)} className="text-rose-400 hover:text-rose-800"><X size={18}/></button>
          </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* LEFT: CONFIG & AI */}
        <aside className="w-[320px] bg-white border-r border-slate-200 flex flex-col z-20 overflow-hidden">
            <div className="p-5 border-b border-slate-100 bg-gradient-to-b from-indigo-50/50 to-white relative">
                <div className="flex items-center gap-2 mb-2 text-indigo-900"><Bot size={14} /><span className="text-[10px] font-black uppercase tracking-widest">Architect AI (Context Aware)</span></div>
                
                {/* SMART TEXTAREA CONTAINER */}
                <div className="relative">
                    <textarea 
                        ref={promptInputRef}
                        value={aiPrompt}
                        onChange={handlePromptChange}
                        placeholder="Type @ for tables, / for columns..."
                        className="w-full bg-white border border-indigo-100 rounded-xl p-3 text-xs min-h-[80px] outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-500/10 transition-all resize-none"
                    />
                    
                    {/* SUGGESTION BOX POPUP */}
                    {suggestionBox && (
                        <div className="absolute top-full left-0 w-full mt-1 bg-white border border-slate-200 shadow-xl rounded-xl z-50 max-h-48 overflow-y-auto animate-in fade-in zoom-in-95">
                            <div className="bg-slate-50 px-3 py-1.5 border-b border-slate-100 text-[9px] font-black uppercase text-slate-400 tracking-widest sticky top-0">
                                {suggestionBox.type === 'table' ? 'Link Table' : 'Insert Field'}
                            </div>
                            {suggestionBox.type === 'table' ? (
                                allTables.filter(t => t.includes(suggestionBox.query)).map(t => (
                                    <button key={t} onClick={() => handleSelectSuggestion(t, 'table')} className="w-full text-left px-3 py-2 text-xs hover:bg-indigo-50 flex items-center gap-2 text-slate-700">
                                        <Database size={12} className="text-indigo-400"/> {t}
                                    </button>
                                ))
                            ) : (
                                <>
                                    <div className="px-3 py-1 text-[9px] font-bold text-emerald-600 bg-emerald-50">Current: {entityName}</div>
                                    {columns.filter(c => c.name.includes(suggestionBox.query)).map(c => (
                                        <button key={c.name} onClick={() => handleSelectSuggestion(c.name, 'column')} className="w-full text-left px-3 py-2 text-xs hover:bg-slate-50 flex items-center gap-2 text-slate-700 pl-4 border-l-2 border-emerald-200">
                                            <Columns size={12} className="text-slate-400"/> {c.name}
                                        </button>
                                    ))}
                                    {Array.from(mentionedTables).map(tbl => (
                                        <React.Fragment key={tbl}>
                                            <div className="px-3 py-1 text-[9px] font-bold text-indigo-600 bg-indigo-50 border-t border-indigo-100">Linked: {tbl}</div>
                                            {(externalColumns[tbl] || []).filter(c => c.name.includes(suggestionBox.query)).map(c => (
                                                <button key={`${tbl}.${c.name}`} onClick={() => handleSelectSuggestion(`${tbl}.${c.name}`, 'column')} className="w-full text-left px-3 py-2 text-xs hover:bg-slate-50 flex items-center gap-2 text-slate-700 pl-4 border-l-2 border-indigo-200">
                                                    <Columns size={12} className="text-slate-400"/> {c.name}
                                                </button>
                                            ))}
                                        </React.Fragment>
                                    ))}
                                </>
                            )}
                        </div>
                    )}
                </div>

                <div className="flex gap-2 mt-2">
                    {Array.from(mentionedTables).map(t => (
                        <span key={t} className="text-[9px] bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded flex items-center gap-1">
                            <AtSign size={8}/> {t} <button onClick={() => { const s = new Set(mentionedTables); s.delete(t); setMentionedTables(s); }} className="hover:text-rose-500"><X size={8}/></button>
                        </span>
                    ))}
                </div>

                <button onClick={handleAiGenerate} disabled={aiLoading || !aiPrompt} className="w-full mt-3 bg-indigo-600 text-white py-2 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-md flex items-center justify-center gap-2 disabled:opacity-50">
                    {aiLoading ? <Loader2 size={12} className="animate-spin"/> : <Wand2 size={12}/>} Generate
                </button>
            </div>

            {/* Policy Metadata */}
            <div className="p-5 space-y-4 overflow-y-auto flex-1">
                <div className="space-y-1">
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">Policy Name</label>
                    <input value={policyName} onChange={(e) => setPolicyName(e.target.value)} placeholder="tenant_isolation" className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-bold outline-none focus:border-indigo-400 transition-all" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">Command</label>
                        <select value={command} onChange={(e) => setCommand(e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-2 py-2 text-xs font-bold text-indigo-600 outline-none cursor-pointer">
                           <option value="SELECT">SELECT</option><option value="INSERT">INSERT</option><option value="UPDATE">UPDATE</option><option value="DELETE">DELETE</option><option value="ALL">ALL</option>
                        </select>
                    </div>
                    <div>
                        <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">Role</label>
                        <select value={role} onChange={(e) => setRole(e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-2 py-2 text-xs font-bold text-emerald-600 outline-none cursor-pointer">
                           <option value="authenticated">Auth</option><option value="anon">Public</option><option value="service_role">Service</option>
                        </select>
                    </div>
                </div>
            </div>

            {/* Audit Score Footer */}
            <div className="mt-auto p-5 bg-slate-50 border-t border-slate-200">
                <div className="flex items-center justify-between mb-2">
                    <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Security Score</h3>
                    <span className={`text-xl font-black ${auditData.score > 80 ? 'text-emerald-500' : auditData.score > 50 ? 'text-amber-500' : 'text-rose-500'}`}>{auditData.score}</span>
                </div>
                <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden mb-3">
                    <div className={`h-full transition-all duration-700 ease-out ${auditData.score > 80 ? 'bg-emerald-500' : auditData.score > 50 ? 'bg-amber-500' : 'bg-rose-500'}`} style={{ width: `${auditData.score}%` }}></div>
                </div>
                <div className="space-y-1.5 max-h-[100px] overflow-y-auto custom-scrollbar">
                    {auditData.issues.map((issue, i) => (
                        <div key={i} className={`text-[9px] p-1.5 rounded-md leading-tight border flex gap-1.5 ${issue.severity === 'critical' ? 'bg-rose-50 text-rose-700 border-rose-100' : 'bg-amber-50 text-amber-700 border-amber-100'}`}>
                            <AlertTriangle size={10} className="shrink-0 mt-0.5"/>
                            {issue.message}
                        </div>
                    ))}
                </div>
            </div>
        </aside>

        {/* CENTER: CANVAS */}
        <main className="flex-1 bg-[#F1F5F9] relative overflow-hidden flex flex-col">
            <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
                <div className="max-w-4xl mx-auto pb-32">
                    {activeTab === 'visual' ? (
                        <NodeRenderer 
                            node={logicTree} 
                            columns={columns} 
                            foreignKeys={schemaGraph.filter(fk => fk.table_name === entityName)} 
                            entityName={entityName}
                            onUpdate={(id, changes) => {
                                const updateRecursive = (n: LogicNode): LogicNode => {
                                    if (n.id === id) return { ...n, ...changes };
                                    if (n.children) return { ...n, children: n.children.map(updateRecursive) };
                                    return n;
                                };
                                updateTree(updateRecursive(logicTree));
                            }}
                            onAdd={(parentId, type) => {
                                const newNode: LogicNode = {
                                    id: getUUID(), type, operator: type === 'group' ? 'AND' : undefined,
                                    children: type === 'group' || type === 'relation' ? [] : undefined,
                                    field: type === 'condition' ? columns[0]?.name : undefined,
                                    comparator: '=', value: '', valueType: 'static'
                                };
                                const addRecursive = (n: LogicNode): LogicNode => {
                                    if (n.id === parentId) return { ...n, children: [...(n.children || []), newNode] };
                                    if (n.children) return { ...n, children: n.children.map(addRecursive) };
                                    return n;
                                };
                                updateTree(addRecursive(logicTree));
                            }}
                            onRemove={(id) => {
                                const removeRecursive = (n: LogicNode): LogicNode => {
                                    if (!n.children) return n;
                                    return { ...n, children: n.children.filter(c => c.id !== id).map(removeRecursive) };
                                };
                                updateTree(removeRecursive(logicTree));
                            }}
                            schemaGraph={schemaGraph}
                        />
                    ) : activeTab === 'sql' ? (
                        <div className="bg-slate-900 rounded-3xl p-8 shadow-2xl font-mono text-xs text-emerald-400 border border-slate-800 overflow-auto h-full">{sqlPreview}</div>
                    ) : activeTab === 'topology' ? (
                        <div className="bg-white rounded-3xl p-8 shadow-sm border border-slate-200">
                            <h3 className="font-black text-slate-900 mb-4 flex items-center gap-2"><Network size={18}/> Topology Graph</h3>
                            <div className="grid grid-cols-2 gap-3">
                                {schemaGraph.map((fk, i) => (
                                    <div key={i} className="p-3 rounded-xl border border-slate-100 bg-slate-50 flex items-center justify-between">
                                        <span className="font-mono text-[10px] font-bold text-slate-600">{fk.table_name}.{fk.column_name}</span>
                                        <ArrowRight size={12} className="text-slate-300"/>
                                        <span className="font-mono text-[10px] font-bold text-indigo-600">{fk.foreign_table_name}.{fk.foreign_column_name}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {versions.map((ver, i) => (
                                <div key={i} onClick={() => { setLogicTree(ver.logic); setPolicyName(ver.name); }} className="bg-white p-4 rounded-xl border border-slate-200 hover:border-indigo-300 cursor-pointer flex justify-between items-center group transition-all">
                                    <div>
                                        <span className="text-xs font-bold text-slate-700">Version {versions.length - i}</span>
                                        <p className="text-[10px] text-slate-400">{ver.timestamp.toLocaleTimeString()}</p>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <div className={`px-2 py-1 rounded text-[9px] font-black ${ver.score > 80 ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>Score: {ver.score}</div>
                                        <button className="opacity-0 group-hover:opacity-100 p-2 text-indigo-600 hover:bg-indigo-50 rounded-lg"><RefreshCcw size={14}/></button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
            <div className="h-12 bg-white border-t border-slate-200 px-6 flex items-center justify-between shrink-0 z-20 text-[10px] font-mono text-slate-500">
                <span className="truncate max-w-2xl">{sqlPreview}</span>
                <button onClick={() => navigator.clipboard.writeText(sqlPreview)} className="hover:text-indigo-600"><Copy size={12}/></button>
            </div>
        </main>

        {/* RIGHT: SIMULATOR & PROFILER */}
        <aside className="w-[380px] bg-white border-l border-slate-200 flex flex-col z-20 shadow-xl">
            <div className="flex border-b border-slate-100">
                <button onClick={() => setActivePanel('audit')} className={`flex-1 py-3 text-[10px] font-black uppercase tracking-widest ${activePanel === 'audit' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-slate-400'}`}>Auditor</button>
                <button onClick={() => setActivePanel('simulate')} className={`flex-1 py-3 text-[10px] font-black uppercase tracking-widest ${activePanel === 'simulate' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-slate-400'}`}>Simulator</button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 bg-[#FAFBFC]">
                {activePanel === 'audit' ? (
                    <div className="space-y-6">
                        <div className="bg-white p-5 rounded-[2rem] border border-slate-100 shadow-sm text-center">
                            <div className={`w-16 h-16 rounded-full mx-auto flex items-center justify-center text-2xl font-black mb-2 ${auditData.score > 80 ? 'bg-emerald-100 text-emerald-600' : 'bg-amber-100 text-amber-600'}`}>{auditData.score}</div>
                            <h3 className="text-xs font-black uppercase tracking-widest text-slate-400">Security Rating</h3>
                        </div>
                        <div className="space-y-2">
                            {auditData.issues.map((iss, i) => (
                                <div key={i} className="bg-white p-3 rounded-xl border border-slate-200 flex gap-3 shadow-sm">
                                    <AlertTriangle size={16} className="text-rose-500 shrink-0"/>
                                    <p className="text-[10px] font-bold text-slate-700">{iss.message}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : (
                    <div className="space-y-6">
                        <div className="space-y-2">
                            <label className="text-[9px] font-bold text-slate-400 uppercase">Simulated User (Auth.UID)</label>
                            <select value={simUser} onChange={(e) => setSimUser(e.target.value)} className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold outline-none cursor-pointer">
                                <option value="">-- Select User --</option>
                                {dbUsers.map(u => <option key={u.id} value={u.id}>{u.email || u.id}</option>)}
                            </select>
                        </div>
                        <button onClick={handleSimulate} disabled={simLoading || !simUser} className="w-full bg-indigo-600 text-white py-3 rounded-xl text-xs font-black uppercase tracking-widest shadow-lg hover:bg-indigo-700 transition-all flex items-center justify-center gap-2">
                            {simLoading ? <Loader2 size={14} className="animate-spin"/> : <Play size={14}/>} Run Simulation
                        </button>
                        {simResult && (
                            <div className={`p-4 rounded-2xl border ${simResult.success ? 'bg-emerald-50 border-emerald-200' : 'bg-rose-50 border-rose-200'}`}>
                                <div className="flex items-center gap-2 mb-2">
                                    {simResult.success ? <CheckCircle2 size={16} className="text-emerald-600"/> : <AlertTriangle size={16} className="text-rose-600"/>}
                                    <span className={`text-xs font-black uppercase ${simResult.success ? 'text-emerald-800' : 'text-rose-800'}`}>{simResult.success ? 'Allowed' : 'Execution Error'}</span>
                                </div>
                                {simResult.success ? (
                                    <div className="grid grid-cols-3 gap-2 mt-3 text-center">
                                        <div className="bg-white/50 p-2 rounded-lg"><div className="text-lg font-black text-slate-700">{simResult.rows}</div><div className="text-[8px] text-slate-400 font-black uppercase">Rows</div></div>
                                        <div className="bg-white/50 p-2 rounded-lg"><div className="text-lg font-black text-slate-700">{simResult.time?.toFixed(2)}</div><div className="text-[8px] text-slate-400 font-black uppercase">ms</div></div>
                                    </div>
                                ) : <p className="text-[10px] text-rose-700 font-mono break-words">{simResult.error}</p>}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </aside>
      </div>
    </div>
  );
};

// --- RECURSIVE VISUAL EXPLAIN ---
const VisualExplain: React.FC<{ node: any }> = ({ node }) => {
    const isScan = node['Node Type'].includes('Scan');
    const isBad = isScan && node['Node Type'] === 'Seq Scan';
    
    return (
        <div className="pl-4 border-l border-slate-200 text-[10px]">
            <div className={`p-2 rounded mb-1 border flex justify-between items-center ${isBad ? 'bg-rose-50 border-rose-100 text-rose-700' : 'bg-white border-slate-100 text-slate-600'}`}>
                <div>
                    <div className="font-bold flex items-center gap-2">
                        {node['Node Type']}
                        {isBad && <AlertTriangle size={10} className="text-rose-500"/>}
                    </div>
                    {node['Relation Name'] && <div className="text-[9px] opacity-70">on {node['Relation Name']}</div>}
                </div>
                <div className="text-right">
                    <div className="font-mono font-bold">{node['Total Cost']}</div>
                    <div className="text-[8px] opacity-60">Cost</div>
                </div>
            </div>
            {node.Plans && node.Plans.map((child: any, i: number) => <VisualExplain key={i} node={child} />)}
        </div>
    );
};

// --- RECURSIVE NODE RENDERER ---
const NodeRenderer: React.FC<{
    node: LogicNode;
    columns: ColumnDefinition[];
    foreignKeys: ForeignKeyDefinition[];
    entityName: string;
    onUpdate: (id: string, changes: Partial<LogicNode>) => void;
    onAdd: (parentId: string, type: 'group' | 'condition' | 'relation') => void;
    onRemove: (id: string) => void;
    schemaGraph: ForeignKeyDefinition[];
}> = ({ node, columns, foreignKeys, entityName, onUpdate, onAdd, onRemove, schemaGraph }) => {
    const isRoot = node.id === 'root';
    const isGroup = node.type === 'group';
    const isRelation = node.type === 'relation';
    const currentTable = isRelation ? node.relationTable : entityName;
    const relevantFKs = isRelation ? schemaGraph.filter(fk => fk.table_name === currentTable) : foreignKeys;

    // Index Check for Relations (Performance Warning)
    const isMissingIndex = isRelation && node.relationLocalKey && !columns.find(c => c.name === node.relationLocalKey)?.isIndex;

    return (
        <div className={`relative flex flex-col ${!isRoot ? 'ml-8 mt-4' : ''}`}>
            {!isRoot && <div className="absolute -left-8 top-6 w-8 h-[2px] bg-slate-300 rounded-l-full"></div>}
            {!isRoot && <div className="absolute -left-8 -top-4 h-[calc(100%+2rem)] w-[2px] bg-slate-300"></div>}

            <div className={`
                flex items-center gap-3 p-4 rounded-2xl border transition-all shadow-sm group
                ${isGroup ? 'bg-slate-50 border-slate-200' : isRelation ? (isMissingIndex ? 'bg-amber-50 border-amber-300 ring-1 ring-amber-200' : 'bg-indigo-50 border-indigo-200') : 'bg-white border-slate-200 hover:border-indigo-300 hover:shadow-md'}
            `}>
                {!isRoot && <GripVertical size={16} className="text-slate-300 cursor-grab active:text-indigo-600" />}

                {isGroup && (
                    <div className="flex items-center gap-4">
                        <div className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest flex items-center gap-2 cursor-pointer transition-colors ${node.operator === 'AND' ? 'bg-amber-100 text-amber-700' : 'bg-purple-100 text-purple-700'}`}>
                            <GitBranch size={12}/>
                            <select value={node.operator} onChange={(e) => onUpdate(node.id, { operator: e.target.value as any })} className="bg-transparent outline-none appearance-none cursor-pointer">
                                <option value="AND">ALL OF (AND)</option><option value="OR">ANY OF (OR)</option>
                            </select>
                        </div>
                        <div className="h-6 w-[1px] bg-slate-300 mx-1"></div>
                        <div className="flex gap-2">
                            <ActionButton onClick={() => onAdd(node.id, 'condition')} icon={<Plus size={14}/>} label="Rule" color="emerald"/>
                            <ActionButton onClick={() => onAdd(node.id, 'group')} icon={<Layers size={14}/>} label="Group" color="amber"/>
                            <ActionButton onClick={() => onAdd(node.id, 'relation')} icon={<LinkIcon size={14}/>} label="Relation" color="indigo"/>
                        </div>
                    </div>
                )}

                {isRelation && (
                    <div className="flex items-center gap-3 text-xs w-full">
                        <span className="font-bold text-indigo-700 uppercase text-[10px] bg-indigo-100 px-2 py-1 rounded">Link</span>
                        <select value={node.relationLocalKey} onChange={(e) => {
                              const fk = relevantFKs.find(f => f.column_name === e.target.value);
                              if (fk) onUpdate(node.id, { relationLocalKey: fk.column_name, relationTable: fk.foreign_table_name, relationForeignKey: fk.foreign_column_name });
                          }} className="bg-white border border-indigo-200 rounded-lg px-3 py-2 font-bold text-indigo-700 outline-none focus:ring-2 focus:ring-indigo-500/20 cursor-pointer">
                            <option value="">Select Connection...</option>
                            {relevantFKs.map(fk => <option key={fk.constraint_name} value={fk.column_name}>{fk.column_name} ➔ {fk.foreign_table_name}</option>)}
                        </select>
                        
                        {isMissingIndex && <div className="text-amber-600 bg-amber-100 p-1.5 rounded flex items-center gap-1" title="Missing Index! This relation will cause a Sequential Scan (Slow)."><AlertTriangle size={14}/> <span className="text-[9px] font-bold">SLOW</span></div>}
                        
                        {node.relationTable && (
                            <>
                                <ArrowRight size={14} className="text-indigo-300"/>
                                <span className="font-bold text-slate-700 bg-white px-3 py-2 rounded-lg border border-slate-200 flex items-center gap-2"><Database size={12} className="text-slate-400"/>{node.relationTable}</span>
                                <div className="ml-auto flex gap-2">
                                    <ActionButton onClick={() => onAdd(node.id, 'condition')} icon={<Plus size={14}/>} label="Condition" color="indigo" minimal/>
                                    <ActionButton onClick={() => onAdd(node.id, 'relation')} icon={<LinkIcon size={14}/>} label="Chain" color="purple" minimal/>
                                </div>
                            </>
                        )}
                    </div>
                )}

                {!isGroup && !isRelation && (
                    <div className="flex items-center gap-3 w-full">
                        <div className="relative min-w-[180px]">
                            <select value={node.field} onChange={(e) => onUpdate(node.id, { field: e.target.value })} className="w-full appearance-none bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-700 font-mono text-xs font-bold py-2.5 pl-3 pr-8 rounded-xl outline-none cursor-pointer transition-colors focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/10">
                                <option value="" disabled>Select Field</option>
                                {columns.map(c => <option key={c.name} value={c.name}>{c.name} ({c.type})</option>)}
                                <option value="true">ALWAYS TRUE</option>
                            </select>
                            <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                        </div>
                        <select value={node.comparator} onChange={(e) => onUpdate(node.id, { comparator: e.target.value as any })} className="bg-slate-100 text-slate-600 text-xs font-black py-2.5 px-3 rounded-xl outline-none text-center cursor-pointer hover:bg-slate-200">
                            {['=', '!=', '>', '<', '>=', '<=', 'IN', 'IS', 'ILIKE'].map(op => <option key={op} value={op}>{op}</option>)}
                        </select>
                        <div className="flex-1 relative group/val">
                            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">{node.valueType === 'auth' ? <User size={14} className="text-purple-500"/> : null}</div>
                            <input value={node.value} onChange={(e) => onUpdate(node.id, { value: e.target.value })} placeholder={node.valueType === 'auth' ? 'auth.uid()' : 'Value...'} className={`w-full border rounded-xl py-2.5 pr-10 text-xs font-mono font-medium outline-none transition-all ${node.valueType === 'auth' ? 'bg-purple-50 border-purple-200 text-purple-700 pl-9' : 'bg-white border-slate-200 text-slate-700 pl-4 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/10'}`}/>
                            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-1 opacity-0 group-hover/val:opacity-100 transition-opacity bg-white shadow-sm rounded-lg border border-slate-100 p-0.5">
                                <button onClick={() => onUpdate(node.id, { value: 'auth.uid()', valueType: 'auth' })} title="Auth Context" className="p-1.5 hover:bg-purple-50 text-slate-400 hover:text-purple-600 rounded"><User size={12}/></button>
                                <button onClick={() => onUpdate(node.id, { value: '', valueType: 'static' })} title="Static Value" className="p-1.5 hover:bg-slate-50 text-slate-400 hover:text-slate-600 rounded"><CheckSquare size={12}/></button>
                            </div>
                        </div>
                    </div>
                )}

                {!isRoot && <button onClick={() => onRemove(node.id)} className="ml-auto p-2 text-slate-300 hover:text-rose-500 hover:bg-rose-50 rounded-xl transition-all"><X size={16} /></button>}
            </div>

            {node.children && node.children.length > 0 && (
                <div className="pl-8 border-l-2 border-slate-200 ml-8 pb-2 pt-2">
                    {node.children.map(child => (
                        <NodeRenderer key={child.id} node={child} columns={isRelation && node.relationTable ? [] : columns} foreignKeys={schemaGraph} entityName={isRelation ? (node.relationTable || entityName) : entityName} onUpdate={onUpdate} onAdd={onAdd} onRemove={onRemove} schemaGraph={schemaGraph}/>
                    ))}
                </div>
            )}
        </div>
    );
};

const ActionButton: React.FC<{ onClick: () => void, icon: React.ReactNode, label: string, color: string, minimal?: boolean }> = ({ onClick, icon, label, color, minimal }) => {
    const colors: any = { emerald: 'text-emerald-600 hover:bg-emerald-50', amber: 'text-amber-600 hover:bg-amber-50', indigo: 'text-indigo-600 hover:bg-indigo-50', purple: 'text-purple-600 hover:bg-purple-50' };
    return (
        <button onClick={onClick} className={`flex items-center gap-1.5 rounded-lg font-bold transition-all ${colors[color]} ${minimal ? 'p-1.5' : 'px-3 py-1.5 bg-white border border-slate-200 hover:border-transparent shadow-sm'}`} title={`Add ${label}`}>
            {icon} {!minimal && <span className="text-[10px] uppercase tracking-wider">{label}</span>}
        </button>
    );
};

export default RLSDesigner;
