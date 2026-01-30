
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  Users, Key, Shield, Plus, Search, Fingerprint, Mail, Smartphone, 
  Globe, Trash2, Copy, CheckCircle2, AlertCircle, Loader2, X, 
  UserPlus, CreditCard, Hash, Settings, Eye, EyeOff, Lock, Ban, 
  Filter, ChevronLeft, ChevronRight, CheckSquare, Square, Link,
  Clock, Zap, Github, Facebook, Twitter, Edit2, Unlink, Layers,
  RefreshCcw, ArrowRight, LayoutTemplate, Send, ShieldAlert, Target,
  MessageSquare, Server, Plug, BellRing, PartyPopper, Code
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
  const [deleteConfirmUuid, setDeleteConfirmUuid] = useState('');
  const [showDeleteModal, setShowDeleteModal] = useState<any>(null);
  
  // LINK IDENTITY STATE
  const [showLinkIdentity, setShowLinkIdentity] = useState(false);
  const [linkIdentityForm, setLinkIdentityForm] = useState({ provider: 'email', identifier: '', password: '' });

  // CONFIGURATION STATE
  const [strategies, setStrategies] = useState<any>({});
  const [globalOrigins, setGlobalOrigins] = useState<string[]>([]);
  const [siteUrl, setSiteUrl] = useState(''); // Default Redirect
  const [selectedStrategy, setSelectedStrategy] = useState<string | null>(null);
  const [strategyConfig, setStrategyConfig] = useState<any>(null); 
  const [editingStrategyName, setEditingStrategyName] = useState(''); 
  const [showConfigModal, setShowConfigModal] = useState(false);

  // SECURITY / SMART LOCKOUT STATE
  const [securityConfig, setSecurityConfig] = useState({
      max_attempts: 5,
      lockout_minutes: 15,
      strategy: 'hybrid' // 'ip' | 'email' | 'hybrid'
  });

  // EMAIL CENTER STATE (New Architecture)
  const [emailTab, setEmailTab] = useState<'gateway' | 'templates' | 'policies'>('gateway');
  
  // 1. Gateway Config (SMTP/Resend)
  const [emailGateway, setEmailGateway] = useState<any>({
      delivery_method: 'resend', // 'smtp' | 'resend' | 'webhook'
      from_email: 'noreply@cascata.io',
      resend_api_key: '',
      smtp_host: '',
      smtp_port: 587,
      smtp_user: '',
      smtp_pass: '',
      smtp_secure: false,
      webhook_url: ''
  });

  // 2. Templates Config
  const [emailTemplates, setEmailTemplates] = useState<any>({
      confirmation: { subject: 'Confirm Your Email', body: '<h2>Confirm your email</h2><p>Click the link below to confirm your email address:</p><p><a href="{{ .ConfirmationURL }}">Confirm Email</a></p>' },
      recovery: { subject: 'Reset Your Password', body: '<h2>Reset Password</h2><p>Click here to reset your password:</p><a href="{{ .ConfirmationURL }}">Reset Password</a>' },
      magic_link: { subject: 'Your Login Link', body: '<h2>Login Request</h2><p>Click here to login:</p><a href="{{ .ConfirmationURL }}">Sign In</a>' },
      login_alert: { subject: 'New Login Detected', body: '<h2>New Login</h2><p>We detected a new login to your account at {{ .Date }}.</p>' },
      welcome_email: { subject: 'Welcome!', body: '<h2>Welcome to our platform!</h2><p>We are glad to have you with us.</p>' }
  });
  const [activeTemplateTab, setActiveTemplateTab] = useState<'confirmation' | 'recovery' | 'magic_link' | 'login_alert' | 'welcome_email'>('confirmation');

  // 3. Policies Config
  const [emailPolicies, setEmailPolicies] = useState({
      email_confirmation: false,
      disable_magic_link: false,
      send_welcome_email: false,
      send_login_alert: false,
      login_webhook_url: ''
  });
  
  // PROVIDER CONFIG
  const [providerConfig, setProviderConfig] = useState<any>({ client_id: '', client_secret: '' });
  const [showProviderConfig, setShowProviderConfig] = useState<string | null>(null);
  
  // LINKED TABLES (Concatenation)
  const [availableTables, setAvailableTables] = useState<string[]>([]);
  const [linkedTables, setLinkedTables] = useState<string[]>([]);
  const [projectDomain, setProjectDomain] = useState<string>('');

  // CUSTOM STRATEGY STATE
  const [newStrategyName, setNewStrategyName] = useState('');
  const [showNewStrategy, setShowNewStrategy] = useState(false);

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
      // Fetch users with higher limit to maintain list behavior
      const [usersRes, projRes, tablesRes] = await Promise.all([
        fetch(`/api/data/${projectId}/auth/users?limit=1000`, { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/control/projects', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch(`/api/data/${projectId}/tables`, { headers: { 'Authorization': `Bearer ${token}` } })
      ]);
      
      if (!usersRes.ok || !projRes.ok || !tablesRes.ok) {
          throw new Error("Falha na comunicação com o servidor.");
      }

      const usersData = await usersRes.json();
      // Handle both legacy array and new paginated object structure
      const userList = Array.isArray(usersData) ? usersData : (usersData.data || []);
      setUsers(userList);
      
      const projects = await projRes.json();
      const currentProj = Array.isArray(projects) ? projects.find((p: any) => p.slug === projectId) : null;
      
      // Store Project Info
      setProjectDomain(currentProj?.custom_domain || '');
      setSiteUrl(currentProj?.metadata?.auth_config?.site_url || '');
      
      // Load Security Config
      const sec = currentProj?.metadata?.auth_config?.security || {};
      setSecurityConfig({
          max_attempts: sec.max_attempts || 5,
          lockout_minutes: sec.lockout_minutes || 15,
          strategy: sec.strategy || 'hybrid'
      });

      // Load Email Gateway & Policies
      const authConfig = currentProj?.metadata?.auth_config || {};
      const strategyEmail = currentProj?.metadata?.auth_strategies?.email || {};
      
      // Merge Gateway Config
      setEmailGateway(prev => ({ ...prev, ...strategyEmail }));
      
      // Merge Policies
      setEmailPolicies({
          email_confirmation: authConfig.email_confirmation || false,
          disable_magic_link: authConfig.disable_magic_link || false,
          send_welcome_email: authConfig.send_welcome_email || false,
          send_login_alert: authConfig.send_login_alert || false,
          login_webhook_url: authConfig.login_webhook_url || ''
      });

      // Load Email Templates
      if (authConfig.email_templates) {
          setEmailTemplates((prev: any) => ({ ...prev, ...authConfig.email_templates }));
      }

      // Load Global Origins
      const rawOrigins = currentProj?.metadata?.allowed_origins || [];
      setGlobalOrigins(rawOrigins.map((o: any) => typeof o === 'string' ? o : o.url));

      // Load Strategies
      const savedStrategies = currentProj?.metadata?.auth_strategies || {};
      const defaultStrategies = {
        email: { enabled: true, rules: [], jwt_expiration: '24h', refresh_validity_days: 30 },
        google: { enabled: false, rules: [], jwt_expiration: '24h', refresh_validity_days: 30 },
        github: { enabled: false, rules: [], jwt_expiration: '24h', refresh_validity_days: 30 }
      };
      setStrategies({ ...defaultStrategies, ...savedStrategies });
      
      // Load Tables
      const tables = await tablesRes.json();
      setAvailableTables(Array.isArray(tables) ? tables.map((t: any) => t.name) : []);
      setLinkedTables(currentProj?.metadata?.linked_tables || []);

    } catch (e: any) {
      console.error("Fetch Error", e);
      setError(e.message || "Erro ao carregar dados.");
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

        // Optimistic Update
        setStrategies(newStrategies);
        if (newLinkedTables) setLinkedTables(newLinkedTables);

        // Merge Auth Config (Preserve existing providers/settings)
        const projRes = await fetch('/api/control/projects', { headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` } });
        const projects = await projRes.json();
        const currentProj = projects.find((p: any) => p.slug === projectId);
        const currentMetadata = currentProj?.metadata || {};
        
        let finalAuthConfig = currentMetadata.auth_config || {};
        if (authConfig) {
            // Merge All Top Level Keys
            finalAuthConfig = { ...finalAuthConfig, ...authConfig };
        }

        body.authConfig = finalAuthConfig;

        await fetch(`/api/data/${projectId}/auth/link`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
            body: JSON.stringify(body)
        });
        
        setSuccess("Configuração salva.");
        setTimeout(() => setSuccess(null), 2000);
    } catch (e) { 
        setError("Falha ao salvar."); 
        fetchData(); 
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

  const handleSaveSiteUrl = () => {
      saveStrategies(strategies, { site_url: siteUrl });
  };

  const handleSaveSecurity = () => {
      saveStrategies(strategies, { security: securityConfig });
  };

  const handleSaveEmailCenter = () => {
      // 1. Update Strategy 'email' with Gateway Config
      const updatedStrategies = {
          ...strategies,
          email: {
              ...strategies.email,
              ...emailGateway
          }
      };

      // 2. Update Auth Config with Policies & Templates
      const updatedAuthConfig = {
          email_templates: emailTemplates,
          ...emailPolicies
      };

      saveStrategies(updatedStrategies, updatedAuthConfig);
  };

  const openProviderConfig = async (provider: string) => {
      setShowProviderConfig(provider);
      try {
          const projRes = await fetch('/api/control/projects', { headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` } });
          const projects = await projRes.json();
          const currentProj = projects.find((p: any) => p.slug === projectId);
          const conf = currentProj?.metadata?.auth_config?.providers?.[provider] || { client_id: '', client_secret: '', authorized_clients: '', skip_nonce: false };
          setProviderConfig(conf);
      } catch (e) {}
  };

  const handleSaveProviderConfig = () => {
      if (!showProviderConfig) return;
      // We pass just the specific provider update, assuming saveStrategies merges correctly
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

  const handleLinkIdentity = async () => {
      if (!selectedUser) return;
      setExecuting(true);
      try {
          const res = await fetch(`/api/data/${projectId}/auth/users/${selectedUser.id}/identities`, {
              method: 'POST',
              headers: { 
                  'Content-Type': 'application/json', 
                  'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` 
              },
              body: JSON.stringify(linkIdentityForm)
          });
          
          if (!res.ok) {
              const err = await res.json();
              throw new Error(err.error || "Failed to link identity");
          }

          setSuccess("Nova identidade vinculada.");
          setShowLinkIdentity(false);
          setLinkIdentityForm({ provider: 'email', identifier: '', password: '' });
          
          // Refresh user data
          fetchData();
          setShowUserModal(false); 

      } catch (e: any) {
          setError(e.message);
      } finally {
          setExecuting(false);
      }
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
          fetchData();
          setShowUserModal(false);
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
          [key]: { 
              enabled: true, 
              rules: [], 
              jwt_expiration: '24h', 
              refresh_validity_days: 30,
              otp_config: { length: 6, charset: 'numeric' } 
          } 
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
    if (!Array.isArray(users)) return [];
    
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
  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / pageSize));

  const isOauth = (s: string) => ['google', 'github', 'facebook', 'twitter'].includes(s);

  const isAggressiveSecurity = securityConfig.max_attempts < 3 || securityConfig.lockout_minutes > 60;

  // --- CALLBACK URL HELPER ---
  const getCallbackUrl = () => {
      const host = projectDomain || window.location.host;
      const protocol = projectDomain ? 'https' : window.location.protocol.replace(':', '');
      const prefix = projectDomain ? '' : `/api/data/${projectId}`;
      return `${protocol}://${host}${prefix}/auth/v1/callback`;
  };

  return (
    <div className="flex h-full flex-col bg-[#F8FAFC]">
      {(error || success) && (
        <div className={`fixed top-8 left-1/2 -translate-x-1/2 z-[600] px-6 py-4 rounded-full shadow-2xl flex items-center gap-3 animate-in slide-in-from-top-4 ${error ? 'bg-rose-600 text-white' : 'bg-emerald-600 text-white'}`}>
          {error ? <AlertCircle size={18}/> : <CheckCircle2 size={18}/>}
          <span className="text-xs font-bold">{error || success}</span>
          <button onClick={() => { setError(null); setSuccess(null); }}><X size={14} className="opacity-60 hover:opacity-100"/></button>
        </div>
      )}
      
      {/* HEADER SECTION */}
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
          // DIRECTORY VIEW
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
                   {paginatedUsers.length === 0 && <p className="text-center py-10 text-slate-400 font-bold text-xs uppercase">No users found</p>}
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
                                  <div className="flex gap-4 mt-1">
                                      <p className="text-[10px] text-slate-400 font-bold">Created: {new Date(u.created_at).toLocaleDateString()}</p>
                                      {u.email_confirmed_at && <p className="text-[10px] text-emerald-500 font-bold flex items-center gap-1"><CheckCircle2 size={10}/> Verified</p>}
                                  </div>
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
             
             {/* GLOBAL SETTINGS (REDIRECT) */}
             <div className="bg-white border border-slate-200 rounded-[3rem] p-12 shadow-sm">
                <div className="flex items-center gap-4 mb-8">
                   <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center"><LayoutTemplate size={20}/></div>
                   <div>
                      <h3 className="text-2xl font-black text-slate-900 tracking-tight">Global Config</h3>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Site URL & Redirects</p>
                   </div>
                </div>
                <div className="space-y-4">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Default Site URL (Redirect Fallback)</label>
                    <div className="flex gap-3">
                        <input 
                            value={siteUrl} 
                            onChange={(e) => setSiteUrl(e.target.value)} 
                            placeholder="https://meu-app.com" 
                            className="flex-1 bg-slate-50 border border-slate-200 rounded-2xl py-3 px-6 text-sm font-bold text-slate-900 outline-none focus:ring-4 focus:ring-emerald-500/10" 
                        />
                        <button onClick={handleSaveSiteUrl} disabled={executing} className="bg-emerald-600 text-white px-6 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-emerald-700 transition-all">Salvar</button>
                    </div>
                    <p className="text-[10px] text-slate-400 px-2 font-medium">Usado quando nenhum <code>redirect_to</code> é fornecido no fluxo OAuth ou Magic Link.</p>
                </div>
             </div>

             {/* EMAIL COMMUNICATION CENTER (REDESIGNED) */}
             <div className="bg-white border border-slate-200 rounded-[3rem] p-12 shadow-sm">
                <div className="flex items-center justify-between mb-8">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center"><MessageSquare size={20}/></div>
                        <div>
                            <h3 className="text-2xl font-black text-slate-900 tracking-tight">Communication Center</h3>
                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Email Strategy & Templates</p>
                        </div>
                    </div>
                </div>

                {/* TABS */}
                <div className="flex gap-2 p-1 bg-slate-100 rounded-2xl mb-8 w-fit">
                    {['gateway', 'templates', 'policies'].map((t) => (
                        <button 
                            key={t}
                            onClick={() => setEmailTab(t as any)}
                            className={`px-6 py-2.5 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all ${emailTab === t ? 'bg-white shadow text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
                        >
                            {t}
                        </button>
                    ))}
                </div>

                {/* TAB 1: GATEWAY (PROVIDER CONFIG) */}
                {emailTab === 'gateway' && (
                    <div className="space-y-8 animate-in fade-in slide-in-from-right-2">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                            <div className="space-y-4">
                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Delivery Method</label>
                                <div className="grid grid-cols-3 gap-3">
                                    <button onClick={() => setEmailGateway({...emailGateway, delivery_method: 'smtp'})} className={`py-4 rounded-2xl border text-xs font-bold transition-all flex flex-col items-center gap-2 ${emailGateway.delivery_method === 'smtp' ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'border-slate-200 text-slate-400'}`}>
                                        <Server size={18}/> SMTP
                                    </button>
                                    <button onClick={() => setEmailGateway({...emailGateway, delivery_method: 'resend'})} className={`py-4 rounded-2xl border text-xs font-bold transition-all flex flex-col items-center gap-2 ${emailGateway.delivery_method === 'resend' ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'border-slate-200 text-slate-400'}`}>
                                        <Send size={18}/> Resend
                                    </button>
                                    <button onClick={() => setEmailGateway({...emailGateway, delivery_method: 'webhook'})} className={`py-4 rounded-2xl border text-xs font-bold transition-all flex flex-col items-center gap-2 ${emailGateway.delivery_method === 'webhook' ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'border-slate-200 text-slate-400'}`}>
                                        <Plug size={18}/> Webhook
                                    </button>
                                </div>
                            </div>
                            
                            <div className="space-y-2">
                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Sender Email (From)</label>
                                <input 
                                    value={emailGateway.from_email} 
                                    onChange={(e) => setEmailGateway({...emailGateway, from_email: e.target.value})}
                                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none"
                                    placeholder="noreply@myapp.com"
                                />
                            </div>
                        </div>

                        {emailGateway.delivery_method === 'resend' && (
                            <div className="space-y-2">
                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Resend API Key</label>
                                <input 
                                    type="password"
                                    value={emailGateway.resend_api_key || ''} 
                                    onChange={(e) => setEmailGateway({...emailGateway, resend_api_key: e.target.value})}
                                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none font-mono"
                                    placeholder="re_123..."
                                />
                            </div>
                        )}

                        {emailGateway.delivery_method === 'smtp' && (
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">SMTP Host</label>
                                    <input 
                                        value={emailGateway.smtp_host || ''} 
                                        onChange={(e) => setEmailGateway({...emailGateway, smtp_host: e.target.value})}
                                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none"
                                        placeholder="smtp.gmail.com"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Port</label>
                                    <input 
                                        value={emailGateway.smtp_port || 587} 
                                        onChange={(e) => setEmailGateway({...emailGateway, smtp_port: parseInt(e.target.value)})}
                                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none"
                                        type="number"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">User</label>
                                    <input 
                                        value={emailGateway.smtp_user || ''} 
                                        onChange={(e) => setEmailGateway({...emailGateway, smtp_user: e.target.value})}
                                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Password</label>
                                    <input 
                                        type="password"
                                        value={emailGateway.smtp_pass || ''} 
                                        onChange={(e) => setEmailGateway({...emailGateway, smtp_pass: e.target.value})}
                                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none"
                                    />
                                </div>
                            </div>
                        )}

                        {emailGateway.delivery_method === 'webhook' && (
                            <div className="space-y-2">
                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Webhook URL</label>
                                <input 
                                    value={emailGateway.webhook_url || ''} 
                                    onChange={(e) => setEmailGateway({...emailGateway, webhook_url: e.target.value})}
                                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none"
                                    placeholder="https://n8n.webhook/..."
                                />
                            </div>
                        )}
                        
                        <div className="pt-4 border-t border-slate-100">
                            <button onClick={handleSaveEmailCenter} disabled={executing} className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-600 transition-all flex items-center justify-center gap-2">
                                {executing ? <Loader2 className="animate-spin" size={14}/> : 'Save Connection Settings'}
                            </button>
                        </div>
                    </div>
                )}

                {/* TAB 2: TEMPLATES */}
                {emailTab === 'templates' && (
                    <div className="space-y-6 animate-in fade-in slide-in-from-right-2">
                        <div className="flex gap-2 p-1 bg-slate-50 rounded-xl border border-slate-100 overflow-x-auto">
                            {['confirmation', 'recovery', 'magic_link', 'login_alert', 'welcome_email'].map((t) => (
                                <button 
                                    key={t}
                                    onClick={() => setActiveTemplateTab(t as any)}
                                    className={`flex-1 py-2 px-4 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all whitespace-nowrap ${activeTemplateTab === t ? 'bg-white shadow text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
                                >
                                    {t.replace('_', ' ')}
                                </button>
                            ))}
                        </div>

                        <div className="space-y-4">
                            <div className="space-y-2">
                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Subject</label>
                                <input 
                                    value={emailTemplates[activeTemplateTab]?.subject || ''}
                                    onChange={(e) => setEmailTemplates({...emailTemplates, [activeTemplateTab]: { ...emailTemplates[activeTemplateTab], subject: e.target.value }})}
                                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-6 text-sm font-bold text-slate-900 outline-none"
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">HTML Body</label>
                                <textarea 
                                    value={emailTemplates[activeTemplateTab]?.body || ''}
                                    onChange={(e) => setEmailTemplates({...emailTemplates, [activeTemplateTab]: { ...emailTemplates[activeTemplateTab], body: e.target.value }})}
                                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-6 text-sm font-medium text-slate-900 outline-none min-h-[250px] font-mono"
                                />
                                <p className="text-[10px] text-slate-400 px-2">Variables: <code>{"{{ .ConfirmationURL }}"}</code>, <code>{"{{ .Token }}"}</code>, <code>{"{{ .Email }}"}</code>, <code>{"{{ .Date }}"}</code></p>
                            </div>
                        </div>

                        <button onClick={handleSaveEmailCenter} disabled={executing} className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-600 transition-all flex items-center justify-center gap-2">
                            {executing ? <Loader2 className="animate-spin" size={14}/> : 'Save Templates'}
                        </button>
                    </div>
                )}

                {/* TAB 3: POLICIES (FLOWS) */}
                {emailTab === 'policies' && (
                    <div className="space-y-8 animate-in fade-in slide-in-from-right-2">
                        <div className="grid grid-cols-1 gap-4">
                            <div className={`p-6 rounded-[2rem] border transition-all cursor-pointer ${emailPolicies.email_confirmation ? 'bg-indigo-50 border-indigo-200' : 'bg-slate-50 border-slate-200'}`} onClick={() => setEmailPolicies(p => ({...p, email_confirmation: !p.email_confirmation}))}>
                                <div className="flex justify-between items-center">
                                    <div>
                                        <h4 className={`font-bold text-sm ${emailPolicies.email_confirmation ? 'text-indigo-900' : 'text-slate-500'}`}>Require Email Confirmation</h4>
                                        <p className="text-[10px] text-slate-400 mt-1">Users cannot login until they verify their email address.</p>
                                    </div>
                                    <div className={`w-12 h-7 rounded-full p-1 transition-colors ${emailPolicies.email_confirmation ? 'bg-indigo-600' : 'bg-slate-300'}`}>
                                        <div className={`w-5 h-5 bg-white rounded-full shadow-md transition-transform ${emailPolicies.email_confirmation ? 'translate-x-5' : ''}`}></div>
                                    </div>
                                </div>
                            </div>

                            <div className={`p-6 rounded-[2rem] border transition-all cursor-pointer ${emailPolicies.disable_magic_link ? 'bg-rose-50 border-rose-200' : 'bg-slate-50 border-slate-200'}`} onClick={() => setEmailPolicies(p => ({...p, disable_magic_link: !p.disable_magic_link}))}>
                                <div className="flex justify-between items-center">
                                    <div>
                                        <h4 className={`font-bold text-sm ${emailPolicies.disable_magic_link ? 'text-rose-900' : 'text-slate-500'}`}>Disable Magic Link Login</h4>
                                        <p className="text-[10px] text-slate-400 mt-1">Prevent users from logging in via passwordless email links.</p>
                                    </div>
                                    <div className={`w-12 h-7 rounded-full p-1 transition-colors ${emailPolicies.disable_magic_link ? 'bg-rose-600' : 'bg-slate-300'}`}>
                                        <div className={`w-5 h-5 bg-white rounded-full shadow-md transition-transform ${emailPolicies.disable_magic_link ? 'translate-x-5' : ''}`}></div>
                                    </div>
                                </div>
                            </div>

                            <div className={`p-6 rounded-[2rem] border transition-all cursor-pointer ${emailPolicies.send_welcome_email ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50 border-slate-200'}`} onClick={() => setEmailPolicies(p => ({...p, send_welcome_email: !p.send_welcome_email}))}>
                                <div className="flex justify-between items-center">
                                    <div>
                                        <h4 className={`font-bold text-sm ${emailPolicies.send_welcome_email ? 'text-emerald-900' : 'text-slate-500'}`}><PartyPopper className="inline mr-2" size={14}/> Send Welcome Email</h4>
                                        <p className="text-[10px] text-slate-400 mt-1">Automatically send a greeting message upon signup (or verification).</p>
                                    </div>
                                    <div className={`w-12 h-7 rounded-full p-1 transition-colors ${emailPolicies.send_welcome_email ? 'bg-emerald-500' : 'bg-slate-300'}`}>
                                        <div className={`w-5 h-5 bg-white rounded-full shadow-md transition-transform ${emailPolicies.send_welcome_email ? 'translate-x-5' : ''}`}></div>
                                    </div>
                                </div>
                            </div>

                            <div className={`p-6 rounded-[2rem] border transition-all cursor-pointer ${emailPolicies.send_login_alert ? 'bg-amber-50 border-amber-200' : 'bg-slate-50 border-slate-200'}`} onClick={() => setEmailPolicies(p => ({...p, send_login_alert: !p.send_login_alert}))}>
                                <div className="flex justify-between items-center">
                                    <div>
                                        <h4 className={`font-bold text-sm ${emailPolicies.send_login_alert ? 'text-amber-900' : 'text-slate-500'}`}><BellRing className="inline mr-2" size={14}/> Login Notification Email</h4>
                                        <p className="text-[10px] text-slate-400 mt-1">Notify user via email every time a successful login occurs.</p>
                                    </div>
                                    <div className={`w-12 h-7 rounded-full p-1 transition-colors ${emailPolicies.send_login_alert ? 'bg-amber-500' : 'bg-slate-300'}`}>
                                        <div className={`w-5 h-5 bg-white rounded-full shadow-md transition-transform ${emailPolicies.send_login_alert ? 'translate-x-5' : ''}`}></div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="pt-4 border-t border-slate-100">
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 mb-2 block">Login Webhook URL (Optional)</label>
                            <input 
                                value={emailPolicies.login_webhook_url || ''} 
                                onChange={(e) => setEmailPolicies(p => ({...p, login_webhook_url: e.target.value}))}
                                className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none"
                                placeholder="https://api.myapp.com/webhooks/login"
                            />
                            <p className="text-[10px] text-slate-400 mt-2 px-1">If set, a POST request will be sent here every time a user successfully logs in.</p>
                        </div>

                        <button onClick={handleSaveEmailCenter} disabled={executing} className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-600 transition-all flex items-center justify-center gap-2">
                            {executing ? <Loader2 className="animate-spin" size={14}/> : 'Update Policies'}
                        </button>
                    </div>
                )}
             </div>
             
             {/* SECURITY & PROTECTION (Existing) */}
             <div className="bg-white border border-slate-200 rounded-[3rem] p-12 shadow-sm">
                <div className="flex items-center gap-4 mb-8">
                   <div className="w-12 h-12 bg-rose-50 text-rose-600 rounded-2xl flex items-center justify-center"><ShieldAlert size={20}/></div>
                   <div>
                      <h3 className="text-2xl font-black text-slate-900 tracking-tight">Smart Lockout</h3>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Brute Force Protection</p>
                   </div>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
                    <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Max Attempts (Threshold)</label>
                        <div className="flex items-center bg-slate-50 border border-slate-200 rounded-2xl px-4">
                            <Target size={16} className="text-rose-400" />
                            <input 
                                type="number"
                                min="1"
                                value={securityConfig.max_attempts} 
                                onChange={(e) => setSecurityConfig({...securityConfig, max_attempts: parseInt(e.target.value)})} 
                                className="w-full bg-transparent border-none py-3 px-4 text-sm font-bold text-slate-900 outline-none" 
                            />
                        </div>
                    </div>
                    <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Lockout Duration (Minutes)</label>
                        <div className="flex items-center bg-slate-50 border border-slate-200 rounded-2xl px-4">
                            <Clock size={16} className="text-indigo-400" />
                            <input 
                                type="number"
                                min="1"
                                value={securityConfig.lockout_minutes} 
                                onChange={(e) => setSecurityConfig({...securityConfig, lockout_minutes: parseInt(e.target.value)})} 
                                className="w-full bg-transparent border-none py-3 px-4 text-sm font-bold text-slate-900 outline-none" 
                            />
                        </div>
                    </div>
                </div>

                <div className="space-y-3 mb-8">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Protection Strategy</label>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <button 
                            onClick={() => setSecurityConfig({...securityConfig, strategy: 'hybrid'})}
                            className={`p-4 rounded-2xl border text-left transition-all ${securityConfig.strategy === 'hybrid' ? 'bg-indigo-600 border-indigo-600 text-white shadow-lg' : 'bg-white border-slate-200 text-slate-500 hover:border-indigo-300'}`}
                        >
                            <span className="text-xs font-black uppercase block mb-1">Hybrid (Best)</span>
                            <span className={`text-[10px] ${securityConfig.strategy === 'hybrid' ? 'text-indigo-200' : 'text-slate-400'}`}>Locks IP + Email pair. Safest for offices/NAT.</span>
                        </button>
                        <button 
                            onClick={() => setSecurityConfig({...securityConfig, strategy: 'ip'})}
                            className={`p-4 rounded-2xl border text-left transition-all ${securityConfig.strategy === 'ip' ? 'bg-indigo-600 border-indigo-600 text-white shadow-lg' : 'bg-white border-slate-200 text-slate-500 hover:border-indigo-300'}`}
                        >
                            <span className="text-xs font-black uppercase block mb-1">Strict IP</span>
                            <span className={`text-[10px] ${securityConfig.strategy === 'ip' ? 'text-indigo-200' : 'text-slate-400'}`}>Locks IP address entirely. Good vs Bots.</span>
                        </button>
                        <button 
                            onClick={() => setSecurityConfig({...securityConfig, strategy: 'email'})}
                            className={`p-4 rounded-2xl border text-left transition-all ${securityConfig.strategy === 'email' ? 'bg-indigo-600 border-indigo-600 text-white shadow-lg' : 'bg-white border-slate-200 text-slate-500 hover:border-indigo-300'}`}
                        >
                            <span className="text-xs font-black uppercase block mb-1">Email Only</span>
                            <span className={`text-[10px] ${securityConfig.strategy === 'email' ? 'text-indigo-200' : 'text-slate-400'}`}>Protects specific account. Vulnerable to distributed attacks.</span>
                        </button>
                    </div>
                </div>

                {isAggressiveSecurity && (
                    <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl flex items-start gap-3 mb-6 animate-in fade-in slide-in-from-top-2">
                        <AlertCircle className="text-amber-600 shrink-0 mt-0.5" size={18}/>
                        <div>
                            <h4 className="text-xs font-black text-amber-700 uppercase">Atenção: Configuração Agressiva</h4>
                            <p className="text-[10px] text-amber-600 mt-1 leading-relaxed">
                                Você definiu um limite muito baixo de tentativas ou um tempo de bloqueio muito longo. Isso pode causar bloqueios acidentais de administradores ou usuários legítimos. Certifique-se de que o fluxo de "Esqueci minha senha" está funcional.
                            </p>
                        </div>
                    </div>
                )}

                <button onClick={handleSaveSecurity} disabled={executing} className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-600 transition-all flex items-center justify-center gap-2">
                    {executing ? <Loader2 className="animate-spin" size={14}/> : 'Aplicar Políticas de Segurança'}
                </button>
             </div>

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
                 {Object.keys(strategies)
                   .filter(stKey => !['google', 'github'].includes(stKey)) // Filter out social providers from this list
                   .map(stKey => {
                    const config = strategies[stKey];
                    const isDefault = ['email'].includes(stKey);
                    
                    return (
                       <div key={stKey} className={`relative bg-white border rounded-[2.5rem] p-8 shadow-sm transition-all group ${config.enabled ? 'border-indigo-200' : 'border-slate-200 opacity-70'}`}>
                          <div className="flex justify-between items-start mb-6">
                             <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-white shadow-lg ${config.enabled ? 'bg-indigo-600' : 'bg-slate-300'}`}>
                                {stKey === 'email' && <Mail size={24}/>}
                                {stKey === 'cpf' && <CreditCard size={24}/>}
                                {stKey === 'phone' && <Smartphone size={24}/>}
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
                     <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Status</label>
                        <button 
                           onClick={() => setStrategyConfig({...strategyConfig, enabled: !strategyConfig.enabled})}
                           className={`w-full py-3 rounded-xl border flex items-center justify-center gap-2 transition-all ${strategyConfig.enabled ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-slate-50 border-slate-200 text-slate-400'}`}
                        >
                           {strategyConfig.enabled ? <><CheckCircle2 size={16}/> Enabled</> : 'Disabled'}
                        </button>
                     </div>
                     <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">JWT Expiration</label>
                        <input value={strategyConfig.jwt_expiration || '24h'} onChange={(e) => setStrategyConfig({...strategyConfig, jwt_expiration: e.target.value})} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold outline-none"/>
                     </div>
                     <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Refresh Validity (Days)</label>
                        <input type="number" value={strategyConfig.refresh_validity_days || 30} onChange={(e) => setStrategyConfig({...strategyConfig, refresh_validity_days: parseInt(e.target.value)})} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold outline-none"/>
                     </div>
                  </div>

                  {/* EDUCATIONAL SNIPPET FOR CUSTOM STRATEGIES */}
                  {!isOauth(selectedStrategy || '') && selectedStrategy !== 'email' && (
                     <div className="bg-slate-900 rounded-2xl p-6 border border-slate-800 shadow-xl overflow-hidden relative group">
                         <div className="flex justify-between items-center mb-4">
                             <h4 className="text-emerald-400 font-black text-xs uppercase tracking-widest flex items-center gap-2"><Code size={14}/> Integration Snippet</h4>
                             <button onClick={() => safeCopy(`
// Universal Login (Any Provider)
const { user, session } = await cascata.auth.signIn({
  provider: '${selectedStrategy}',
  identifier: 'unique_user_id',
  password: 'user_password'
});`)} className="text-slate-500 hover:text-white transition-colors p-1"><Copy size={14}/></button>
                         </div>
                         <pre className="text-[10px] font-mono text-slate-300 whitespace-pre-wrap leading-relaxed">
{`// Universal Login (Any Provider)
const { user, session } = await cascata.auth.signIn({
  provider: '${selectedStrategy}',
  identifier: 'unique_user_id',
  password: 'user_password'
});`}
                         </pre>
                         <div className="mt-4 p-3 bg-white/5 rounded-xl border border-white/10 text-[10px] text-slate-400 leading-relaxed">
                             Use <strong>Universal Login</strong> to authenticate with this custom strategy. 
                             Unlike standard email login, this endpoint accepts any provider identifier you define.
                         </div>
                     </div>
                  )}

                  {/* RESTORED OTP CONFIGURATION BLOCK (Only for non-OAuth strategies) */}
                  {!isOauth(selectedStrategy || '') && selectedStrategy !== 'email' && (
                     <div className="col-span-2 bg-indigo-50 border border-indigo-100 p-6 rounded-3xl space-y-4">
                         <h5 className="font-bold text-indigo-900 text-sm flex items-center gap-2"><Hash size={14}/> Custom OTP Configuration</h5>
                         <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="text-[9px] font-black text-indigo-400 uppercase tracking-widest">Code Length</label>
                                <input 
                                    type="number"
                                    value={strategyConfig.otp_config?.length || 6}
                                    onChange={(e) => setStrategyConfig({...strategyConfig, otp_config: { ...strategyConfig.otp_config, length: parseInt(e.target.value) }})}
                                    className="w-full mt-1 bg-white border-none rounded-xl py-2 px-3 text-xs font-bold"
                                />
                            </div>
                            <div>
                                <label className="text-[9px] font-black text-indigo-400 uppercase tracking-widest">Charset</label>
                                <select 
                                    value={strategyConfig.otp_config?.charset || 'numeric'}
                                    onChange={(e) => setStrategyConfig({...strategyConfig, otp_config: { ...strategyConfig.otp_config, charset: e.target.value }})}
                                    className="w-full mt-1 bg-white border-none rounded-xl py-2 px-3 text-xs font-bold outline-none"
                                >
                                    <option value="numeric">Numeric (0-9)</option>
                                    <option value="alphanumeric">Alphanumeric (A-Z, 0-9)</option>
                                    <option value="alpha">Alpha (A-Z)</option>
                                    <option value="hex">Hex (0-9, A-F)</option>
                                </select>
                            </div>
                            <div className="col-span-2">
                                <label className="text-[9px] font-black text-indigo-400 uppercase tracking-widest">Identifier Regex (Backend Validation)</label>
                                <input 
                                    value={strategyConfig.otp_config?.regex_validation || ''}
                                    onChange={(e) => setStrategyConfig({...strategyConfig, otp_config: { ...strategyConfig.otp_config, regex_validation: e.target.value }})}
                                    placeholder="e.g. ^\d{11}$ (CPF)"
                                    className="w-full mt-1 bg-white border-none rounded-xl py-2 px-3 text-xs font-mono font-bold"
                                />
                            </div>
                            <div className="col-span-2">
                                <label className="text-[9px] font-black text-indigo-400 uppercase tracking-widest">OTP Webhook URL</label>
                                <input 
                                    value={strategyConfig.webhook_url || ''}
                                    onChange={(e) => setStrategyConfig({...strategyConfig, webhook_url: e.target.value})}
                                    placeholder="https://n8n.webhook/send-otp"
                                    className="w-full mt-1 bg-white border-none rounded-xl py-2 px-3 text-xs font-bold"
                                />
                            </div>
                         </div>
                     </div>
                  )}

                  <div className="space-y-3">
                     <div className="flex justify-between items-center">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Authorized Origins (CORS/Redirects)</label>
                        <button onClick={() => addRuleToStrategy(strategyConfig.newRule || '', false)} className="text-[10px] font-black text-indigo-600 uppercase hover:underline">+ Add Origin</button>
                     </div>
                     <div className="space-y-2">
                        {strategyConfig.rules?.map((rule: any, idx: number) => (
                           <div key={idx} className="flex items-center justify-between bg-slate-50 p-3 rounded-xl border border-slate-100">
                              <span className="text-xs font-mono font-bold text-slate-600">{rule.origin}</span>
                              <button onClick={() => removeRuleFromStrategy(rule.origin)} className="text-rose-400 hover:text-rose-600"><X size={14}/></button>
                           </div>
                        ))}
                        {(!strategyConfig.rules || strategyConfig.rules.length === 0) && <p className="text-xs text-slate-400 italic">No origin rules defined (Public).</p>}
                     </div>
                  </div>
               </div>

               <div className="pt-8 border-t border-slate-100 flex justify-end gap-4 mt-auto">
                  <button onClick={() => setShowConfigModal(false)} className="px-6 py-4 rounded-2xl text-xs font-black text-slate-400 uppercase tracking-widest hover:bg-slate-50">Cancel</button>
                  <button onClick={handleSaveStrategyConfig} className="px-8 py-4 bg-indigo-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-xl hover:bg-indigo-700">Save Changes</button>
               </div>
            </div>
         </div>
      )}

      {/* CREATE USER MODAL */}
      {showCreateUser && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
              <div className="bg-white rounded-[3rem] w-full max-w-md p-10 shadow-2xl relative">
                  <button onClick={() => setShowCreateUser(false)} className="absolute top-8 right-8 text-slate-300 hover:text-slate-900"><X size={24}/></button>
                  <h3 className="text-2xl font-black text-slate-900 mb-6">Create User</h3>
                  <div className="space-y-4">
                      <div className="space-y-2">
                          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Identifier (Email/Phone)</label>
                          <input value={createUserForm.identifier} onChange={(e) => setCreateUserForm({...createUserForm, identifier: e.target.value})} className="w-full bg-slate-50 border-none rounded-2xl py-3 px-4 text-sm font-bold outline-none" placeholder="user@example.com"/>
                      </div>
                      <div className="space-y-2">
                          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Password</label>
                          <input type="password" value={createUserForm.password} onChange={(e) => setCreateUserForm({...createUserForm, password: e.target.value})} className="w-full bg-slate-50 border-none rounded-2xl py-3 px-4 text-sm font-bold outline-none" placeholder="••••••••"/>
                      </div>
                      <div className="space-y-2">
                          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Provider</label>
                          <select value={createUserForm.provider} onChange={(e) => setCreateUserForm({...createUserForm, provider: e.target.value})} className="w-full bg-slate-50 border-none rounded-2xl py-3 px-4 text-sm font-bold outline-none">
                              <option value="email">Email</option>
                              <option value="phone">Phone</option>
                              <option value="cpf">CPF</option>
                              <option value="gamertag">Gamertag</option>
                          </select>
                      </div>
                      <button onClick={handleCreateUser} disabled={executing} className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl mt-4 hover:bg-indigo-700 transition-all">
                          {executing ? <Loader2 className="animate-spin mx-auto"/> : 'Create User'}
                      </button>
                  </div>
              </div>
          </div>
      )}

      {/* NEW STRATEGY MODAL */}
      {showNewStrategy && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
              <div className="bg-white rounded-[3rem] w-full max-w-sm p-10 shadow-2xl relative">
                  <h3 className="text-xl font-black text-slate-900 mb-4">Add Custom Strategy</h3>
                  <input autoFocus value={newStrategyName} onChange={(e) => setNewStrategyName(e.target.value)} placeholder="Strategy Name (e.g. biometrics)" className="w-full bg-slate-50 border-none rounded-2xl py-3 px-4 text-sm font-bold outline-none mb-6"/>
                  <div className="flex gap-4">
                      <button onClick={() => setShowNewStrategy(false)} className="flex-1 py-3 text-slate-400 font-bold text-xs uppercase hover:bg-slate-50 rounded-xl">Cancel</button>
                      <button onClick={handleCreateCustomStrategy} className="flex-1 py-3 bg-indigo-600 text-white rounded-xl font-bold text-xs uppercase shadow-lg hover:bg-indigo-700">Create</button>
                  </div>
              </div>
          </div>
      )}

      {/* PROVIDER CONFIG MODAL */}
      {showProviderConfig && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
            <div className="bg-white rounded-[3rem] w-full max-w-md p-10 shadow-2xl relative">
                <button onClick={() => setShowProviderConfig(null)} className="absolute top-8 right-8 text-slate-300 hover:text-slate-900 transition-colors"><X size={24} /></button>
                <div className="flex flex-col items-center mb-6">
                    <div className="w-16 h-16 bg-slate-900 text-white rounded-[1.5rem] flex items-center justify-center shadow-xl mb-4">
                         {showProviderConfig === 'github' ? <Github size={32}/> : <Globe size={32}/>}
                    </div>
                    <h3 className="text-2xl font-black text-slate-900 tracking-tight capitalize">Configure {showProviderConfig}</h3>
                    <p className="text-xs text-slate-400 font-bold uppercase tracking-widest mt-1">OAuth Integration</p>
                </div>
                
                <div className="space-y-4">
                    <div className="space-y-1">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Client ID</label>
                        <input 
                            value={providerConfig.client_id || ''} 
                            onChange={(e) => setProviderConfig({...providerConfig, client_id: e.target.value})} 
                            className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none focus:ring-4 focus:ring-indigo-500/10 transition-all font-mono text-indigo-600"
                            placeholder="Received from Provider"
                        />
                    </div>
                    <div className="space-y-1">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Client Secret</label>
                        <input 
                            type="password"
                            value={providerConfig.client_secret || ''} 
                            onChange={(e) => setProviderConfig({...providerConfig, client_secret: e.target.value})} 
                            className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none focus:ring-4 focus:ring-indigo-500/10 transition-all font-mono"
                            placeholder="••••••••••••••••"
                        />
                    </div>
                    
                    <div className="p-4 bg-slate-50 border border-slate-100 rounded-2xl">
                        <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-2 block flex items-center gap-1"><Link size={10}/> Callback URL (Redirect URI)</label>
                        <div className="flex items-center gap-2 bg-white border border-slate-200 p-2 rounded-xl">
                            <code className="text-[10px] text-slate-600 font-mono truncate flex-1">{getCallbackUrl()}</code>
                            <button onClick={() => safeCopy(getCallbackUrl())} className="p-1.5 hover:bg-slate-100 rounded-lg text-indigo-500"><Copy size={12}/></button>
                        </div>
                        <p className="text-[9px] text-slate-400 mt-2 px-1 leading-tight">
                            Add this URL to your OAuth App settings in the Provider's Developer Console.
                        </p>
                    </div>

                    <button onClick={handleSaveProviderConfig} className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-700 transition-all flex items-center justify-center gap-2 mt-2">
                        <CheckCircle2 size={16}/> Save Configuration
                    </button>
                </div>
            </div>
        </div>
      )}

      {/* DELETE CONFIRM */}
      {showDeleteModal && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[600] flex items-center justify-center p-8 animate-in zoom-in-95">
              <div className="bg-white rounded-[3rem] w-full max-w-sm p-10 shadow-2xl text-center border border-rose-100">
                  <AlertCircle size={48} className="text-rose-500 mx-auto mb-4"/>
                  <h3 className="text-xl font-black text-slate-900 mb-2">Delete User?</h3>
                  <p className="text-xs text-slate-500 mb-6">To confirm, type the User UUID below.</p>
                  <code className="block bg-slate-100 p-2 rounded-lg text-[10px] font-mono mb-4 text-slate-600 select-all">{showDeleteModal.id}</code>
                  <input value={deleteConfirmUuid} onChange={(e) => setDeleteConfirmUuid(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-sm font-bold text-center outline-none mb-6 focus:ring-4 focus:ring-rose-500/10"/>
                  <div className="flex gap-4">
                      <button onClick={() => setShowDeleteModal(null)} className="flex-1 py-3 text-slate-400 font-bold text-xs uppercase hover:bg-slate-50 rounded-xl">Cancel</button>
                      <button onClick={handleDeleteUser} disabled={deleteConfirmUuid !== showDeleteModal.id || executing} className="flex-1 py-3 bg-rose-600 text-white rounded-xl font-bold text-xs uppercase shadow-lg hover:bg-rose-700 disabled:opacity-50">Delete</button>
                  </div>
              </div>
          </div>
      )}

      {/* USER DETAIL MODAL (LINK IDENTITIES) */}
      {showUserModal && selectedUser && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
              <div className="bg-white rounded-[3.5rem] w-full max-w-2xl p-12 shadow-2xl border border-slate-100 flex flex-col max-h-[90vh]">
                  <header className="flex justify-between items-start mb-8">
                      <div>
                          <h3 className="text-3xl font-black text-slate-900">User Details</h3>
                          <div className="flex items-center gap-2 mt-2">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-widest ${selectedUser.banned ? 'bg-rose-100 text-rose-600' : 'bg-emerald-100 text-emerald-600'}`}>{selectedUser.banned ? 'Banned' : 'Active'}</span>
                              <span className="text-xs text-slate-400 font-mono">{selectedUser.id}</span>
                          </div>
                      </div>
                      <button onClick={() => setShowUserModal(false)} className="p-2 hover:bg-slate-100 rounded-full text-slate-400"><X size={24}/></button>
                  </header>

                  <div className="flex-1 overflow-y-auto space-y-8">
                      {/* IDENTITIES LIST */}
                      <div className="space-y-4">
                          <div className="flex justify-between items-center">
                              <h4 className="text-sm font-black text-slate-900">Linked Identities</h4>
                              <button onClick={() => setShowLinkIdentity(true)} className="text-[10px] font-bold text-indigo-600 uppercase hover:bg-indigo-50 px-3 py-1.5 rounded-lg transition-all flex items-center gap-1"><Plus size={12}/> Link New</button>
                          </div>
                          
                          {showLinkIdentity && (
                              <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 animate-in slide-in-from-top-2 space-y-3">
                                  <div className="grid grid-cols-3 gap-3">
                                      <select value={linkIdentityForm.provider} onChange={e => setLinkIdentityForm({...linkIdentityForm, provider: e.target.value})} className="bg-white border-none rounded-xl py-2 px-3 text-xs font-bold outline-none">
                                          {Object.keys(strategies).filter(k => strategies[k].enabled).map(k => <option key={k} value={k}>{k}</option>)}
                                      </select>
                                      <input value={linkIdentityForm.identifier} onChange={e => setLinkIdentityForm({...linkIdentityForm, identifier: e.target.value})} placeholder="Identifier" className="col-span-2 bg-white border-none rounded-xl py-2 px-3 text-xs font-bold outline-none"/>
                                  </div>
                                  <input type="password" value={linkIdentityForm.password} onChange={e => setLinkIdentityForm({...linkIdentityForm, password: e.target.value})} placeholder="Password (Optional)" className="w-full bg-white border-none rounded-xl py-2 px-3 text-xs font-bold outline-none"/>
                                  <div className="flex gap-2 justify-end">
                                      <button onClick={() => setShowLinkIdentity(false)} className="text-[10px] font-bold text-slate-400 px-3 py-2">Cancel</button>
                                      <button onClick={handleLinkIdentity} className="bg-indigo-600 text-white px-4 py-2 rounded-xl text-[10px] font-bold uppercase hover:bg-indigo-700">Link</button>
                                  </div>
                              </div>
                          )}

                          <div className="space-y-2">
                              {selectedUser.identities?.map((id: any) => (
                                  <div key={id.id} className="flex items-center justify-between bg-slate-50 p-4 rounded-2xl border border-slate-100">
                                      <div className="flex items-center gap-3">
                                          <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center shadow-sm text-indigo-600">
                                              {id.provider === 'email' ? <Mail size={16}/> : id.provider === 'phone' ? <Smartphone size={16}/> : <Globe size={16}/>}
                                          </div>
                                          <div>
                                              <p className="text-xs font-bold text-slate-700">{id.identifier}</p>
                                              <p className="text-[10px] text-slate-400 font-bold uppercase">{id.provider}</p>
                                          </div>
                                      </div>
                                      <button onClick={() => handleUnlinkIdentity(id.id)} className="p-2 text-slate-300 hover:text-rose-600 hover:bg-white rounded-lg transition-all" title="Unlink"><Unlink size={16}/></button>
                                  </div>
                              ))}
                          </div>
                      </div>

                      {/* ACTIONS */}
                      <div className="pt-6 border-t border-slate-100 flex gap-4">
                          <button onClick={() => handleBlockUser(selectedUser)} className={`flex-1 py-4 rounded-2xl text-xs font-black uppercase tracking-widest transition-all ${selectedUser.banned ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-amber-100 text-amber-700 hover:bg-amber-200'}`}>
                              {selectedUser.banned ? 'Unban User' : 'Ban User'}
                          </button>
                          <button onClick={() => { setShowDeleteModal({id: selectedUser.id}); }} className="flex-1 py-4 bg-rose-50 text-rose-600 rounded-2xl text-xs font-black uppercase tracking-widest hover:bg-rose-600 hover:text-white transition-all">
                              Delete User
                          </button>
                      </div>
                  </div>
              </div>
          </div>
      )}

    </div>
  );
};

export default AuthConfig;
