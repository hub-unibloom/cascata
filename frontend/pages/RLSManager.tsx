
import React, { useState, useEffect, useMemo } from 'react';
import { 
  Shield, Lock, Plus, Trash2, AlertCircle, Loader2, X, 
  Database, Zap, Globe, Key, Infinity as InfinityIcon, 
  ShieldCheck, ShieldAlert, Siren, Gauge, RefreshCw, Layers,
  ChevronDown, ChevronRight, CheckCircle2, AlertTriangle, Edit3, Move, Lock as LockedIcon,
  SlidersHorizontal, Clock, Ban
} from 'lucide-react';
import ProjectLogs from './ProjectLogs';

// --- RLS TAB IMPLEMENTATION ---
const RLSTab: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [tables, setTables] = useState<any[]>([]);
  const [policies, setPolicies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchSecurityData = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('cascata_token');
      const headers = { 'Authorization': `Bearer ${token}` };
      
      const tablesQuery = `
        SELECT relname as name, relrowsecurity as rls_enabled 
        FROM pg_class 
        JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace 
        WHERE nspname = 'public' AND relkind = 'r' AND relname NOT LIKE '_deleted_%'
        ORDER BY relname;
      `;
      
      const [tablesRes, policiesRes] = await Promise.all([
        fetch(`/api/data/${projectId}/query`, { 
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ sql: tablesQuery })
        }),
        fetch(`/api/data/${projectId}/policies`, { headers })
      ]);
      
      const tablesData = await tablesRes.json();
      const policiesData = await policiesRes.json();
      
      setTables(tablesData.rows || []);
      setPolicies(policiesData);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchSecurityData(); }, [projectId]);

  const toggleRLS = async (tableName: string, enable: boolean) => {
      const sql = `ALTER TABLE public."${tableName}" ${enable ? 'ENABLE' : 'DISABLE'} ROW LEVEL SECURITY`;
      try {
        await fetch(`/api/data/${projectId}/query`, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ sql })
        });
        fetchSecurityData();
      } catch (e) { alert("Failed to update RLS settings"); }
  };

  const deletePolicy = async (table: string, name: string) => {
      if(!confirm("Are you sure you want to delete this policy?")) return;
      try {
          await fetch(`/api/data/${projectId}/policies/${table}/${name}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          fetchSecurityData();
      } catch(e) { alert("Failed to delete policy"); }
  };

  if (loading) return <div className="p-20 flex justify-center"><Loader2 className="animate-spin text-indigo-600" /></div>;

  return (
    <div className="p-10 max-w-6xl mx-auto space-y-8 pb-40">
        <div className="flex items-center justify-between">
            <h3 className="text-xl font-black text-slate-900 flex items-center gap-3">
                <ShieldCheck size={24} className="text-emerald-500" />
                Table Security Policies
            </h3>
            <button onClick={fetchSecurityData} className="p-2 text-slate-400 hover:text-indigo-600 rounded-lg hover:bg-slate-50 transition-all">
                <RefreshCw size={20} />
            </button>
        </div>

        <div className="space-y-6">
            {tables.map(table => {
                const tablePolicies = policies.filter(p => p.tablename === table.name);
                
                return (
                    <div key={table.name} className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm transition-all hover:shadow-md">
                        <div className="flex items-center justify-between mb-8">
                            <div className="flex items-center gap-6">
                                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center ${table.rls_enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}>
                                    <Database size={24} />
                                </div>
                                <div>
                                    <h4 className="text-xl font-black text-slate-900 tracking-tight">{table.name}</h4>
                                    <div className="flex items-center gap-3 mt-1">
                                        <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded ${table.rls_enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                                            {table.rls_enabled ? 'RLS ENABLED' : 'RLS DISABLED'}
                                        </span>
                                        <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">{tablePolicies.length} Policies</span>
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center gap-4">
                                <button 
                                    onClick={() => toggleRLS(table.name, !table.rls_enabled)}
                                    className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${table.rls_enabled ? 'bg-rose-50 text-rose-600 hover:bg-rose-100' : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'}`}
                                >
                                    {table.rls_enabled ? 'Disable Security' : 'Enable Security'}
                                </button>
                                <button 
                                    onClick={() => window.location.hash = `#/project/${projectId}/rls-editor/table/${table.name}`}
                                    className="bg-indigo-600 text-white px-5 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all flex items-center gap-2 shadow-lg shadow-indigo-100"
                                >
                                    <Plus size={14} /> New Policy
                                </button>
                            </div>
                        </div>

                        <div className="space-y-3">
                            {tablePolicies.length === 0 && (
                                <div className="p-6 bg-slate-50 rounded-2xl text-center border border-slate-100 border-dashed">
                                    <p className="text-xs font-bold text-slate-400">No policies defined. {table.rls_enabled ? 'Table is completely locked (Deny All).' : 'Table is completely open (Allow All).'}</p>
                                </div>
                            )}
                            {tablePolicies.map((p: any) => (
                                <div key={p.policyname} className="flex items-center justify-between p-5 bg-slate-50 border border-slate-100 rounded-2xl group hover:bg-white hover:shadow-sm transition-all">
                                    <div className="flex items-center gap-4">
                                        <div className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest ${p.cmd === 'SELECT' ? 'bg-blue-100 text-blue-700' : p.cmd === 'INSERT' ? 'bg-emerald-100 text-emerald-700' : p.cmd === 'UPDATE' ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'}`}>
                                            {p.cmd === 'ALL' ? '*' : p.cmd}
                                        </div>
                                        <span className="text-sm font-bold text-slate-700">{p.policyname}</span>
                                        <span className="text-[10px] text-slate-400 font-mono bg-white px-2 py-1 rounded border border-slate-100">
                                            TO: {Array.isArray(p.roles) ? p.roles.join(', ') : (p.roles || 'public')}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button onClick={() => deletePolicy(table.name, p.policyname)} className="p-2 text-slate-300 hover:text-rose-600 transition-colors bg-white rounded-lg shadow-sm"><Trash2 size={16}/></button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )
            })}
            
            {tables.length === 0 && !loading && (
                <div className="text-center py-20 text-slate-400 font-bold text-sm uppercase tracking-widest">No public tables found</div>
            )}
        </div>
    </div>
  );
};

// HELPER: Smart Input for Rate Limit
const SmartLimitInput: React.FC<{ 
    label: string; 
    value: string | number; 
    onChange: (val: string | number) => void;
    color?: string;
}> = ({ label, value, onChange, color = 'slate' }) => {
    const isInf = value === 'inf' || value === -1;
    
    return (
        <div className="flex flex-col gap-1">
            <label className="text-[9px] font-bold text-slate-400 uppercase">{label}</label>
            <div className={`flex items-center bg-white border rounded-xl overflow-hidden focus-within:ring-2 focus-within:ring-indigo-500/20 transition-all ${isInf ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200'}`}>
                <input 
                    type={isInf ? "text" : "number"}
                    value={isInf ? "∞" : value}
                    onChange={(e) => onChange(e.target.value)}
                    className={`w-full p-3 text-xs font-bold outline-none bg-transparent ${isInf ? 'text-emerald-600 text-center text-lg' : `text-${color}-600 pl-3`}`}
                    disabled={isInf}
                />
                <button 
                    onClick={() => onChange(isInf ? 10 : 'inf')}
                    className={`p-3 transition-colors hover:bg-slate-100 ${isInf ? 'text-emerald-600' : 'text-slate-300'}`}
                    title="Toggle Infinity (Unlimited)"
                >
                    <InfinityIcon size={14}/>
                </button>
            </div>
        </div>
    );
};

