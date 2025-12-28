
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  Users, Key, Shield, Plus, Search, Fingerprint, Mail, Smartphone, 
  Globe, Trash2, Copy, CheckCircle2, AlertCircle, Loader2, X, 
  UserPlus, CreditCard, Hash, Settings, Eye, EyeOff, Lock, Ban, 
  Filter, ChevronLeft, ChevronRight, CheckSquare, Square, Link,
  Clock, Zap, Github, Facebook, Twitter, Edit2, Unlink, Layers,
  RefreshCcw
} from 'lucide-react';

const AuthConfig: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [activeTab, setActiveTab] = useState<'directory' | 'configuration'>('directory');
  
  // DIRECTORY STATE
  const [users, setUsers] = useState<any[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [isSensitiveVisible, setIsSensitiveVisible] = useState(false);
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [verifyPassword, setVerifyPassword] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'date' | 'alpha'>('date');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  
  // USER DETAIL MODAL
  const [selectedUser, setSelectedUser] = useState<any>(null);
  const [showUserModal, setShowUserModal] = useState(false);
  const [newUserIdentity, setNewUserIdentity] = useState({ provider: '', identifier: '', password: '' });
  const [deleteConfirmUuid, setDeleteConfirmUuid] = useState('');
  const [showDeleteModal, setShowDeleteModal] = useState<any>(null);

  // CONFIGURATION STATE
  const [strategies, setStrategies] = useState<any>({});
  const [globalOrigins, setGlobalOrigins] = useState<string[]>([]);
  const [selectedStrategy, setSelectedStrategy] = useState<string | null>(null);
  const [strategyConfig, setStrategyConfig] = useState<any>(null); 
  const [editingStrategyName, setEditingStrategyName] = useState(''); 
  const [showConfigModal, setShowConfigModal] = useState(false);
  
  // PROVIDER CONFIG
  const [providerConfig, setProviderConfig] = useState({ client_id: '', client_secret: '' });
  const [showProviderConfig, setShowProviderConfig] = useState<string | null>(null);
  
  // LINKED TABLES (Concatenation)
  const [availableTables, setAvailableTables] = useState<string[]>([]);
  const [linkedTables, setLinkedTables] = useState<string[]>([]);
  const [projectDomain, setProjectDomain] = useState<string>('');

  // CUSTOM STRATEGY STATE
  const [newStrategyName, setNewStrategyName] = useState('');
  const [showNewStrategy, setShowNewStrategy] = useState(false);
  const [renameStrategyName, setRenameStrategyName] = useState('');
  const [renamingStrategy, setRenamingStrategy] = useState<string | null>(null);

  // GENERAL
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // CREATE USER STATE (Independent)
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [createUserForm, setCreateUserForm] = useState({ identifier: '', password: '', provider: 'email' });

  // UTILS
  const safeCopy = (text: string) => {
    try {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.left = "-9999px";
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setSuccess("Copiado para área de transferência.");
      setTimeout(() => setSuccess(null), 2000);
    } catch (err) {
      setError("Erro ao copiar.");
    }
  };

  const isValidUrl = (str: string) => {
    try { new URL(str); return true; } catch { return false; }
  };

  // --- FETCHERS ---
  const fetchData = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const token = localStorage.getItem('cascata_token');
      const [usersRes, projRes, tablesRes] = await Promise.all([
        fetch(`/api/data/${projectId}/auth/users`, { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/control/projects', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch(`/api/data/${projectId}/tables`, { headers: { 'Authorization': `Bearer ${token}` } })
      ]);
      
      setUsers(await usersRes.json());
      
      const projects = await projRes.json();
      const currentProj = projects.find((p: any) => p.slug === projectId);
      
      // Store Project Info
      setProjectDomain(currentProj?.custom_domain || '');
      
      // Load Global Origins
      const rawOrigins = currentProj?.metadata?.allowed_origins || [];
      setGlobalOrigins(rawOrigins.map((o: any) => typeof o === 'string' ? o : o.url));

      // Load Strategies
      const savedStrategies = currentProj?.metadata?.auth_strategies || {};
      const defaultStrategies = {
        email: { enabled: true, rules: [], jwt_expiration: '24h', refresh_validity_days: 30 },
        cpf: { enabled: false, rules: [], jwt_expiration: '24h', refresh_validity_days: 30 },
        phone: { enabled: false, rules: [], jwt_expiration: '24h', refresh_validity_days: 30 },
        google: { enabled: false, rules: [], jwt_expiration: '24h', refresh_validity_days: 30 },
        github: { enabled: false, rules: [], jwt_expiration: '24h', refresh_validity_days: 30 }
      };
      setStrategies({ ...defaultStrategies, ...savedStrategies });
      
      // Load Tables
      const tables = await tablesRes.json();
      setAvailableTables(tables.map((t: any) => t.name));
      setLinkedTables(currentProj?.metadata?.linked_tables || []);

    } catch (e) {
      console.error("Fetch Error", e);
    } finally {
      setLoadingUsers(false);
    }
  }, [projectId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // --- ACTIONS ---
  const handleVerifyPassword = async () => {
    setExecuting(true);
    try {
      const res = await fetch('/api/control/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
        body: JSON.stringify({ password: verifyPassword })
      });
      if (res.ok) {
        setIsSensitiveVisible(true);
        setShowVerifyModal(false);
        setVerifyPassword('');
      } else {
        setError("Senha incorreta.");
      }
    } catch (e) { setError("Erro na verificação."); }
    finally { setExecuting(false); }
  };

  const handleCreateUser = async () => {
    setExecuting(true);
    try {
        await fetch(`/api/data/${projectId}/auth/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
            body: JSON.stringify({
                strategies: [{
                    provider: createUserForm.provider,
                    identifier: createUserForm.identifier,
                    password: createUserForm.password
                }]
            })
        });
        setSuccess("Usuário criado com sucesso.");
        setShowCreateUser(false);
        setCreateUserForm({ identifier: '', password: '', provider: 'email' });
        fetchData();
    } catch (e) { setError("Erro ao criar usuário."); }
    finally { setExecuting(false); }
  };

  const saveStrategies = async (newStrategies: any, authConfig?: any, newLinkedTables?: string[]) => {
    setExecuting(true);
    try {
        const body: any = { authStrategies: newStrategies };
        if (authConfig) body.authConfig = authConfig;
        if (newLinkedTables) body.linked_tables = newLinkedTables;

        // Perform Optimistic Update First
        setStrategies(newStrategies);
        if (newLinkedTables) setLinkedTables(newLinkedTables);

        // Fetch current metadata to merge (important for providers)
        const projRes = await fetch('/api/control/projects', { headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` } });
        const projects = await projRes.json();
        const currentProj = projects.find((p: any) => p.slug === projectId);
        const currentMetadata = currentProj?.metadata || {};
        
        // Merge Auth Config if provided
        let finalAuthConfig = currentMetadata.auth_config || {};
        if (authConfig) {
            finalAuthConfig = {
                ...finalAuthConfig,
                providers: {
                    ...(finalAuthConfig.providers || {}),
                    ...(authConfig.providers || {})
                }
            };
            body.authConfig = finalAuthConfig;
        }

        await fetch(`/api/data/${projectId}/auth/link`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
            body: JSON.stringify(body)
        });
        
        setSuccess("Configuração salva.");
        setTimeout(() => setSuccess(null), 2000);
    } catch (e) { 
        setError("Falha ao salvar."); 
        fetchData(); // Revert on failure
    }
    finally { setExecuting(false); }
  };

  const handleSaveStrategyConfig = () => {
      let updatedStrategies = { ...strategies };
      
      if (selectedStrategy && editingStrategyName && selectedStrategy !== editingStrategyName) {
          if (updatedStrategies[editingStrategyName]) {
              setError("Este nome de estratégia já existe.");
              return;
          }
          const config = updatedStrategies[selectedStrategy];
          delete updatedStrategies[selectedStrategy];
          updatedStrategies[editingStrategyName] = { ...config, ...strategyConfig };
      } else {
          updatedStrategies[selectedStrategy!] = strategyConfig;
      }

      saveStrategies(updatedStrategies);
      setShowConfigModal(false);
  };

  const openProviderConfig = async (provider: string) => {
      setShowProviderConfig(provider);
      try {
          const projRes = await fetch('/api/control/projects', { headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` } });
          const projects = await projRes.json();
          const currentProj = projects.find((p: any) => p.slug === projectId);
          const conf = currentProj?.metadata?.auth_config?.providers?.[provider] || { client_id: '', client_secret: '' };
          setProviderConfig(conf);
      } catch (e) {}
  };

  const handleSaveProviderConfig = () => {
      if (!showProviderConfig) return;
      saveStrategies(strategies, { providers: { [showProviderConfig]: providerConfig } });
      setShowProviderConfig(null);
  };

  const addRuleToStrategy = (origin: string, requireCode: boolean) => {
      if (!isValidUrl(origin)) { alert("URL inválida."); return; }
      const currentRules = strategyConfig.rules || [];
      if (currentRules.some((r: any) => r.origin === origin)) return;
      setStrategyConfig({
          ...strategyConfig,
          rules: [...currentRules, { origin, require_code: requireCode }]
      });
  };

  const removeRuleFromStrategy = (origin: string) => {
      setStrategyConfig({
          ...strategyConfig,
          rules: (strategyConfig.rules || []).filter((r: any) => r.origin !== origin)
      });
  };

  const toggleLinkedTable = (tableName: string) => {
      const next = linkedTables.includes(tableName) 
        ? linkedTables.filter(t => t !== tableName)
        : [...linkedTables, tableName];
      saveStrategies(strategies, null, next);
  };

  const getProviderRedirectUri = () => {
      const domain = projectDomain || window.location.hostname;
      const protocol = window.location.protocol;
      if (projectDomain) {
          return `https://${projectDomain}/auth/callback`;
      }
      return `${protocol}//${domain}/api/data/${projectId}/auth/callback`;
  };

  const handleBlockUser = async (user: any) => {
    try {
        await fetch(`/api/data/${projectId}/auth/users/${user.id}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
            body: JSON.stringify({ banned: !user.banned })
        });
        if (selectedUser && selectedUser.id === user.id) {
            setSelectedUser({ ...selectedUser, banned: !user.banned });
        }
        fetchData();
        setSuccess(user.banned ? "Usuário desbloqueado." : "Usuário bloqueado.");
    } catch (e) { setError("Erro ao alterar status."); }
  };

  const handleDeleteUser = async () => {
    if (deleteConfirmUuid !== showDeleteModal?.id) { setError("UUID incorreto."); return; }
    setExecuting(true);
    try {
        await fetch(`/api/data/${projectId}/auth/users/${showDeleteModal.id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
        });
        setShowDeleteModal(null);
        setShowUserModal(false);
        setDeleteConfirmUuid('');
        fetchData();
        setSuccess("Usuário excluído permanentemente.");
    } catch (e) { setError("Erro ao excluir."); }
    finally { setExecuting(false); }
  };

  const handleUnlinkIdentity = async (identityId: string) => {
      if (!confirm("Remover esta forma de acesso do usuário?")) return;
      setExecuting(true);
      try {
          const res = await fetch(`/api/data/${projectId}/auth/users/${selectedUser.id}/strategies/${identityId}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          if (!res.ok) throw new Error((await res.json()).error);
          
          setSuccess("Identidade removida.");
          const usersRes = await fetch(`/api/data/${projectId}/auth/users`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` } });
          const usersData = await usersRes.json();
          setUsers(usersData);
          setSelectedUser(usersData.find((u:any) => u.id === selectedUser.id));
      } catch (e: any) { setError(e.message); }
      finally { setExecuting(false); }
  };

  const toggleStrategy = async (key: string) => {
    const currentEnabled = strategies[key]?.enabled;
    const updatedStrategies = { 
        ...strategies, 
        [key]: { ...strategies[key], enabled: !currentEnabled } 
    };
    await saveStrategies(updatedStrategies);
  };

  const handleCreateCustomStrategy = () => {
      if (!newStrategyName) return;
      const key = newStrategyName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      if (strategies[key]) { setError("Strategy já existe."); return; }
      
      const newStrategies = { 
          ...strategies, 
          [key]: { enabled: true, rules: [], jwt_expiration: '24h', refresh_validity_days: 30 } 
      };
      saveStrategies(newStrategies);
      setNewStrategyName('');
      setShowNewStrategy(false);
  };

  const handleDeleteStrategy = (key: string) => {
      if (!confirm(`Excluir permanentemente a strategy "${key}"? Usuários que usam apenas este método perderão acesso.`)) return;
      const { [key]: deleted, ...rest } = strategies;
      saveStrategies(rest);
  };

  const filteredUsers = useMemo(() => {
    let list = users.filter(u => 
        u.id.includes(searchQuery) || 
        u.identities?.some((i: any) => i.identifier.toLowerCase().includes(searchQuery.toLowerCase()))
    );
    if (sortBy === 'alpha') {
        list.sort((a, b) => (a.identities?.[0]?.identifier || '').localeCompare(b.identities?.[0]?.identifier || ''));
    } else {
        list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }
    return list;
  }, [users, searchQuery, sortBy]);

  const paginatedUsers = filteredUsers.slice((page - 1) * pageSize, page * pageSize);
  const totalPages = Math.ceil(filteredUsers.length / pageSize);

  return (
    <div className="flex h-full flex-col bg-[#F8FAFC]">
      {(error || success) && (
        <div className={`fixed top-8 left-1/2 -translate-x-1/2 z-[600] px-6 py-4 rounded-full shadow-2xl flex items-center gap-3 animate-in slide-in-from-top-4 ${error ? 'bg-rose-600 text-white' : 'bg-emerald-600 text-white'}`}>
          {error ? <AlertCircle size={18}/> : <CheckCircle2 size={18}/>}
          <span className="text-xs font-bold">{error || success}</span>
          <button onClick={() => { setError(null); setSuccess(null); }}><X size={14} className="opacity-60 hover:opacity-100"/></button>
        </div>
      )}
      
      {/* HEADER SECTION (SAME AS BEFORE) */}
      <header className="px-10 py-8 bg-white border-b border-slate-200 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-6">
          <div className="w-14 h-14 bg-slate-900 text-white rounded-[1.5rem] flex items-center justify-center shadow-xl">
            <Fingerprint size={28} />
          </div>
          <div>
            <h2 className="text-3xl font-black text-slate-900 tracking-tighter leading-none">Auth Services</h2>
            <p className="text-[10px] text-indigo-600 font-bold uppercase tracking-[0.2em] mt-1">Identity & Access Management</p>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="flex items-center bg-slate-100 p-1 rounded-xl mr-4">
             <button onClick={() => setActiveTab('directory')} className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all ${activeTab === 'directory' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400'}`}>Directory</button>
             <button onClick={() => setActiveTab('configuration')} className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all ${activeTab === 'configuration' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400'}`}>Configuration</button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-hidden p-10 overflow-y-auto">
        {activeTab === 'directory' ? (
          // DIRECTORY VIEW (SAME AS BEFORE)
          <div className="space-y-6">
             <div className="flex justify-between items-center bg-white p-4 rounded-[2rem] shadow-sm border border-slate-100">
                <div className="flex items-center gap-4">
                   <div className="relative group">
                      <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                      <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search UUID, email..." className="pl-12 pr-6 py-3 bg-slate-50 border-none rounded-2xl text-xs font-bold outline-none w-64 focus:ring-2 focus:ring-indigo-500/20 transition-all" />
                   </div>
                   <div className="flex items-center gap-2 bg-slate-50 px-3 py-2 rounded-xl">
                      <Filter size={14} className="text-slate-400" />
                      <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)} className="bg-transparent text-xs font-bold text-slate-600 outline-none">
                         <option value="date">Newest First</option>
                         <option value="alpha">A-Z</option>
                      </select>
                   </div>
                </div>
                
                <div className="flex items-center gap-4">
                   <button onClick={() => setShowCreateUser(true)} className="bg-indigo-600 text-white px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-100">
                      <UserPlus size={16} /> New User
                   </button>
                   <button onClick={() => isSensitiveVisible ? setIsSensitiveVisible(false) : setShowVerifyModal(true)} className={`flex items-center gap-2 px-4 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all ${isSensitiveVisible ? 'bg-amber-50 text-amber-600' : 'bg-slate-900 text-white'}`}>
                      {isSensitiveVisible ? <><EyeOff size={14} /> Hide Data</> : <><Eye size={14} /> Reveal Data</>}
                   </button>
                </div>
             </div>

             {loadingUsers ? (
                <div className="py-20 flex justify-center"><Loader2 className="animate-spin text-indigo-600" size={32} /></div>
             ) : (
                <div className="space-y-4">
                   {paginatedUsers.map(u => (
                      <div 
                        key={u.id} 
                        onClick={() => { setSelectedUser(u); setShowUserModal(true); }}
                        className={`bg-white border ${u.banned ? 'border-rose-200 bg-rose-50/10' : 'border-slate-200'} rounded-[2.5rem] p-6 hover:shadow-xl transition-all group relative overflow-hidden cursor-pointer`}
                      >
                         {u.banned && <div className="absolute top-0 right-0 bg-rose-500 text-white text-[9px] font-black px-4 py-1 rounded-bl-xl uppercase tracking-widest">Banned</div>}
                         <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
                            <div className="flex items-center gap-6">
                               <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-white text-xl font-bold shadow-lg ${u.banned ? 'bg-rose-400' : 'bg-slate-900'}`}>
                                  {u.identities?.[0]?.identifier?.[0]?.toUpperCase() || <Users/>}
                               </div>
                               <div>
                                  <div className="flex items-center gap-2 mb-1">
                                     <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">UUID</span>
                                     <code className="text-[10px] font-mono text-slate-500 bg-slate-100 px-2 py-0.5 rounded">{u.id}</code>
                                     <button onClick={(e) => { e.stopPropagation(); safeCopy(u.id); }} className="text-slate-300 hover:text-indigo-600"><Copy size={12}/></button>
                                  </div>
                                  <h4 className={`text-lg font-bold ${isSensitiveVisible ? 'text-slate-900' : 'text-slate-400 blur-[4px] select-none'} transition-all`}>
                                     {u.identities?.[0]?.identifier || 'Unknown Identity'}
                                  </h4>
                                  <p className="text-[10px] text-slate-400 font-bold mt-1">Created: {new Date(u.created_at).toLocaleDateString()}</p>
                               </div>
                            </div>

                            <div className="flex items-center gap-3">
                               {u.identities?.map((id: any, idx: number) => (
                                  <div key={idx} className="bg-slate-50 border border-slate-100 px-3 py-1.5 rounded-lg flex items-center gap-2">
                                     <span className="text-[9px] font-black uppercase text-indigo-600">{id.provider}</span>
                                  </div>
                               ))}
                               <div className="px-4 text-slate-300"><ChevronRight size={16}/></div>
                            </div>
                         </div>
                      </div>
                   ))}
                </div>
             )}

             <div className="flex justify-center items-center gap-6 pt-4">
                <button disabled={page === 1} onClick={() => setPage(p => p - 1)} className="p-3 rounded-xl bg-white border border-slate-200 disabled:opacity-50 hover:bg-slate-50"><ChevronLeft size={16}/></button>
                <span className="text-xs font-black text-slate-400 uppercase tracking-widest">Page {page} of {totalPages}</span>
                <button disabled={page === totalPages} onClick={() => setPage(p => p + 1)} className="p-3 rounded-xl bg-white border border-slate-200 disabled:opacity-50 hover:bg-slate-50"><ChevronRight size={16}/></button>
             </div>
          </div>
        ) : (
          <div className="space-y-12 pb-20">
             
             {/* SCHEMA CONCATENATION */}
             <div className="bg-white border border-slate-200 rounded-[3rem] p-12 shadow-sm">
                <div className="flex items-center gap-4 mb-8">
                   <div className="w-12 h-12 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center"><Layers size={20}/></div>
                   <div>
                      <h3 className="text-2xl font-black text-slate-900 tracking-tight">Schema Concatenation</h3>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Multi-Table Linking & Foreign Keys</p>
                   </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
                   {availableTables.map(table => {
                      const isLinked = linkedTables.includes(table);
                      return (
                         <button 
                           key={table}
                           onClick={() => toggleLinkedTable(table)}
                           disabled={executing}
                           className={`p-4 rounded-2xl border flex flex-col items-center gap-3 transition-all ${isLinked ? 'bg-indigo-600 border-indigo-600 text-white shadow-lg' : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-white hover:shadow-md'}`}
                         >
                            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isLinked ? 'bg-white/20' : 'bg-white'}`}>
                               {isLinked ? <Link size={18} /> : <Unlink size={18} />}
                            </div>
                            <span className="text-xs font-black truncate max-w-full px-2">{table}</span>
                         </button>
                      );
                   })}
                   {availableTables.length === 0 && <p className="col-span-full text-center text-slate-400 text-xs font-medium py-8">Nenhuma tabela pública disponível para vínculo.</p>}
                </div>
             </div>

             {/* Social Providers */}
             <div className="bg-white border border-slate-200 rounded-[3rem] p-12 shadow-sm">
                <div className="flex items-center gap-4 mb-8">
                   <div className="w-12 h-12 bg-rose-50 text-rose-600 rounded-2xl flex items-center justify-center"><Globe size={20}/></div>
                   <h3 className="text-2xl font-black text-slate-900 tracking-tight">Social & Enterprise Providers</h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                   {/* Google */}
                   <button onClick={() => openProviderConfig('google')} className="flex flex-col items-center gap-4 p-8 border-2 border-indigo-50 bg-indigo-50/20 rounded-[2.5rem] hover:border-indigo-200 transition-all group">
                      <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center shadow-lg text-rose-600"><Globe size={32} /></div>
                      <div className="text-center">
                         <h4 className="font-black text-slate-900">Google Workspace</h4>
                         <span className="text-[10px] font-black text-emerald-600 uppercase tracking-widest bg-emerald-50 px-2 py-1 rounded-lg mt-2 inline-block">Configurar</span>
                      </div>
                   </button>
                   {/* GitHub */}
                   <button onClick={() => openProviderConfig('github')} className="flex flex-col items-center gap-4 p-8 border-2 border-slate-100 bg-slate-50/50 rounded-[2.5rem] hover:border-slate-300 transition-all group">
                      <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center shadow-lg text-slate-900"><Github size={32} /></div>
                      <div className="text-center">
                         <h4 className="font-black text-slate-900">GitHub</h4>
                         <span className="text-[10px] font-black text-emerald-600 uppercase tracking-widest bg-emerald-50 px-2 py-1 rounded-lg mt-2 inline-block">Configurar</span>
                      </div>
                   </button>
                </div>
             </div>

             {/* Strategy Cards (Custom & System) */}
             <div className="space-y-4">
               <div className="flex items-center justify-between px-4">
                  <h3 className="text-[11px] font-black text-slate-400 uppercase tracking-[0.4em]">Active Strategies</h3>
                  <button onClick={() => setShowNewStrategy(true)} className="text-[10px] font-black text-indigo-600 uppercase tracking-widest hover:bg-indigo-50 px-4 py-2 rounded-xl transition-all flex items-center gap-2"><Plus size={12}/> New Custom Strategy</button>
               </div>
               
               <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                 {Object.keys(strategies).map(stKey => {
                    const config = strategies[stKey];
                    const isDefault = ['email', 'cpf', 'phone', 'google', 'github'].includes(stKey);
                    
                    return (
                       <div key={stKey} className={`relative bg-white border rounded-[2.5rem] p-8 shadow-sm transition-all group ${config.enabled ? 'border-indigo-200' : 'border-slate-200 opacity-70'}`}>
                          <div className="flex justify-between items-start mb-6">
                             <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-white shadow-lg ${config.enabled ? 'bg-indigo-600' : 'bg-slate-300'}`}>
                                {stKey === 'email' && <Mail size={24}/>}
                                {stKey === 'cpf' && <CreditCard size={24}/>}
                                {stKey === 'phone' && <Smartphone size={24}/>}
                                {stKey === 'google' && <Globe size={24}/>}
                                {stKey === 'github' && <Github size={24}/>}
                                {!isDefault && <Hash size={24}/>}
                             </div>
                             <button onClick={() => toggleStrategy(stKey)} className={`w-12 h-7 rounded-full p-1 transition-colors ${config.enabled ? 'bg-emerald-500' : 'bg-slate-200'}`}>
                                <div className={`w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${config.enabled ? 'translate-x-5' : ''}`}></div>
                             </button>
                          </div>
                          
                          <div className="mb-6">
                             <div className="flex items-center justify-between">
                                <h4 className="text-xl font-black text-slate-900 capitalize truncate" title={stKey}>{stKey}</h4>
                                {!isDefault && (
                                   <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                      <button onClick={() => handleDeleteStrategy(stKey)} className="p-1 text-slate-300 hover:text-rose-600"><Trash2 size={12}/></button>
                                   </div>
                                )}
                             </div>
                             <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-2">
                                {config.rules?.length || 0} Origin Rules • {config.jwt_expiration || '24h'}
                             </p>
                          </div>

                          <button 
                            disabled={!config.enabled}
                            onClick={() => { 
                                setSelectedStrategy(stKey); 
                                setStrategyConfig({...config}); 
                                setEditingStrategyName(stKey); 
                                setShowConfigModal(true); 
                            }}
                            className="w-full py-4 border border-slate-200 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-50 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                          >
                             <Settings size={14} /> Advanced Config
                          </button>
                       </div>
                    );
                 })}
               </div>
             </div>
          </div>
        )}
      </div>

      {/* STRATEGY CONFIG MODAL */}
      {showConfigModal && strategyConfig && (
         <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
            <div className="bg-white rounded-[3.5rem] max-w-2xl w-full p-12 shadow-2xl flex flex-col max-h-[90vh]">
               <div className="flex justify-between items-center mb-8">
                  <div>
                     <h3 className="text-3xl font-black text-slate-900 capitalize">{selectedStrategy} Settings</h3>
                     <p className="text-slate-400 text-xs font-bold uppercase tracking-widest mt-1">Lifecycle & Security</p>
                  </div>
                  <button onClick={() => setShowConfigModal(false)} className="p-3 bg-slate-50 rounded-full hover:bg-slate-100"><X size={20}/></button>
               </div>

               <div className="flex-1 overflow-y-auto space-y-8 pr-2">
                  <div className="grid grid-cols-2 gap-6">
                     <div className="col-span-2 space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Internal ID / Key</label>
                        <div className="flex items-center bg-slate-50 border border-slate-200 rounded-2xl px-4">
                           <Edit2 size={16} className="text-slate-400" />
                           <input 
                              value={editingStrategyName}
                              onChange={(e) => setEditingStrategyName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
                              placeholder="ex: tax_id"
                              className="w-full bg-transparent border-none py-4 px-4 text-sm font-bold text-slate-900 outline-none"
                           />
                        </div>
                     </div>
                     <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Access Token (JWT)</label>
                        <div className="flex items-center bg-slate-50 border border-slate-200 rounded-2xl px-4">
                           <Clock size={16} className="text-indigo-500" />
                           <input 
                              value={strategyConfig.jwt_expiration || '24h'}
                              onChange={(e) => setStrategyConfig({...strategyConfig, jwt_expiration: e.target.value})}
                              placeholder="e.g. 15m, 1h"
                              className="w-full bg-transparent border-none py-4 px-4 text-sm font-bold text-slate-900 outline-none"
                           />
                        </div>
                     </div>
                     <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Refresh Token (Days)</label>
                        <div className="flex items-center bg-slate-50 border border-slate-200 rounded-2xl px-4">
                           <RefreshCcw size={16} className="text-emerald-500" />
                           <input 
                              type="number"
                              value={strategyConfig.refresh_validity_days || 30}
                              onChange={(e) => setStrategyConfig({...strategyConfig, refresh_validity_days: parseInt(e.target.value)})}
                              placeholder="30"
                              className="w-full bg-transparent border-none py-4 px-4 text-sm font-bold text-slate-900 outline-none"
                           />
                        </div>
                     </div>
                     <div className="col-span-2 space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">OTP Webhook URL</label>
                        <div className="flex items-center bg-slate-50 border border-slate-200 rounded-2xl px-4">
                           <Zap size={16} className="text-slate-400" />
                           <input 
                              value={strategyConfig.webhook_url || ''}
                              onChange={(e) => setStrategyConfig({...strategyConfig, webhook_url: e.target.value})}
                              placeholder="https://n8n.webhook/send-otp"
                              className="w-full bg-transparent border-none py-4 px-4 text-sm font-bold text-slate-900 outline-none"
                           />
                        </div>
                     </div>
                  </div>

                  <div className="bg-indigo-50 border border-indigo-100 p-6 rounded-3xl">
                     <h5 className="font-bold text-indigo-900 text-sm mb-2 flex items-center gap-2"><Link size={14}/> Add Origin Rule</h5>
                     <div className="flex gap-3 mb-4">
                        <input id="newStratUrl" list="globalOrigins" placeholder="https://..." className="flex-1 bg-white border-none rounded-xl px-4 py-3 text-xs font-bold outline-none" />
                        <datalist id="globalOrigins">
                           {globalOrigins.map(url => <option key={url} value={url} />)}
                        </datalist>
                        <button 
                           onClick={() => {
                              const input = document.getElementById('newStratUrl') as HTMLInputElement;
                              if(input.value) { addRuleToStrategy(input.value, true); input.value = ''; }
                           }}
                           className="bg-indigo-600 text-white px-4 rounded-xl"
                        >
                           <Plus size={18}/>
                        </button>
                     </div>
                  </div>

                  <div className="space-y-3">
                     {(strategyConfig.rules || []).map((rule: any, idx: number) => (
                        <div key={idx} className="flex items-center justify-between bg-slate-50 p-4 rounded-2xl border border-slate-100">
                           <div className="flex items-center gap-3">
                              <Globe size={16} className="text-slate-400"/>
                              <span className="text-xs font-bold text-slate-700">{rule.origin}</span>
                           </div>
                           <button onClick={() => removeRuleFromStrategy(rule.origin)} className="text-slate-300 hover:text-rose-600"><X size={16}/></button>
                        </div>
                     ))}
                  </div>
               </div>

               <div className="pt-8 mt-4 border-t border-slate-100">
                  <button onClick={handleSaveStrategyConfig} disabled={executing} className="w-full bg-slate-900 text-white py-5 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-600 transition-all">
                     {executing ? <Loader2 className="animate-spin mx-auto"/> : 'Salvar Alterações'}
                  </button>
               </div>
            </div>
         </div>
      )}

      {/* ... (Other modals for Password, User, etc. remain unchanged) ... */}
      {showVerifyModal && (
         <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
            <div className="bg-white rounded-[3rem] p-10 max-w-sm w-full shadow-2xl text-center">
               <Lock size={40} className="mx-auto text-slate-900 mb-6" />
               <h3 className="text-2xl font-black text-slate-900 mb-2">Security Check</h3>
               <p className="text-xs text-slate-500 font-bold mb-8">Confirme sua senha mestre para revelar dados PII.</p>
               <input 
                 type="password" 
                 autoFocus
                 value={verifyPassword}
                 onChange={e => setVerifyPassword(e.target.value)}
                 className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-center font-bold text-slate-900 outline-none mb-6 focus:ring-4 focus:ring-indigo-500/10"
                 placeholder="••••••••"
               />
               <button onClick={handleVerifyPassword} disabled={executing} className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-600 transition-all">
                  {executing ? <Loader2 className="animate-spin mx-auto"/> : 'Liberar Acesso'}
               </button>
               <button onClick={() => setShowVerifyModal(false)} className="mt-4 text-xs font-bold text-slate-400 hover:text-slate-600">Cancelar</button>
            </div>
         </div>
      )}

      {showUserModal && selectedUser && (
         <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
            <div className="bg-white rounded-[3.5rem] w-full max-w-2xl p-12 shadow-2xl border border-slate-100 flex flex-col max-h-[90vh]">
               <div className="flex justify-between items-start mb-8 shrink-0">
                  <div className="flex items-center gap-6">
                     <div className={`w-16 h-16 rounded-[1.5rem] flex items-center justify-center text-white text-2xl font-bold shadow-xl ${selectedUser.banned ? 'bg-rose-500' : 'bg-slate-900'}`}>
                        <Users />
                     </div>
                     <div>
                        <h3 className="text-3xl font-black text-slate-900 tracking-tighter">User Identity</h3>
                        <div className="flex items-center gap-2 mt-1">
                           <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">UUID:</span>
                           <code className="bg-slate-100 px-2 py-0.5 rounded text-[10px] font-mono text-slate-500">{selectedUser.id}</code>
                           <button onClick={() => safeCopy(selectedUser.id)} className="text-slate-300 hover:text-indigo-600"><Copy size={12}/></button>
                        </div>
                     </div>
                  </div>
                  <button onClick={() => setShowUserModal(false)} className="p-3 bg-slate-50 rounded-full hover:bg-slate-100"><X size={20} className="text-slate-400"/></button>
               </div>

               <div className="flex-1 overflow-y-auto space-y-8 pr-2">
                  <div className="space-y-4">
                     <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Linked Strategies (Multi-Auth)</label>
                     {selectedUser.identities?.map((id: any) => (
                        <div key={id.id} className="flex items-center justify-between bg-slate-50 border border-slate-100 p-4 rounded-2xl group">
                           <div className="flex items-center gap-4">
                              <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-indigo-600 shadow-sm border border-slate-100">
                                 {['email','google','github'].includes(id.provider) ? <Mail size={16}/> : <Fingerprint size={16}/>}
                              </div>
                              <div>
                                 <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest block">{id.provider}</span>
                                 <span className="text-sm font-bold text-slate-800">{isSensitiveVisible ? id.identifier : '•••••••••••'}</span>
                              </div>
                           </div>
                           <button onClick={() => handleUnlinkIdentity(id.id)} className="p-2 text-slate-300 hover:text-rose-600 opacity-0 group-hover:opacity-100 transition-all" title="Unlink Identity">
                              <Unlink size={16} />
                           </button>
                        </div>
                     ))}
                  </div>
               </div>

               <div className="pt-8 mt-4 border-t border-slate-100 flex gap-4 shrink-0">
                  <button onClick={() => handleBlockUser(selectedUser)} className={`flex-1 py-4 rounded-2xl text-xs font-black uppercase tracking-widest transition-all ${selectedUser.banned ? 'bg-emerald-100 text-emerald-600 hover:bg-emerald-200' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                     {selectedUser.banned ? 'Unblock Access' : 'Block Access'}
                  </button>
                  <button onClick={() => setShowDeleteModal(selectedUser)} className="flex-1 py-4 bg-rose-50 text-rose-600 rounded-2xl text-xs font-black uppercase tracking-widest hover:bg-rose-100 transition-all border border-rose-100">
                     Delete User
                  </button>
               </div>
            </div>
         </div>
      )}

      {/* Other modals remain unchanged (Delete User, New Strategy, Create User, Provider Config) */}
      {showDeleteModal && (
         <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
            <div className="bg-white rounded-[3rem] p-10 max-w-md w-full shadow-2xl border border-rose-100">
               <div className="w-16 h-16 bg-rose-50 text-rose-600 rounded-2xl flex items-center justify-center mx-auto mb-6"><Trash2 size={32}/></div>
               <h3 className="text-2xl font-black text-slate-900 text-center mb-2">Excluir Usuário?</h3>
               <p className="text-xs text-slate-500 font-medium text-center mb-8">Esta ação é irreversível. Cole o UUID abaixo para confirmar.</p>
               
               <code className="block bg-slate-50 p-3 rounded-xl text-[10px] text-center mb-4 select-all cursor-copy" onClick={() => safeCopy(showDeleteModal.id)}>{showDeleteModal.id}</code>
               
               <input 
                 value={deleteConfirmUuid}
                 onChange={e => setDeleteConfirmUuid(e.target.value)}
                 className="w-full bg-white border border-slate-200 rounded-2xl py-4 px-6 text-center font-mono text-xs font-bold outline-none mb-6 focus:border-rose-500"
                 placeholder="Paste UUID here"
               />
               <div className="flex gap-4">
                  <button onClick={() => setShowDeleteModal(null)} className="flex-1 py-4 text-xs font-black text-slate-400 uppercase tracking-widest hover:bg-slate-50 rounded-2xl">Cancelar</button>
                  <button 
                    onClick={handleDeleteUser} 
                    disabled={deleteConfirmUuid !== showDeleteModal.id || executing}
                    className="flex-[2] bg-rose-600 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl disabled:opacity-50"
                  >
                     {executing ? <Loader2 className="animate-spin mx-auto"/> : 'Confirmar Exclusão'}
                  </button>
               </div>
            </div>
         </div>
      )}

      {showNewStrategy && (
         <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
            <div className="bg-white rounded-[3rem] p-10 max-w-sm w-full shadow-2xl">
               <h3 className="text-xl font-black text-slate-900 mb-4">New White-label Strategy</h3>
               <input 
                  autoFocus
                  value={newStrategyName}
                  onChange={(e) => setNewStrategyName(e.target.value)}
                  placeholder="e.g. passport_number"
                  className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 font-bold text-sm text-slate-900 outline-none mb-6 focus:ring-4 focus:ring-indigo-500/10"
               />
               <div className="flex gap-4">
                  <button onClick={() => setShowNewStrategy(false)} className="flex-1 text-xs font-black text-slate-400 uppercase tracking-widest hover:text-slate-600">Cancel</button>
                  <button onClick={handleCreateCustomStrategy} disabled={!newStrategyName} className="flex-[2] bg-indigo-600 text-white py-4 rounded-2xl text-xs font-black uppercase tracking-widest shadow-xl disabled:opacity-50">Create</button>
               </div>
            </div>
         </div>
      )}

      {showCreateUser && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
           <div className="bg-white rounded-[3.5rem] w-full max-w-lg p-12 shadow-2xl border border-slate-100">
              <header className="flex items-center justify-between mb-8">
                 <h3 className="text-2xl font-black text-slate-900 tracking-tighter">Novo Usuário</h3>
                 <button onClick={() => setShowCreateUser(false)}><X size={24} className="text-slate-400"/></button>
              </header>
              <div className="space-y-6">
                 <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Strategy Type</label>
                    <select 
                       value={createUserForm.provider}
                       onChange={(e) => setCreateUserForm({...createUserForm, provider: e.target.value})}
                       className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-sm font-black uppercase text-indigo-600 outline-none"
                    >
                       {Object.keys(strategies).filter(s => strategies[s].enabled).map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                 </div>
                 <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Identifier</label>
                    <input 
                      value={createUserForm.identifier}
                      onChange={(e) => setCreateUserForm({...createUserForm, identifier: e.target.value})}
                      placeholder="user@app.com / 12345..."
                      className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-sm font-bold text-slate-900 outline-none" 
                    />
                 </div>
                 <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Password / Secret</label>
                    <input 
                      type="password"
                      value={createUserForm.password}
                      onChange={(e) => setCreateUserForm({...createUserForm, password: e.target.value})}
                      className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-sm font-bold text-slate-900 outline-none" 
                    />
                 </div>
                 <button 
                  onClick={handleCreateUser}
                  disabled={executing}
                  className="w-full bg-slate-900 text-white py-5 rounded-2xl text-xs font-black uppercase tracking-widest shadow-xl flex items-center justify-center gap-2 hover:bg-indigo-600 transition-all">
                    {executing ? <Loader2 className="animate-spin" size={18} /> : 'Create Identity'}
                 </button>
              </div>
           </div>
        </div>
      )}

      {showProviderConfig && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[600] flex items-center justify-center p-8 animate-in fade-in zoom-in-95">
           <div className="bg-white rounded-[3.5rem] w-full max-w-lg p-12 shadow-2xl border border-slate-100 relative">
              <button onClick={() => setShowProviderConfig(null)} className="absolute top-8 right-8 text-slate-300 hover:text-slate-900 transition-colors"><X size={24} /></button>
              <h3 className="text-3xl font-black text-slate-900 tracking-tighter mb-4 capitalize">{showProviderConfig} Auth</h3>
              <p className="text-slate-500 font-medium mb-8 text-sm">Configure as chaves OAuth do provedor.</p>
              
              <div className="space-y-6">
                 <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Client ID</label>
                    <input 
                      value={providerConfig.client_id}
                      onChange={(e) => setProviderConfig({...providerConfig, client_id: e.target.value})}
                      placeholder="client_id_from_provider" 
                      className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-sm font-bold text-slate-800 outline-none" 
                    />
                 </div>
                 <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Client Secret</label>
                    <input 
                      value={providerConfig.client_secret}
                      onChange={(e) => setProviderConfig({...providerConfig, client_secret: e.target.value})}
                      type="password"
                      placeholder="client_secret..." 
                      className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-sm font-bold text-slate-800 outline-none" 
                    />
                 </div>
                 
                 <div className="p-4 bg-indigo-50 border border-indigo-100 rounded-2xl">
                    <p className="text-[10px] text-indigo-800 font-bold uppercase tracking-widest mb-2">Authorized Redirect URI</p>
                    <code className="text-[10px] text-indigo-600 block mt-1 break-all bg-white p-3 rounded-xl border border-indigo-100">
                       {getProviderRedirectUri()}
                    </code>
                 </div>

                 <button 
                  onClick={handleSaveProviderConfig}
                  disabled={executing}
                  className="w-full bg-indigo-600 text-white py-5 rounded-2xl text-xs font-black uppercase tracking-widest shadow-xl flex items-center justify-center gap-2">
                    {executing ? <Loader2 className="animate-spin" size={18} /> : 'Salvar Chaves'}
                 </button>
              </div>
           </div>
        </div>
      )}

    </div>
  );
};

export default AuthConfig;
