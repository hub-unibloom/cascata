
import React, { useState, useEffect, useCallback } from 'react';
import { 
  Shield, Play, Plus, X, Save, ArrowLeft, Loader2, 
  User, Database, Lock, Eye, CheckCircle2, GripVertical, 
  Trash2, Copy, GitBranch, Zap, Box, Key, AlignLeft, MousePointer2,
  ChevronDown, ShieldCheck
} from 'lucide-react';

interface RLSDesignerProps {
  projectId: string;
  entityType: 'table' | 'bucket';
  entityName: string;
  onBack: () => void;
}

type BlockType = 'auth' | 'column' | 'logic' | 'value' | 'comparator';

interface Block {
  id: string;
  type: BlockType;
  category: 'auth' | 'data' | 'logic' | 'static';
  label: string;
  value: string;
  isContainer?: boolean; // For AND/OR groups
  parentId?: string;
}

interface LogicNode {
  id: string;
  type: 'group' | 'condition';
  operator?: 'AND' | 'OR'; // If group
  field?: string; // If condition
  comparator?: string; // If condition
  value?: string; // If condition
  children?: LogicNode[]; // If group
}

// Helper robusto para gerar UUIDs em ambientes HTTP/HTTPS
const getUUID = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try { return crypto.randomUUID(); } catch(e) { /* ignore */ }
  }
  // Fallback para ambientes não seguros (HTTP)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