// --- HARD SECURITY TAB (TRAFFIC GUARD & API KEYS) ---
const HardSecurityTab: React.FC<{ projectId: string }> = ({ projectId }) => {
    const [limits, setLimits] = useState<any[]>([]);
    const [keyGroups, setKeyGroups] = useState<any[]>([]); 
    const [apiKeys, setApiKeys] = useState<any[]>([]); 
    const [loading, setLoading] = useState(true);
    const [status, setStatus] = useState({ current_rps: 0, panic_mode: false });
    
    // SMART MODAL STATE (Rules)
    const [showSmartModal, setShowSmartModal] = useState(false);
    const [activeModalTab, setActiveModalTab] = useState<'anon' | 'auth' | 'groups'>('anon');
    
    // API KEY MODAL STATE
    const [showCreateKeyModal, setShowCreateKeyModal] = useState(false);
    const [newKeyForm, setNewKeyForm] = useState({ name: '', groupId: '', days: 30 });
    const [createdKeySecret, setCreatedKeySecret] = useState<string | null>(null);

    // MIGRATION MODAL
    const [migrationModal, setMigrationModal] = useState<{ active: boolean, keyId: string, currentGroup: string }>({ active: false, keyId: '', currentGroup: '' });
    const [migrationPassword, setMigrationPassword] = useState('');
    const [migrationTargetGroup, setMigrationTargetGroup] = useState('');

    // Rule Config
    const [targetType, setTargetType] = useState<'global' | 'table' | 'rpc' | 'auth'>('global');
    const [targetEntity, setTargetEntity] = useState('');
    const [availableTables, setAvailableTables] = useState<string[]>([]);
    const [availableRPCs, setAvailableRPCs] = useState<string[]>([]);
    const [preset, setPreset] = useState<'strict' | 'normal' | 'high' | 'custom'>('normal');
    
    // Granular Limits (Anon/Auth)
    const [rateAnon, setRateAnon] = useState(10);
    const [burstAnon, setBurstAnon] = useState(5);
    const [rateAuth, setRateAuth] = useState(50);
    const [burstAuth, setBurstAuth] = useState(25);
    const [windowSec, setWindowSec] = useState(1);
    
    // Custom Messages
    const [msgAnon, setMsgAnon] = useState('');
    const [msgAuth, setMsgAuth] = useState('');
    
    // CRUD Operation Limits
    const [crudRatesAnon, setCrudRatesAnon] = useState<any>({ create: 10, read: 20, update: 10, delete: 5 });
    const [crudRatesAuth, setCrudRatesAuth] = useState<any>({ create: 50, read: 100, update: 50, delete: 20 });

    // GROUP CONFIG STATE
    const [groupLimits, setGroupLimits] = useState<Record<string, any>>({});
    const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
    const [newGroupName, setNewGroupName] = useState('');
    
    // STATE FOR EDIT MODE
    const [editingGroupId, setEditingGroupId] = useState<string | null>(null);

    const [newGroupConfig, setNewGroupConfig] = useState<any>({
        rate: 100, burst: 50, seconds: 1, 
        message: '', 
        nerf: { enabled: false, delay: 600, mode: 'speed', stop_after: -1 } 
    });

    const [executing, setExecuting] = useState(false);
    const [expandedGroup, setExpandedGroup] = useState<string | null>(null); // For Accordion

    // Initial Fetch
    const fetchData = async () => {
        setLoading(true);
        try {
            const token = localStorage.getItem('cascata_token');
            const headers = { 'Authorization': `Bearer ${token}` };
            
            const [limitsRes, statusRes, groupsRes, keysRes] = await Promise.all([
                fetch(`/api/data/${projectId}/rate-limits`, { headers }),
                fetch(`/api/data/${projectId}/security/status`, { headers }),
                fetch(`/api/data/${projectId}/security/key-groups`, { headers }),
                fetch(`/api/data/${projectId}/api-keys`, { headers })
            ]);
            setLimits(await limitsRes.json());
            setStatus(await statusRes.json());
            setKeyGroups(await groupsRes.json());
            setApiKeys(await keysRes.json());
        } catch (e) { console.error("Error fetching security data"); }
        finally { setLoading(false); }
    };

    // Populate Dropdowns on Open
    useEffect(() => {
        if (showSmartModal && (targetType === 'table' || targetType === 'rpc')) {
            const loadEntities = async () => {
                const headers = { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` };
                const [tblRes, fnRes] = await Promise.all([
                    fetch(`/api/data/${projectId}/tables`, { headers }),
                    fetch(`/api/data/${projectId}/functions`, { headers })
                ]);
                const tblData = await tblRes.json();
                const fnData = await fnRes.json();
                setAvailableTables(tblData.map((t: any) => t.name));
                setAvailableRPCs(fnData.map((f: any) => f.name));
            };
            loadEntities();
        }
    }, [showSmartModal, targetType]);

    // Polling Status
    useEffect(() => { 
        fetchData(); 
        const interval = setInterval(async () => {
            try {
                const res = await fetch(`/api/data/${projectId}/security/status`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` } });
                const data = await res.json();
                setStatus(prev => ({ ...prev, current_rps: data.current_rps, panic_mode: data.panic_mode })); 
            } catch(e) {}
        }, 2000);
        return () => clearInterval(interval);
    }, [projectId]);

    const handleCreateGroup = async () => {
        if (!newGroupName) return;
        try {
            const endpoint = editingGroupId 
                ? `/api/data/${projectId}/security/key-groups/${editingGroupId}`
                : `/api/data/${projectId}/security/key-groups`;
            
            const method = editingGroupId ? 'PATCH' : 'POST';

            const res = await fetch(endpoint, {
                method: method,
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
                body: JSON.stringify({ 
                    name: newGroupName,
                    rate_limit: newGroupConfig.rate,
                    burst_limit: newGroupConfig.burst,
                    window_seconds: newGroupConfig.seconds,
                    rejection_message: newGroupConfig.message,
                    nerf_config: {
                        enabled: newGroupConfig.nerf.enabled,
                        start_delay_seconds: newGroupConfig.nerf.delay,
                        mode: newGroupConfig.nerf.mode,
                        stop_after_seconds: newGroupConfig.nerf.stop_after
                    }
                })
            });
            const data = await res.json();
            
            if (editingGroupId) {
                setKeyGroups(prev => prev.map(g => g.id === editingGroupId ? data : g));
            } else {
                setKeyGroups(prev => [...prev, data]);
                // Auto-Add to Group Limits map if in Smart Modal
                if (showSmartModal && activeModalTab === 'groups') {
                    handleAddGroupToRule(data.id);
                }
            }

            setShowCreateGroupModal(false);
            setEditingGroupId(null);
            setNewGroupName('');
            setNewGroupConfig({ rate: 100, burst: 50, seconds: 1, message: '', nerf: { enabled: false, delay: 600, mode: 'speed', stop_after: -1 } });
        } catch (e) { alert("Failed to save group"); }
    };

    const openEditGroupModal = (group: any) => {
        setEditingGroupId(group.id);
        setNewGroupName(group.name);
        setNewGroupConfig({
            rate: group.rate_limit,
            burst: group.burst_limit,
            seconds: group.window_seconds,
            message: group.rejection_message || '',
            nerf: group.nerf_config || { enabled: false, delay: 600, mode: 'speed', stop_after: -1 }
        });
        setShowCreateGroupModal(true);
    };

    const handleAddGroupToRule = (groupId: string) => {
        if (!groupId) return;
        if (groupLimits[groupId]) return; // Already added
        
        // VISUAL INHERITANCE: Use defaults from group definition
        const groupDef = keyGroups.find(g => g.id === groupId);
        
        setGroupLimits(prev => ({
            ...prev,
            [groupId]: { 
                rate: groupDef?.rate_limit || 50, 
                burst: groupDef?.burst_limit || 25, 
                // Only load CRUD defaults if they exist, else default structure
                crud: groupDef?.crud_limits || { create: -1, read: -1, update: -1, delete: -1 } 
            }
        }));
    };

    const handleRemoveGroupFromRule = (groupId: string) => {
        const next = { ...groupLimits };
        delete next[groupId];
        setGroupLimits(next);
    };

    const handleDeploySmartRule = async () => {
        let routePattern = '*';
        let method = 'ALL';

        if (targetType === 'global') routePattern = '*';
        else if (targetType === 'auth') routePattern = 'auth:*';
        else if (targetType === 'table') {
            if (!targetEntity) { alert("Select a table."); return; }
            routePattern = `table:${targetEntity}`;
        }
        else if (targetType === 'rpc') {
            if (!targetEntity) { alert("Select a function."); return; }
            routePattern = `rpc:${targetEntity}`;
            method = 'POST'; // RPCs usually POST
        }

        const parseInf = (val: string | number) => val === 'inf' ? -1 : Number(val);
        const cleanCrud = (obj: any) => {
            const res: any = {};
            for (const key in obj) res[key] = parseInf(obj[key]);
            return res;
        };

        const finalCrudLimits = targetType === 'table' ? {
            anon: cleanCrud(crudRatesAnon),
            auth: cleanCrud(crudRatesAuth)
        } : undefined;

        // Process Group Limits
        const finalGroupLimits: any = {};
        for(const gid in groupLimits) {
            finalGroupLimits[gid] = {
                rate: parseInt(groupLimits[gid].rate),
                burst: parseInt(groupLimits[gid].burst),
                // Only include CRUD limits if target is a table
                crud: targetType === 'table' ? cleanCrud(groupLimits[gid].crud) : undefined
            };
        }

        setExecuting(true);
        try {
            await fetch(`/api/data/${projectId}/rate-limits`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` 
                },
                body: JSON.stringify({
                    route_pattern: routePattern,
                    method,
                    rate_limit_anon: rateAnon,
                    burst_limit_anon: burstAnon,
                    rate_limit_auth: rateAuth,
                    burst_limit_auth: burstAuth,
                    window_seconds: windowSec,
                    message_anon: msgAnon,
                    message_auth: msgAuth,
                    crud_limits: finalCrudLimits,
                    group_limits: finalGroupLimits
                })
            });
            setShowSmartModal(false);
            setGroupLimits({});
            fetchData();
        } catch (e) { alert("Failed to deploy rule."); }
        finally { setExecuting(false); }
    };

    const openEditRuleModal = (rule: any) => {
        // 1. Determine Target Type & Entity from Route Pattern
        let type: 'global' | 'table' | 'rpc' | 'auth' = 'global';
        let entity = '';

        if (rule.route_pattern === '*') {
            type = 'global';
        } else if (rule.route_pattern === 'auth:*') {
            type = 'auth';
        } else if (rule.route_pattern.startsWith('table:')) {
            type = 'table';
            entity = rule.route_pattern.replace('table:', '');
        } else if (rule.route_pattern.startsWith('rpc:')) {
            type = 'rpc';
            entity = rule.route_pattern.replace('rpc:', '');
        }

        setTargetType(type);
        setTargetEntity(entity);
        setPreset('custom');

        // 2. Populate Limits
        setRateAnon(rule.rate_limit_anon || rule.rate_limit);
        setBurstAnon(rule.burst_limit_anon || rule.burst_limit);
        setRateAuth(rule.rate_limit_auth || rule.rate_limit * 2);
        setBurstAuth(rule.burst_limit_auth || rule.burst_limit * 2);
        setWindowSec(rule.window_seconds || 1);
        setMsgAnon(rule.message_anon || '');
        setMsgAuth(rule.message_auth || '');

        // 3. Populate CRUD Limits
        if (rule.crud_limits) {
            if (rule.crud_limits.anon) setCrudRatesAnon(rule.crud_limits.anon);
            if (rule.crud_limits.auth) setCrudRatesAuth(rule.crud_limits.auth);
        }

        // 4. Populate Group Limits
        if (rule.group_limits) {
            setGroupLimits(rule.group_limits);
        } else {
            setGroupLimits({});
        }

        // 5. Open Modal
        setShowSmartModal(true);
        setActiveModalTab('anon');
    };

    const handleDeleteRule = async (id: string) => {
        if (!confirm("Remove protection?")) return;
        await fetch(`/api/data/${projectId}/rate-limits/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
        });
        fetchData();
    };

    const handleCreateKey = async () => {
        // Name is optional now
        setExecuting(true);
        try {
            const res = await fetch(`/api/data/${projectId}/api-keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
                body: JSON.stringify({
                    name: newKeyForm.name || `Key ${new Date().toISOString().split('T')[0]}`,
                    group_id: newKeyForm.groupId || null,
                    expires_in_days: newKeyForm.days
                })
            });
            const data = await res.json();
            setCreatedKeySecret(data.secret);
            setNewKeyForm({ name: '', groupId: '', days: 30 });
            // Don't close modal yet, wait for user to copy secret
            fetchData();
        } catch(e) { alert("Failed to create key"); }
        finally { setExecuting(false); }
    };

    const handleDeleteKey = async (id: string) => {
        if (!confirm("Revoke this key?")) return;
        try {
            await fetch(`/api/data/${projectId}/api-keys/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
            });
            fetchData();
        } catch(e) {}
    };

    const handleUpdateExpiry = async (id: string, days: number) => {
        const newDate = new Date();
        newDate.setDate(newDate.getDate() + days);
        try {
            await fetch(`/api/data/${projectId}/api-keys/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
                body: JSON.stringify({ expires_at: newDate.toISOString() })
            });
            fetchData();
        } catch(e) {}
    };

    const handleMigrateKey = async () => {
        if (!migrationPassword) return;
        setExecuting(true);
        try {
            const res = await fetch(`/api/data/${projectId}/api-keys/${migrationModal.keyId}/migrate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
                body: JSON.stringify({ password: migrationPassword, group_id: migrationTargetGroup || null })
            });
            if (!res.ok) throw new Error("Senha incorreta");
            setMigrationModal({ active: false, keyId: '', currentGroup: '' });
            setMigrationPassword('');
            fetchData();
        } catch(e: any) { alert(e.message); }
        finally { setExecuting(false); }
    };

    const togglePanicMode = async () => {
        if (!confirm(status.panic_mode ? "DISABLE Panic Mode?" : "ENABLE Panic Mode? (Immediate Block)")) return;
        setExecuting(true);
        try {
            await fetch(`/api/data/${projectId}/security/panic`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
                body: JSON.stringify({ enabled: !status.panic_mode })
            });
            setStatus(p => ({...p, panic_mode: !p.panic_mode}));
        } catch (e) { alert("Panic failed"); }
        finally { setExecuting(false); }
    };

    // Helper to auto-fill limits based on preset
    useEffect(() => {
        if (preset === 'strict') { setRateAnon(2); setBurstAnon(0); setRateAuth(10); setBurstAuth(5); setWindowSec(1); }
        else if (preset === 'normal') { setRateAnon(10); setBurstAnon(5); setRateAuth(50); setBurstAuth(25); setWindowSec(1); }
        else if (preset === 'high') { setRateAnon(50); setBurstAnon(50); setRateAuth(200); setBurstAuth(100); setWindowSec(1); }
    }, [preset]);

    // Grouping Keys for Display
    const groupedKeys = useMemo(() => {
        const groups: Record<string, any[]> = {};
        // Initialize with empty arrays for all groups to show empty groups
        keyGroups.forEach(g => { groups[g.id] = []; });
        groups['uncategorized'] = [];

        apiKeys.forEach(k => {
            const gid = k.group_id || 'uncategorized';
            if (!groups[gid]) groups[gid] = [];
            groups[gid].push(k);
        });
        return groups;
    }, [apiKeys, keyGroups]);

    return (
        <div className="p-10 max-w-6xl mx-auto space-y-10 pb-40">
            {/* PANIC & STATUS DASHBOARD */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className={`rounded-[2.5rem] p-8 text-white relative overflow-hidden shadow-2xl transition-all ${status.panic_mode ? 'bg-rose-600' : 'bg-slate-900'}`}>
                    <div className="relative z-10">
                        <div className="flex items-center gap-3 mb-4">
                            <ShieldCheck size={20} className={status.panic_mode ? 'animate-bounce' : 'text-emerald-400'} />
                            <span className="text-[10px] font-black uppercase tracking-widest">{status.panic_mode ? 'SYSTEM LOCKDOWN' : 'ACTIVE PROTECTION'}</span>
                        </div>
                        <h3 className="text-3xl font-black tracking-tight">{status.panic_mode ? 'PANIC ON' : 'SECURE'}</h3>
                        <p className="text-xs opacity-70 mt-2 font-medium">
                            {status.panic_mode ? 'All external traffic blocked by Redis.' : `${limits.length} active traffic rules.`}
                        </p>
                    </div>
                </div>

                <div className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm">
                    <div className="flex justify-between items-end mb-4">
                        <h4 className="text-slate-500 font-bold text-xs uppercase tracking-widest">Global Load</h4>
                        <span className="text-xs font-black text-indigo-600">{status.current_rps} RPS</span>
                    </div>
                    <div className="w-full bg-slate-100 h-4 rounded-full overflow-hidden relative">
                        {/* Normalized to 100 RPS for visualization cap */}
                        <div className="h-full bg-indigo-600 transition-all duration-500 ease-out" style={{ width: `${Math.min((status.current_rps/100)*100, 100)}%` }}></div>
                    </div>
                </div>

                <button 
                    onClick={togglePanicMode}
                    disabled={executing}
                    className={`rounded-[2.5rem] p-8 flex flex-col justify-center items-center transition-all ${status.panic_mode ? 'bg-white border-4 border-rose-600 text-rose-600' : 'bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-100'}`}
                >
                    <Siren size={32} className={status.panic_mode ? 'animate-pulse' : ''} />
                    <span className="font-black text-sm uppercase tracking-widest mt-2">{status.panic_mode ? 'DISABLE PANIC' : 'ENABLE PANIC'}</span>
                </button>
            </div>

            {/* RULES LIST */}
            <div className="space-y-6">
                <div className="flex items-center justify-between">
                    <h3 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-3">
                        <Gauge size={20} className="text-indigo-600"/> Traffic Rules
                    </h3>
                    <button onClick={() => { setShowSmartModal(true); setTargetType('global'); setActiveModalTab('anon'); setGroupLimits({}); }} className="bg-indigo-600 text-white px-6 py-3 rounded-xl font-black text-xs uppercase tracking-widest shadow-lg hover:bg-indigo-700 transition-all flex items-center gap-2">
                        <Plus size={16}/> New Rule
                    </button>
                </div>

                <div className="bg-white border border-slate-200 rounded-[3rem] shadow-sm overflow-hidden">
                    <table className="w-full text-left">
                        <thead className="bg-slate-50 border-b border-slate-100 text-[10px] font-black text-slate-400 uppercase tracking-widest">
                            <tr>
                                <th className="px-8 py-6">Resource</th>
                                <th className="px-8 py-6">Anon Limit</th>
                                <th className="px-8 py-6">Auth Limit</th>
                                <th className="px-8 py-6">Custom Groups</th>
                                <th className="px-8 py-6 text-right">Action</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                            {limits.map(l => (
                                <tr key={l.id} className="group hover:bg-slate-50/50">
                                    <td className="px-8 py-6">
                                        <div className="flex flex-col gap-1">
                                            <div className="flex items-center gap-3">
                                                {l.route_pattern === '*' ? <Globe size={16} className="text-indigo-500"/> : l.route_pattern.includes('rpc:') ? <Zap size={16} className="text-amber-500"/> : l.route_pattern.includes('auth:') ? <Lock size={16} className="text-rose-500"/> : <Database size={16} className="text-emerald-500"/>}
                                                <code className="text-xs font-bold text-slate-700 bg-slate-100 px-2 py-1 rounded">{l.route_pattern}</code>
                                            </div>
                                            {l.crud_limits && Object.keys(l.crud_limits).length > 0 && <span className="text-[9px] font-black text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded w-fit ml-8">GRANULAR CRUD ACTIVE</span>}
                                        </div>
                                    </td>
                                    <td className="px-8 py-6">
                                        <span className="text-xs font-bold text-slate-500">{l.rate_limit_anon || l.rate_limit} reqs</span>
                                        <span className="text-[10px] text-slate-400 block">+ {l.burst_limit_anon || l.burst_limit} burst</span>
                                    </td>
                                    <td className="px-8 py-6">
                                        <span className="text-xs font-black text-indigo-900">{l.rate_limit_auth || l.rate_limit * 2} reqs</span>
                                        <span className="text-[10px] text-indigo-400 block">+ {l.burst_limit_auth || l.burst_limit * 2} burst</span>
                                    </td>
                                    <td className="px-8 py-6">
                                        {l.group_limits && Object.keys(l.group_limits).length > 0 ? (
                                            <div className="flex gap-1 flex-wrap">
                                                {Object.keys(l.group_limits).map(gid => {
                                                    const groupName = keyGroups.find(g => g.id === gid)?.name || 'Unknown Group';
                                                    return (
                                                        <span key={gid} className="text-[9px] bg-slate-100 text-slate-600 px-2 py-1 rounded font-bold">{groupName}</span>
                                                    )
                                                })}
                                            </div>
                                        ) : (
                                            <span className="text-[10px] text-slate-300 italic">None</span>
                                        )}
                                    </td>
                                    <td className="px-8 py-6 text-right flex gap-2 justify-end">
                                        <button onClick={() => handleDeleteRule(l.id)} className="text-slate-300 hover:text-rose-600"><Trash2 size={16}/></button>
                                        <button onClick={() => openEditRuleModal(l)} className="text-slate-300 hover:text-indigo-600" title="Edit Rule"><Edit3 size={16}/></button>
                                    </td>
                                </tr>
                            ))}
                            {limits.length === 0 && <tr><td colSpan={5} className="py-10 text-center text-slate-400 font-bold text-xs uppercase">No active rules</td></tr>}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* ACCESS CREDENTIALS (GROUPED) */}
            <div className="space-y-6">
                <div className="flex items-center justify-between">
                    <h3 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-3">
                        <Key size={20} className="text-emerald-600"/> Access Credentials
                    </h3>
                    <div className="flex gap-2">
                        <button onClick={() => { setEditingGroupId(null); setShowCreateGroupModal(true); setNewGroupName(''); setNewGroupConfig({ rate: 100, burst: 50, seconds: 1, message: '', nerf: { enabled: false, delay: 600, mode: 'speed', stop_after: -1 } }); }} className="bg-slate-100 text-slate-600 px-4 py-3 rounded-xl font-black text-xs uppercase tracking-widest hover:bg-slate-200 transition-all flex items-center gap-2">
                            <Plus size={14}/> Group
                        </button>
                        <button onClick={() => setShowCreateKeyModal(true)} className="bg-emerald-600 text-white px-6 py-3 rounded-xl font-black text-xs uppercase tracking-widest shadow-lg hover:bg-emerald-700 transition-all flex items-center gap-2">
                            <Plus size={14}/> Key
                        </button>
                    </div>
                </div>

                <div className="space-y-4">
                    {/* Uncategorized First */}
                    {groupedKeys['uncategorized'] && groupedKeys['uncategorized'].length > 0 && (
                        <div className="bg-white border border-slate-200 rounded-[2.5rem] p-6 shadow-sm">
                            <h4 className="text-xs font-black uppercase text-slate-400 mb-4 px-2">Unmanaged Keys</h4>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                {groupedKeys['uncategorized'].map(k => (
                                    <KeyCard key={k.id} k={k} group={null} onMigrate={() => setMigrationModal({ active: true, keyId: k.id, currentGroup: 'uncategorized' })} onDelete={() => handleDeleteKey(k.id)} onExtend={(days) => handleUpdateExpiry(k.id, days)} />
                                ))}
                            </div>
                        </div>
                    )}

                    {keyGroups.map(group => (
                        <div key={group.id} className="bg-white border border-slate-200 rounded-[2.5rem] overflow-hidden shadow-sm transition-all hover:shadow-md">
                            <div 
                                onClick={() => setExpandedGroup(expandedGroup === group.id ? null : group.id)}
                                className="p-6 flex justify-between items-center cursor-pointer bg-slate-50/50 hover:bg-slate-50"
                            >
                                <div className="flex items-center gap-4">
                                    <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-xl flex items-center justify-center font-bold">
                                        {group.name[0].toUpperCase()}
                                    </div>
                                    <div>
                                        <h4 className="font-bold text-sm text-slate-800">{group.name}</h4>
                                        <p className="text-[10px] text-slate-400 font-medium">
                                            Limit: {group.rate_limit}/s • Burst: {group.burst_limit} • {groupedKeys[group.id]?.length || 0} Keys
                                        </p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-3">
                                    {group.nerf_config?.enabled && <span className="text-[9px] font-black bg-amber-100 text-amber-700 px-2 py-1 rounded border border-amber-200 flex items-center gap-1"><AlertTriangle size={10}/> NERF ACTIVE</span>}
                                    <button onClick={(e) => { e.stopPropagation(); openEditGroupModal(group); }} className="p-2 text-slate-300 hover:text-indigo-600"><Edit3 size={16}/></button>
                                    {expandedGroup === group.id ? <ChevronDown size={20} className="text-slate-400"/> : <ChevronRight size={20} className="text-slate-400"/>}
                                </div>
                            </div>

                            {expandedGroup === group.id && (
                                <div className="p-6 border-t border-slate-100 bg-white animate-in slide-in-from-top-2">
                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                        {groupedKeys[group.id]?.map(k => (
                                            <KeyCard key={k.id} k={k} group={group} onMigrate={() => setMigrationModal({ active: true, keyId: k.id, currentGroup: group.id })} onDelete={() => handleDeleteKey(k.id)} onExtend={(days) => handleUpdateExpiry(k.id, days)} />
                                        ))}
                                        {(!groupedKeys[group.id] || groupedKeys[group.id].length === 0) && (
                                            <div className="col-span-full text-center py-8 text-slate-300 text-xs italic">No keys in this group.</div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            </div>

            {/* SMART MODAL */}
            {showSmartModal && (
                <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
                    <div className="bg-white rounded-[3rem] w-full max-w-4xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]">
                        <header className="p-8 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                            <div className="flex items-center gap-4">
                                <div className="w-12 h-12 bg-indigo-600 text-white rounded-2xl flex items-center justify-center shadow-lg"><ShieldAlert size={24}/></div>
                                <div><h3 className="text-2xl font-black text-slate-900 tracking-tighter">Traffic Guard</h3><p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Intelligent Rate Limiter</p></div>
                            </div>
                            <button onClick={() => setShowSmartModal(false)} className="p-3 bg-white hover:bg-slate-100 rounded-full transition-all text-slate-400"><X size={20}/></button>
                        </header>

                        <div className="flex-1 overflow-y-auto p-10 grid grid-cols-1 lg:grid-cols-2 gap-12">
                            {/* LEFT: TARGET SELECTION */}
                            <div className="space-y-8">
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 block">1. What to Protect?</label>
                                    <div className="grid grid-cols-2 gap-3">
                                        {[
                                            { id: 'global', label: 'Global API', icon: Globe },
                                            { id: 'auth', label: 'Auth Routes', icon: Lock },
                                            { id: 'table', label: 'Specific Table', icon: Database },
                                            { id: 'rpc', label: 'RPC Function', icon: Zap },
                                        ].map(t => (
                                            <button key={t.id} onClick={() => { setTargetType(t.id as any); setTargetEntity(''); }} className={`p-4 rounded-2xl border text-left transition-all group ${targetType === t.id ? 'bg-indigo-600 border-indigo-600 text-white shadow-xl' : 'bg-white border-slate-200 hover:border-indigo-300'}`}>
                                                <t.icon size={20} className={`mb-2 ${targetType === t.id ? 'text-white' : 'text-slate-400 group-hover:text-indigo-500'}`} />
                                                <span className="text-xs font-black uppercase tracking-widest block">{t.label}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {(targetType === 'table' || targetType === 'rpc') && (
                                    <div className="animate-in fade-in slide-in-from-top-2">
                                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Select {targetType === 'table' ? 'Table' : 'Function'}</label>
                                        <select 
                                            value={targetEntity} 
                                            onChange={(e) => setTargetEntity(e.target.value)}
                                            className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-sm font-bold text-slate-900 outline-none focus:ring-4 focus:ring-indigo-500/10"
                                        >
                                            <option value="">-- Choose Target --</option>
                                            {(targetType === 'table' ? availableTables : availableRPCs).map(name => (
                                                <option key={name} value={name}>{name}</option>
                                            ))}
                                        </select>
                                    </div>
                                )}
                            </div>

                            {/* RIGHT: RULES */}
                            <div className="space-y-6">
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 block">2. Security Level</label>
                                    <div className="flex bg-slate-100 p-1 rounded-2xl border border-slate-200 mb-6 shadow-sm">
                                        {['strict', 'normal', 'high', 'custom'].map(p => (
                                            <button key={p} onClick={() => setPreset(p as any)} className={`flex-1 py-3 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all ${preset === p ? 'bg-white text-indigo-600 shadow' : 'text-slate-400 hover:text-slate-600'}`}>
                                                {p}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* TABS FOR GRANULAR CONFIG */}
                                <div className="bg-slate-50 rounded-[2.5rem] p-6 border border-slate-100">
                                    <div className="flex border-b border-slate-200 mb-6">
                                        <button onClick={() => setActiveModalTab('anon')} className={`flex-1 py-2 text-[10px] font-black uppercase tracking-widest ${activeModalTab === 'anon' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-slate-400'}`}>Anonymous</button>
                                        <button onClick={() => setActiveModalTab('auth')} className={`flex-1 py-2 text-[10px] font-black uppercase tracking-widest ${activeModalTab === 'auth' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-slate-400'}`}>Authenticated</button>
                                        <button onClick={() => setActiveModalTab('groups')} className={`flex-1 py-2 text-[10px] font-black uppercase tracking-widest ${activeModalTab === 'groups' ? 'text-emerald-600 border-b-2 border-emerald-600' : 'text-slate-400'}`}>Key Groups</button>
                                    </div>

                                    {activeModalTab === 'anon' && (
                                        <div className="space-y-4 animate-in fade-in">
                                            <div className="grid grid-cols-3 gap-4">
                                                <div><label className="text-[9px] font-bold text-slate-400 uppercase">Rate</label><input type="number" value={rateAnon} onChange={e => setRateAnon(parseInt(e.target.value))} className="w-full p-3 rounded-xl border border-slate-200 font-bold text-center"/></div>
                                                <div><label className="text-[9px] font-bold text-slate-400 uppercase">Burst</label><input type="number" value={burstAnon} onChange={e => setBurstAnon(parseInt(e.target.value))} className="w-full p-3 rounded-xl border border-slate-200 font-bold text-center"/></div>
                                                <div><label className="text-[9px] font-bold text-slate-400 uppercase">Seconds</label><input type="number" value={windowSec} onChange={e => setWindowSec(parseInt(e.target.value))} className="w-full p-3 rounded-xl border border-slate-200 font-bold text-center"/></div>
                                            </div>
                                            
                                            {targetType === 'table' && (
                                                <div className="bg-white p-4 rounded-2xl border border-slate-100 mt-4">
                                                    <h4 className="text-[10px] font-black uppercase text-indigo-400 mb-3 tracking-widest">Advanced CRUD Limits</h4>
                                                    <div className="grid grid-cols-2 gap-3">
                                                        <SmartLimitInput label="Create (POST)" value={crudRatesAnon.create} onChange={v => setCrudRatesAnon({...crudRatesAnon, create: v})} color="emerald"/>
                                                        <SmartLimitInput label="Read (GET)" value={crudRatesAnon.read} onChange={v => setCrudRatesAnon({...crudRatesAnon, read: v})} color="blue"/>
                                                        <SmartLimitInput label="Update (PATCH)" value={crudRatesAnon.update} onChange={v => setCrudRatesAnon({...crudRatesAnon, update: v})} color="amber"/>
                                                        <SmartLimitInput label="Delete (DEL)" value={crudRatesAnon.delete} onChange={v => setCrudRatesAnon({...crudRatesAnon, delete: v})} color="rose"/>
                                                    </div>
                                                </div>
                                            )}

                                            <input value={msgAnon} onChange={e => setMsgAnon(e.target.value)} placeholder="Rejection Message (Optional)..." className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-xs font-medium outline-none" />
                                        </div>
                                    )}

                                    {activeModalTab === 'auth' && (
                                        <div className="space-y-4 animate-in fade-in">
                                            <div className="grid grid-cols-3 gap-4">
                                                <div><label className="text-[9px] font-bold text-slate-400 uppercase">Rate</label><input type="number" value={rateAuth} onChange={e => setRateAuth(parseInt(e.target.value))} className="w-full p-3 rounded-xl border border-slate-200 font-bold text-center text-indigo-700 bg-indigo-50"/></div>
                                                <div><label className="text-[9px] font-bold text-slate-400 uppercase">Burst</label><input type="number" value={burstAuth} onChange={e => setBurstAuth(parseInt(e.target.value))} className="w-full p-3 rounded-xl border border-slate-200 font-bold text-center text-indigo-700 bg-indigo-50"/></div>
                                                <div><label className="text-[9px] font-bold text-slate-400 uppercase">Seconds</label><input type="number" value={windowSec} onChange={e => setWindowSec(parseInt(e.target.value))} className="w-full p-3 rounded-xl border border-slate-200 font-bold text-center"/></div>
                                            </div>

                                            {targetType === 'table' && (
                                                <div className="bg-white p-4 rounded-2xl border border-slate-100 mt-4">
                                                    <h4 className="text-[10px] font-black uppercase text-indigo-400 mb-3 tracking-widest">Advanced CRUD Limits</h4>
                                                    <div className="grid grid-cols-2 gap-3">
                                                        <SmartLimitInput label="Create (POST)" value={crudRatesAuth.create} onChange={v => setCrudRatesAuth({...crudRatesAuth, create: v})} color="emerald"/>
                                                        <SmartLimitInput label="Read (GET)" value={crudRatesAuth.read} onChange={v => setCrudRatesAuth({...crudRatesAuth, read: v})} color="blue"/>
                                                        <SmartLimitInput label="Update (PATCH)" value={crudRatesAuth.update} onChange={v => setCrudRatesAuth({...crudRatesAuth, update: v})} color="amber"/>
                                                        <SmartLimitInput label="Delete (DEL)" value={crudRatesAuth.delete} onChange={v => setCrudRatesAuth({...crudRatesAuth, delete: v})} color="rose"/>
                                                    </div>
                                                </div>
                                            )}

                                            <input value={msgAuth} onChange={e => setMsgAuth(e.target.value)} placeholder="Rejection Message (Optional)..." className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-xs font-medium outline-none" />
                                        </div>
                                    )}

                                    {activeModalTab === 'groups' && (
                                        <div className="space-y-4 animate-in fade-in">
                                            <div className="flex gap-2">
                                                <select onChange={(e) => handleAddGroupToRule(e.target.value)} className="flex-1 bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold outline-none cursor-pointer">
                                                    <option value="">+ Add Group to Rule</option>
                                                    {keyGroups.map(g => (
                                                        <option key={g.id} value={g.id}>{g.name}</option>
                                                    ))}
                                                </select>
                                                <button onClick={() => setShowCreateGroupModal(true)} className="p-2 bg-slate-900 text-white rounded-xl hover:bg-indigo-600 transition-colors"><Plus size={14}/></button>
                                            </div>

                                            <div className="space-y-3 max-h-[250px] overflow-y-auto">
                                                {Object.keys(groupLimits).length === 0 && <p className="text-[10px] text-slate-400 text-center py-4">No groups attached to this rule.</p>}
                                                
                                                {Object.keys(groupLimits).map(gid => {
                                                    const groupName = keyGroups.find(g => g.id === gid)?.name || 'Unknown';
                                                    const limits = groupLimits[gid];
                                                    
                                                    return (
                                                        <div key={gid} className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm relative">
                                                            <div className="flex justify-between items-center mb-3">
                                                                <h5 className="font-black text-xs text-slate-800">{groupName} <span className="text-[8px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded font-bold uppercase ml-2">Override</span></h5>
                                                                <button onClick={() => handleRemoveGroupFromRule(gid)} className="text-slate-300 hover:text-rose-500"><X size={14}/></button>
                                                            </div>
                                                            <div className="grid grid-cols-2 gap-2 mb-3">
                                                                <div className="flex items-center gap-1"><span className="text-[9px] font-bold text-slate-400 uppercase w-8">Rate</span><input type="number" value={limits.rate} onChange={(e) => setGroupLimits({...groupLimits, [gid]: { ...limits, rate: parseInt(e.target.value) }})} className="w-12 text-center bg-slate-50 rounded border-none text-[10px] font-bold"/></div>
                                                                <div className="flex items-center gap-1"><span className="text-[9px] font-bold text-slate-400 uppercase w-8">Burst</span><input type="number" value={limits.burst} onChange={(e) => setGroupLimits({...groupLimits, [gid]: { ...limits, burst: parseInt(e.target.value) }})} className="w-12 text-center bg-slate-50 rounded border-none text-[10px] font-bold"/></div>
                                                            </div>
                                                            
                                                            {targetType === 'table' && (
                                                                <div className="grid grid-cols-4 gap-1 pt-2 border-t border-slate-100">
                                                                    {['create','read','update','delete'].map(op => (
                                                                        <div key={op} className="flex flex-col items-center">
                                                                            <span className="text-[8px] font-black uppercase text-slate-300 mb-1">{op.substring(0,1)}</span>
                                                                            <input 
                                                                                type="text" 
                                                                                value={limits.crud?.[op] === -1 ? 'inf' : limits.crud?.[op]} 
                                                                                onChange={(e) => {
                                                                                    const val = e.target.value === 'inf' ? -1 : parseInt(e.target.value);
                                                                                    setGroupLimits({...groupLimits, [gid]: { ...limits, crud: { ...(limits.crud || {}), [op]: val } }})
                                                                                }}
                                                                                className="w-full text-center bg-indigo-50 text-indigo-700 rounded border-none text-[9px] font-mono font-bold py-1"
                                                                            />
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        <footer className="p-8 border-t border-slate-100 bg-white flex justify-end gap-4">
                            <button onClick={() => setShowSmartModal(false)} className="px-8 py-4 rounded-2xl text-xs font-black text-slate-400 uppercase tracking-widest hover:bg-slate-50">Cancel</button>
                            <button onClick={handleDeploySmartRule} disabled={executing} className="px-10 py-4 bg-indigo-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest hover:bg-indigo-700 shadow-xl flex items-center gap-2">
                                {executing ? <Loader2 className="animate-spin" size={16}/> : 'Deploy Rules'}
                            </button>
                        </footer>
                    </div>
                </div>
            )}

            {/* CREATE GROUP MODAL - UPGRADED */}
            {showCreateGroupModal && (
                <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[600] flex items-center justify-center p-8 animate-in zoom-in-95">
                    <div className="bg-white rounded-[2rem] w-full max-w-lg p-10 shadow-2xl flex flex-col max-h-[90vh]">
                        <h3 className="font-black text-xl text-slate-900 mb-6">{editingGroupId ? 'Edit Key Group' : 'Create Key Group (Plan)'}</h3>
                        
                        <div className="flex-1 overflow-y-auto pr-2 space-y-6">
                            {/* Basics */}
                            <div className="space-y-2">
                                <label className="text-[10px] font-bold text-slate-400 uppercase">Group Name</label>
                                <input autoFocus value={newGroupName} onChange={e => setNewGroupName(e.target.value)} placeholder="Gold Plan" className="w-full p-4 rounded-xl border border-slate-200 font-bold text-sm outline-none focus:border-indigo-400"/>
                            </div>

                            {/* Base Limits */}
                            <div className="grid grid-cols-3 gap-4">
                                <div>
                                    <label className="text-[9px] font-bold text-slate-400 uppercase">Rate</label>
                                    <input type="number" value={newGroupConfig.rate} onChange={e => setNewGroupConfig({...newGroupConfig, rate: parseInt(e.target.value)})} className="w-full p-3 rounded-xl border border-slate-200 font-bold text-center"/>
                                </div>
                                <div>
                                    <label className="text-[9px] font-bold text-slate-400 uppercase">Burst</label>
                                    <input type="number" value={newGroupConfig.burst} onChange={e => setNewGroupConfig({...newGroupConfig, burst: parseInt(e.target.value)})} className="w-full p-3 rounded-xl border border-slate-200 font-bold text-center"/>
                                </div>
                                <div>
                                    <label className="text-[9px] font-bold text-slate-400 uppercase">Seconds</label>
                                    <input type="number" value={newGroupConfig.seconds} onChange={e => setNewGroupConfig({...newGroupConfig, seconds: parseInt(e.target.value)})} className="w-full p-3 rounded-xl border border-slate-200 font-bold text-center"/>
                                </div>
                            </div>
                            
                            {/* Rejection Msg */}
                            <div className="space-y-2">
                                <label className="text-[10px] font-bold text-slate-400 uppercase">Rejection Message (Optional)</label>
                                <input value={newGroupConfig.message} onChange={e => setNewGroupConfig({...newGroupConfig, message: e.target.value})} placeholder="Upgrade to Gold..." className="w-full p-3 rounded-xl border border-slate-200 text-xs font-medium outline-none"/>
                            </div>

                            {/* NERF LOGIC */}
                            <div className={`p-4 rounded-2xl border transition-all ${newGroupConfig.nerf.enabled ? 'bg-amber-50 border-amber-200' : 'bg-slate-50 border-slate-100'}`}>
                                <div className="flex items-center gap-3 mb-4 cursor-pointer" onClick={() => setNewGroupConfig({...newGroupConfig, nerf: { ...newGroupConfig.nerf, enabled: !newGroupConfig.nerf.enabled }})}>
                                    <div className={`w-5 h-5 rounded border flex items-center justify-center ${newGroupConfig.nerf.enabled ? 'bg-amber-500 border-amber-600' : 'bg-white border-slate-300'}`}>
                                        {newGroupConfig.nerf.enabled && <CheckCircle2 size={12} className="text-white"/>}
                                    </div>
                                    <span className="text-xs font-black uppercase text-slate-700">Nerf / Expiration Policy</span>
                                </div>

                                {newGroupConfig.nerf.enabled && (
                                    <div className="space-y-4 pl-8 animate-in slide-in-from-top-2">
                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <label className="text-[9px] font-bold text-amber-700 uppercase">Tolerância após Vencimento (Segundos)</label>
                                                <input type="number" value={newGroupConfig.nerf.delay} onChange={e => setNewGroupConfig({...newGroupConfig, nerf: { ...newGroupConfig.nerf, delay: parseInt(e.target.value) }})} className="w-full p-2 bg-white border border-amber-200 rounded-lg text-xs font-bold text-center"/>
                                            </div>
                                            <div>
                                                <label className="text-[9px] font-bold text-amber-700 uppercase">Bloqueio Total após (Segundos)</label>
                                                <input type="number" value={newGroupConfig.nerf.stop_after} onChange={e => setNewGroupConfig({...newGroupConfig, nerf: { ...newGroupConfig.nerf, stop_after: parseInt(e.target.value) }})} className="w-full p-2 bg-white border border-amber-200 rounded-lg text-xs font-bold text-center" placeholder="-1 for never"/>
                                            </div>
                                        </div>
                                        <div>
                                            <label className="text-[9px] font-bold text-amber-700 uppercase">Tipo de Punição</label>
                                            <select value={newGroupConfig.nerf.mode} onChange={e => setNewGroupConfig({...newGroupConfig, nerf: { ...newGroupConfig.nerf, mode: e.target.value }})} className="w-full p-2 bg-white border border-amber-200 rounded-lg text-xs font-bold">
                                                <option value="speed">Velocidade Reduzida (Speed Reduction - 10%)</option>
                                                {/* Future: <option value="quota">Request Quota</option> */}
                                            </select>
                                            <p className="text-[9px] text-amber-600 mt-2 italic bg-white/50 p-2 rounded">
                                                A "Velocidade Reduzida" mantém a chave funcionando mas com capacidade limitada a 10% do original. Ideal para não quebrar apps de clientes que esqueceram de renovar.
                                            </p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="flex gap-4 pt-6 mt-4 border-t border-slate-100">
                            <button onClick={() => { setShowCreateGroupModal(false); setEditingGroupId(null); }} className="flex-1 py-3 text-xs font-bold text-slate-500 hover:bg-slate-50 rounded-xl">Cancel</button>
                            <button onClick={handleCreateGroup} className="flex-[2] py-3 bg-indigo-600 text-white rounded-xl text-xs font-black uppercase shadow-lg hover:bg-indigo-700 transition-all">{editingGroupId ? 'Save Changes' : 'Create Group'}</button>
                        </div>
                    </div>
                </div>
            )}

            {/* CREATE API KEY MODAL */}
            {showCreateKeyModal && (
                <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[600] flex items-center justify-center p-8 animate-in zoom-in-95">
                    <div className="bg-white rounded-[2rem] w-full max-w-md p-8 shadow-2xl">
                        {!createdKeySecret ? (
                            <>
                                <h3 className="font-black text-lg text-slate-900 mb-6 flex items-center gap-2"><Key size={18}/> Generate Access Key</h3>
                                <div className="space-y-4 mb-6">
                                    <div className="space-y-1">
                                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Key Label (Optional)</label>
                                        <input autoFocus value={newKeyForm.name} onChange={e => setNewKeyForm({...newKeyForm, name: e.target.value})} placeholder="Client App V2" className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold outline-none"/>
                                    </div>
                                    <div className="space-y-1">
                                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Associated Group (Plan)</label>
                                        <select value={newKeyForm.groupId} onChange={e => setNewKeyForm({...newKeyForm, groupId: e.target.value})} className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-xs font-bold outline-none cursor-pointer">
                                            <option value="">No Group (Unmanaged)</option>
                                            {keyGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                                        </select>
                                    </div>
                                    <div className="space-y-1">
                                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Expiration (Days)</label>
                                        <input type="number" value={newKeyForm.days} onChange={e => setNewKeyForm({...newKeyForm, days: parseInt(e.target.value)})} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold outline-none"/>
                                    </div>
                                </div>
                                <div className="flex gap-2">
                                    <button onClick={() => setShowCreateKeyModal(false)} className="flex-1 py-3 text-xs font-bold text-slate-500 hover:bg-slate-50 rounded-xl">Cancel</button>
                                    <button onClick={handleCreateKey} disabled={executing} className="flex-[2] py-3 bg-emerald-600 text-white rounded-xl text-xs font-black uppercase shadow-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-2">
                                        {executing ? <Loader2 className="animate-spin" size={14}/> : 'Generate Key'}
                                    </button>
                                </div>
                            </>
                        ) : (
                            <div className="text-center">
                                <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-4 animate-in zoom-in"><CheckCircle2 size={32}/></div>
                                <h3 className="font-black text-lg text-slate-900 mb-2">Key Generated!</h3>
                                <p className="text-xs text-slate-500 mb-6 px-4">This secret key will only be shown once. Copy it now.</p>
                                <div className="bg-slate-900 p-4 rounded-xl mb-6 relative group text-left">
                                    <code className="text-emerald-400 font-mono text-xs break-all">{createdKeySecret}</code>
                                    <button onClick={() => navigator.clipboard.writeText(createdKeySecret)} className="absolute top-2 right-2 text-slate-500 hover:text-white p-1"><RefreshCw size={14}/></button>
                                </div>
                                <button onClick={() => { setCreatedKeySecret(null); setShowCreateKeyModal(false); }} className="w-full py-3 bg-slate-100 text-slate-600 rounded-xl text-xs font-bold hover:bg-slate-200">I have copied it</button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* MIGRATION MODAL */}
            {migrationModal.active && (
                <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[800] flex items-center justify-center p-8 animate-in zoom-in-95">
                    <div className="bg-white rounded-[2rem] w-full max-w-sm p-8 shadow-2xl text-center border border-indigo-100">
                        <LockedIcon size={40} className="mx-auto text-indigo-600 mb-4" />
                        <h3 className="text-xl font-black text-slate-900 mb-2">Migrate Key</h3>
                        <p className="text-xs text-slate-500 font-bold mb-6">Move this key to another plan/group.</p>
                        
                        <div className="text-left space-y-4 mb-6">
                             <div className="space-y-1">
                                <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">Target Group</label>
                                <select 
                                    value={migrationTargetGroup} 
                                    onChange={e => setMigrationTargetGroup(e.target.value)}
                                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-xs font-bold outline-none"
                                >
                                    <option value="">Uncategorized (No Group)</option>
                                    {keyGroups.filter(g => g.id !== migrationModal.currentGroup).map(g => (
                                        <option key={g.id} value={g.id}>{g.name}</option>
                                    ))}
                                </select>
                             </div>
                             <div className="space-y-1">
                                <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">Admin Password</label>
                                <input 
                                    type="password"
                                    value={migrationPassword}
                                    onChange={e => setMigrationPassword(e.target.value)}
                                    placeholder="••••••••"
                                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-center font-bold text-slate-900 outline-none focus:ring-4 focus:ring-indigo-500/10"
                                />
                             </div>
                        </div>

                        <div className="flex gap-2">
                            <button onClick={() => { setMigrationModal({ active: false, keyId: '', currentGroup: '' }); setMigrationPassword(''); }} className="flex-1 py-3 text-xs font-bold text-slate-400 hover:text-slate-600 rounded-xl">Cancel</button>
                            <button onClick={handleMigrateKey} disabled={executing || !migrationPassword} className="flex-[2] bg-indigo-600 text-white py-3 rounded-xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-700 transition-all disabled:opacity-50 flex items-center justify-center">
                                {executing ? <Loader2 className="animate-spin" size={14}/> : 'Confirm Move'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

const KeyCard: React.FC<{ k: any, group: any | null, onMigrate: () => void, onDelete: () => void, onExtend: (days: number) => void }> = ({ k, group, onMigrate, onDelete, onExtend }) => {
    const hasOverrides = k.rate_limit !== null || k.burst_limit !== null;
    
    // Status Logic
    const isExpired = k.expires_at && new Date(k.expires_at) < new Date();
    const isNerfed = isExpired && group?.nerf_config?.enabled;

    return (
        <div className="bg-white border border-slate-200 rounded-[2rem] p-5 shadow-sm flex flex-col justify-between group hover:shadow-md transition-all relative">
            <div className="flex justify-between items-start mb-3">
                <div>
                    <h4 className="font-black text-slate-800 text-xs flex items-center gap-2">
                        {k.name}
                        {hasOverrides && <span className="text-[8px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded font-bold uppercase" title="Has custom limits overriding group">Override</span>}
                    </h4>
                    <code className="text-[9px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded mt-1 inline-block font-mono">{k.prefix}...</code>
                    {isNerfed && <span className="ml-2 text-[8px] font-black bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded flex items-center gap-1" title="Key is expired but in grace period (slowed down)"><AlertTriangle size={8}/> DEGRADED</span>}
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={onMigrate} className="p-1.5 text-slate-300 hover:text-indigo-600 bg-slate-50 rounded-lg" title="Change Group"><Move size={12}/></button>
                    <button onClick={onDelete} className="p-1.5 text-slate-300 hover:text-rose-600 bg-slate-50 rounded-lg"><Trash2 size={12}/></button>
                </div>
            </div>
            
            <div className="border-t border-slate-50 pt-3 mt-1">
                <div className="flex justify-between items-center text-[9px] font-bold text-slate-400 mb-1">
                    <span>Expires: {k.expires_at ? new Date(k.expires_at).toLocaleDateString() : 'Never'}</span>
                    <button onClick={() => onExtend(30)} className="text-indigo-500 hover:underline">+30d</button>
                </div>
                <div className="flex items-center gap-1 text-[9px] text-slate-400">
                    <div className={`w-1.5 h-1.5 rounded-full ${k.is_active ? (isNerfed ? 'bg-amber-500' : 'bg-emerald-500') : 'bg-rose-500'}`}></div>
                    {k.is_active ? (isNerfed ? 'Degraded' : 'Active') : 'Inactive'}
                </div>
            </div>
        </div>
    );
}

const RLSManager: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [activeTab, setActiveTab] = useState<'rls' | 'hard_security' | 'logs'>('rls');

  return (
    <div className="flex flex-col h-full bg-[#F8FAFC] overflow-hidden">
      <header className="px-10 py-8 bg-white border-b border-slate-200 flex items-center justify-between shadow-sm z-10">
        <div className="flex items-center gap-6">
          <div className="w-16 h-16 bg-slate-900 text-white rounded-[1.8rem] flex items-center justify-center shadow-2xl shadow-slate-200">
            <Shield size={32} />
          </div>
          <div>
            <h1 className="text-3xl font-black text-slate-900 tracking-tighter leading-none">Security Center</h1>
            <p className="text-slate-400 font-bold uppercase tracking-widest text-[10px] mt-2">Access & Traffic Control</p>
          </div>
        </div>
        
        <div className="flex bg-slate-100 p-1.5 rounded-2xl">
           <button onClick={() => setActiveTab('rls')} className={`px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2 ${activeTab === 'rls' ? 'bg-white shadow-md text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}><Gauge size={14}/> Row Level Security</button>
           <button onClick={() => setActiveTab('hard_security')} className={`px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2 ${activeTab === 'hard_security' ? 'bg-white shadow-md text-rose-600' : 'text-slate-400 hover:text-slate-600'}`}><Siren size={14}/> Hard Security</button>
           <button onClick={() => setActiveTab('logs')} className={`px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2 ${activeTab === 'logs' ? 'bg-white shadow-md text-amber-600' : 'text-slate-400 hover:text-slate-600'}`}><Shield size={14}/> Logs Observability</button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto overflow-x-hidden">
         {activeTab === 'rls' ? (
            <RLSTab projectId={projectId} />
         ) : activeTab === 'hard_security' ? (
            <HardSecurityTab projectId={projectId} />
         ) : (
            <ProjectLogs projectId={projectId} />
         )}
      </div>
    </div>
  );
};

export default RLSManager;