const RLSDesigner: React.FC<RLSDesignerProps> = ({ projectId, entityType, entityName, onBack }) => {
  const [columns, setColumns] = useState<string[]>([]);
  const [policyName, setPolicyName] = useState('');
  const [command, setCommand] = useState('SELECT');
  const [role, setRole] = useState('authenticated');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [availableBlocks, setAvailableBlocks] = useState<Block[]>([]);
  
  // The core logic tree
  const [logicTree, setLogicTree] = useState<LogicNode>({
    id: 'root',
    type: 'group',
    operator: 'AND',
    children: []
  });

  const fetchMetadata = async () => {
    setLoading(true);
    const token = localStorage.getItem('cascata_token');
    try {
      if (entityType === 'table') {
        const res = await fetch(`/api/data/${projectId}/tables/${entityName}/columns`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        setColumns(data.map((c: any) => c.name));
      } else {
        // Storage Standard Attributes
        setColumns(['name', 'owner_id', 'created_at', 'updated_at', 'size', 'mime_type']);
      }
    } catch (e) {
      console.error("Failed to load metadata");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMetadata();
  }, [projectId, entityName]);

  // Initial Blocks Setup
  useEffect(() => {
    const blocks: Block[] = [
      // AUTH BLOCKS
      { id: 'auth_uid', type: 'auth', category: 'auth', label: 'Current User ID', value: 'auth.uid()' },
      { id: 'auth_role', type: 'auth', category: 'auth', label: 'User Role', value: 'auth.role()' },
      { id: 'auth_email', type: 'auth', category: 'auth', label: 'User Email', value: 'auth.jwt() ->> \'email\'' },
      { id: 'auth_is_anon', type: 'auth', category: 'auth', label: 'Is Anonymous', value: 'auth.role() = \'anon\'' },
      
      // LOGIC BLOCKS
      { id: 'logic_and', type: 'logic', category: 'logic', label: 'AND Group', value: 'AND', isContainer: true },
      { id: 'logic_or', type: 'logic', category: 'logic', label: 'OR Group', value: 'OR', isContainer: true },
      
      // STATIC VALUES
      { id: 'val_true', type: 'value', category: 'static', label: 'TRUE (Allow)', value: 'true' },
      { id: 'val_false', type: 'value', category: 'static', label: 'FALSE (Deny)', value: 'false' },
    ];
    setAvailableBlocks(blocks);
  }, []);

  const addNode = (parentId: string, nodeType: 'condition' | 'group') => {
    const newNode: LogicNode = nodeType === 'group' 
      ? { id: getUUID(), type: 'group', operator: 'AND', children: [] }
      : { id: getUUID(), type: 'condition', field: columns[0] || 'id', comparator: '=', value: 'auth.uid()' };

    const updateTree = (node: LogicNode): LogicNode => {
      if (node.id === parentId && node.children) {
        return { ...node, children: [...node.children, newNode] };
      }
      if (node.children) {
        return { ...node, children: node.children.map(updateTree) };
      }
      return node;
    };

    setLogicTree(updateTree(logicTree));
  };

  const removeNode = (nodeId: string) => {
    const updateTree = (node: LogicNode): LogicNode => {
      if (node.children) {
        return { ...node, children: node.children.filter(child => child.id !== nodeId).map(updateTree) };
      }
      return node;
    };
    setLogicTree(updateTree(logicTree));
  };

  const updateNode = (nodeId: string, updates: Partial<LogicNode>) => {
    const updateTree = (node: LogicNode): LogicNode => {
      if (node.id === nodeId) {
        return { ...node, ...updates };
      }
      if (node.children) {
        return { ...node, children: node.children.map(updateTree) };
      }
      return node;
    };
    setLogicTree(updateTree(logicTree));
  };

  // Compile Tree to SQL
  const compileSQL = (node: LogicNode, depth = 0): string => {
    if (node.type === 'group') {
      if (!node.children || node.children.length === 0) return 'true'; // Empty group default
      const childrenSQL = node.children.map(child => compileSQL(child, depth + 1));
      const joined = childrenSQL.join(` ${node.operator} `);
      return depth === 0 ? joined : `(${joined})`;
    } else {
      // Condition
      let val = node.value || '';
      // Simple heuristic: if value looks like a string literal but isn't a function call (contains '('), quote it.
      // This is a basic implementation. Ideally, we'd have a 'type' for the value.
      // For now, users type raw SQL values or select Auth functions.
      return `${node.field} ${node.comparator} ${val}`;
    }
  };

  const generatedSQL = compileSQL(logicTree);

  const handleSave = async () => {
    if (!policyName) { alert("Please name your policy."); return; }
    setSaving(true);
    try {
      const token = localStorage.getItem('cascata_token');
      const payload = {
        name: policyName,
        table: entityName,
        command: command,
        role: role,
        using: generatedSQL,
        withCheck: ['INSERT', 'UPDATE', 'ALL'].includes(command) ? generatedSQL : ''
      };

      const res = await fetch(`/api/data/${projectId}/policies`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}` 
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error("Failed to save policy");
      onBack(); // Return to manager
    } catch (e) {
      alert("Error saving policy");
    } finally {
      setSaving(false);
    }
  };

  // --- RENDERERS ---

  const renderNode = (node: LogicNode) => {
    if (node.type === 'group') {
      return (
        <div key={node.id} className="border-l-4 border-slate-300 pl-4 py-2 my-2 relative group transition-all">
          <div className="flex items-center gap-3 mb-2">
            <div className="bg-amber-100 text-amber-700 px-3 py-1 rounded-lg font-black text-xs uppercase tracking-widest border border-amber-200 flex items-center gap-2 shadow-sm">
              <GitBranch size={14} />
              <select 
                value={node.operator} 
                onChange={(e) => updateNode(node.id, { operator: e.target.value as 'AND' | 'OR' })}
                className="bg-transparent outline-none cursor-pointer"
              >
                <option value="AND">ALL OF (AND)</option>
                <option value="OR">ANY OF (OR)</option>
              </select>
            </div>
            <div className="h-[1px] bg-slate-200 flex-1"></div>
            {node.id !== 'root' && (
              <button onClick={() => removeNode(node.id)} className="text-slate-300 hover:text-rose-500 transition-colors p-1"><Trash2 size={14} /></button>
            )}
          </div>
          
          <div className="space-y-2">
            {node.children?.map(renderNode)}
          </div>

          <div className="mt-3 flex gap-2 opacity-50 hover:opacity-100 transition-opacity">
            <button onClick={() => addNode(node.id, 'condition')} className="text-[10px] font-bold bg-slate-100 hover:bg-indigo-50 hover:text-indigo-600 text-slate-500 px-3 py-1.5 rounded-lg flex items-center gap-1 transition-all">
              <Plus size={12} /> Add Rule
            </button>
            <button onClick={() => addNode(node.id, 'group')} className="text-[10px] font-bold bg-slate-100 hover:bg-amber-50 hover:text-amber-600 text-slate-500 px-3 py-1.5 rounded-lg flex items-center gap-1 transition-all">
              <Box size={12} /> Add Group
            </button>
          </div>
        </div>
      );
    } else {
      // CONDITION NODE
      return (
        <div key={node.id} className="flex items-center gap-2 bg-white p-3 rounded-xl border border-slate-200 shadow-sm hover:border-indigo-300 transition-all group relative">
          <GripVertical size={14} className="text-slate-300 cursor-move" />
          
          {/* FIELD */}
          <div className="relative">
            <select 
              value={node.field} 
              onChange={(e) => updateNode(node.id, { field: e.target.value })}
              className="appearance-none bg-emerald-50 border border-emerald-100 text-emerald-700 font-mono text-xs font-bold py-2 pl-3 pr-8 rounded-lg outline-none focus:ring-2 focus:ring-emerald-500/20 cursor-pointer"
            >
              {columns.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-emerald-400 pointer-events-none" />
          </div>

          {/* COMPARATOR */}
          <select 
            value={node.comparator} 
            onChange={(e) => updateNode(node.id, { comparator: e.target.value })}
            className="bg-slate-100 text-slate-600 text-xs font-black py-2 px-2 rounded-lg outline-none text-center cursor-pointer hover:bg-slate-200"
          >
            <option value="=">=</option>
            <option value="!=">!=</option>
            <option value=">">&gt;</option>
            <option value="<">&lt;</option>
            <option value="IN">IN</option>
            <option value="IS">IS</option>
          </select>

          {/* VALUE (Droppable Target Logic Simulated) */}
          <div className="flex-1 relative">
             <input 
               value={node.value}
               onChange={(e) => updateNode(node.id, { value: e.target.value })}
               placeholder="value or auth.uid()"
               className="w-full bg-slate-50 border border-slate-200 text-slate-800 font-mono text-xs py-2 px-3 rounded-lg outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/10 transition-all"
             />
             {/* Quick Actions for Value */}
             <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-1">
                <button onClick={() => updateNode(node.id, { value: 'auth.uid()' })} title="Set to Current User ID" className="p-1 text-indigo-300 hover:text-indigo-600 transition-colors"><User size={12}/></button>
                <button onClick={() => updateNode(node.id, { value: 'true' })} title="Set to True" className="p-1 text-emerald-300 hover:text-emerald-600 transition-colors"><CheckCircle2 size={12}/></button>
             </div>
          </div>

          <button onClick={() => removeNode(node.id)} className="p-2 text-slate-300 hover:text-rose-500 transition-colors opacity-0 group-hover:opacity-100"><X size={14} /></button>
        </div>
      );
    }
  };

  return (
    <div className="h-screen flex flex-col bg-[#F0F4F8] relative z-50">
      {/* Header */}
      <header className="h-20 bg-white border-b border-slate-200 flex items-center justify-between px-8 shrink-0">
        <div className="flex items-center gap-6">
          <button onClick={onBack} className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-400 hover:text-slate-900">
            <ArrowLeft size={24} />
          </button>
          <div>
            <h1 className="text-2xl font-black text-slate-900 tracking-tight flex items-center gap-3">
              RLS Architect <span className="bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded text-[10px] uppercase tracking-widest font-bold border border-indigo-200">Visual Mode</span>
            </h1>
            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">
              Securing {entityType}: <span className="text-indigo-600 font-mono">{entityName}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* Policy Config Inputs */}
          <div className="flex items-center gap-2 bg-slate-50 p-1.5 rounded-xl border border-slate-200 mr-4">
             <input 
               value={policyName}
               onChange={(e) => setPolicyName(e.target.value)}
               placeholder="Policy Name (e.g. User Own Data)"
               className="bg-transparent text-xs font-bold px-3 py-2 outline-none w-48 text-slate-700 placeholder:text-slate-400"
             />
             <div className="w-[1px] h-6 bg-slate-200"></div>
             <select 
               value={command}
               onChange={(e) => setCommand(e.target.value)}
               className="bg-transparent text-[10px] font-black uppercase text-indigo-600 outline-none px-2 cursor-pointer"
             >
               <option value="SELECT">Select (Read)</option>
               <option value="INSERT">Insert (Create)</option>
               <option value="UPDATE">Update (Edit)</option>
               <option value="DELETE">Delete (Remove)</option>
               <option value="ALL">ALL Actions</option>
             </select>
             <div className="w-[1px] h-6 bg-slate-200"></div>
             <select 
               value={role}
               onChange={(e) => setRole(e.target.value)}
               className="bg-transparent text-[10px] font-black uppercase text-emerald-600 outline-none px-2 cursor-pointer"
             >
               <option value="authenticated">Authenticated</option>
               <option value="anon">Anonymous</option>
               <option value="public">Public (All)</option>
             </select>
          </div>

          <button 
            onClick={handleSave} 
            disabled={saving || !policyName}
            className="bg-slate-900 text-white px-6 py-3 rounded-xl font-black text-xs uppercase tracking-widest hover:bg-indigo-600 transition-all flex items-center gap-2 shadow-xl disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Deploy Rules
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* LEFT TOOLBOX */}
        <aside className="w-72 bg-white border-r border-slate-200 flex flex-col overflow-y-auto">
          <div className="p-6">
            <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-4">Building Blocks</h3>
            
            <div className="space-y-6">
              {/* AUTH CATEGORY */}
              <div>
                <div className="flex items-center gap-2 text-indigo-600 mb-2 font-bold text-xs"><Lock size={12} /> Authentication</div>
                <div className="space-y-2">
                  {availableBlocks.filter(b => b.category === 'auth').map(b => (
                    <div key={b.id} draggable className="bg-indigo-50 border border-indigo-100 p-3 rounded-lg text-xs font-bold text-indigo-900 cursor-grab active:cursor-grabbing hover:bg-indigo-100 transition-colors shadow-sm select-none">
                      {b.label}
                    </div>
                  ))}
                </div>
              </div>

              {/* DATA CATEGORY */}
              <div>
                <div className="flex items-center gap-2 text-emerald-600 mb-2 font-bold text-xs"><Database size={12} /> Entity Fields</div>
                <div className="space-y-2">
                  {columns.map(col => (
                    <div key={col} draggable className="bg-emerald-50 border border-emerald-100 p-3 rounded-lg text-xs font-bold text-emerald-900 cursor-grab active:cursor-grabbing hover:bg-emerald-100 transition-colors shadow-sm select-none flex justify-between items-center">
                      {col} <span className="text-[9px] opacity-50 bg-emerald-200 px-1 rounded">COL</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* LOGIC CATEGORY */}
              <div>
                <div className="flex items-center gap-2 text-amber-600 mb-2 font-bold text-xs"><GitBranch size={12} /> Logic Flow</div>
                <div className="space-y-2">
                  <div className="bg-amber-50 border border-amber-100 p-3 rounded-lg text-xs font-bold text-amber-900 cursor-grab active:cursor-grabbing hover:bg-amber-100 transition-colors shadow-sm select-none">
                    AND Group (All match)
                  </div>
                  <div className="bg-amber-50 border border-amber-100 p-3 rounded-lg text-xs font-bold text-amber-900 cursor-grab active:cursor-grabbing hover:bg-amber-100 transition-colors shadow-sm select-none">
                    OR Group (Any match)
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          <div className="mt-auto p-6 bg-slate-50 border-t border-slate-100">
            <p className="text-[10px] text-slate-400 leading-relaxed text-center">
              Drag & Drop functionality is simplified in this version. Use the "+" buttons on the canvas to build your logic tree.
            </p>
          </div>
        </aside>

        {/* CENTER CANVAS */}
        <main className="flex-1 bg-slate-50 p-10 overflow-y-auto relative bg-[radial-gradient(#e2e8f0_1px,transparent_1px)] [background-size:20px_20px]">
          <div className="max-w-3xl mx-auto">
            <div className="bg-white rounded-[2rem] shadow-xl border border-slate-200 overflow-hidden min-h-[600px] flex flex-col">
              {/* Root Block */}
              <div className="bg-slate-900 text-white p-6 rounded-t-[2rem] flex items-center gap-4">
                <ShieldCheck size={24} className="text-emerald-400" />
                <div>
                  <h2 className="text-lg font-black tracking-tight">Access Rule Definition</h2>
                  <p className="text-[10px] text-slate-400 uppercase tracking-widest font-bold">Root Logic Container</p>
                </div>
              </div>

              <div className="p-8 flex-1">
                {/* Visual Connector Line */}
                <div className="relative pl-6 border-l-2 border-dashed border-slate-300 ml-4 pb-10">
                   <div className="absolute -left-[9px] top-0 w-4 h-4 bg-slate-300 rounded-full border-4 border-white"></div>
                   
                   {/* The Tree */}
                   <div className="space-y-4">
                      {renderNode(logicTree)}
                   </div>
                </div>
              </div>
            </div>
          </div>
        </main>

        {/* RIGHT PREVIEW */}
        <aside className="w-80 bg-white border-l border-slate-200 flex flex-col">
          <div className="p-6 border-b border-slate-100 bg-slate-50/50">
            <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2"><Eye size={12}/> Live Compilation</h3>
          </div>
          <div className="flex-1 p-6 overflow-y-auto">
            <div className="space-y-6">
              <div>
                <label className="text-[10px] font-bold text-indigo-600 mb-2 block">GENERATED SQL (USING)</label>
                <pre className="bg-slate-900 text-emerald-400 p-4 rounded-xl font-mono text-[10px] leading-relaxed whitespace-pre-wrap border border-slate-800 shadow-inner">
                  {generatedSQL}
                </pre>
              </div>
              
              {['INSERT', 'UPDATE', 'ALL'].includes(command) && (
                <div>
                  <label className="text-[10px] font-bold text-amber-600 mb-2 block">MUTATION CHECK (WITH CHECK)</label>
                  <div className="p-3 bg-amber-50 border border-amber-100 rounded-xl text-[10px] text-amber-800 font-medium">
                    Same logic applied to write operations.
                  </div>
                </div>
              )}

              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 mt-8">
                <h4 className="font-bold text-xs text-slate-700 mb-2 flex items-center gap-2"><Zap size={12}/> Logic Summary</h4>
                <p className="text-[10px] text-slate-500 leading-relaxed">
                  Users with role <b>{role}</b> performing <b>{command}</b> on <b>{entityName}</b> must satisfy the conditions defined in the logic tree.
                </p>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
};

export default RLSDesigner;
