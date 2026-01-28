
import React, { useState, useEffect } from 'react';
import { 
  Shield, Globe, Key, Lock, Mail, CheckCircle2, AlertCircle, Loader2, Cloud, 
  Fingerprint, Plus, CloudLightning, Info, Terminal, Copy, ChevronRight, 
  ShieldAlert, FileText, Code, Server, ExternalLink, RefreshCw, Activity,
  Trash2, Globe2, CheckSquare, Sparkles, Brain, Mic, Vault, X, Database, Bot, Cable,
  Siren, Eye, EyeOff, LockKeyhole
} from 'lucide-react';

const SystemSettings: React.FC = () => {
  // CREDENTIALS STATE
  const [adminEmail, setAdminEmail] = useState('admin@cascata.io');
  const [newPassword, setNewPassword] = useState('');
  
  // GLOBAL DOMAIN STATE
  const [globalDomain, setGlobalDomain] = useState('');
  const [isDomainSaved, setIsDomainSaved] = useState(false);
  const [sslStatus, setSslStatus] = useState<'pending' | 'active' | 'inactive'>('pending');
  const [testingSsl, setTestingSsl] = useState(false);

  // VAULT STATE
  const [availableCerts, setAvailableCerts] = useState<string[]>([]);

  // AI STATE
  const [aiConfig, setAiConfig] = useState({ 
      api_key: '', 
      model: 'gemini-3-flash-preview', 
      base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
      wake_word: 'Cascata',
      active_listening: false,
      mcp_enabled: true // Global Master Switch
  });

  // Db Config
  const [globalDbConfig, setGlobalDbConfig] = useState({ maxConnections: 100 });

  // NETWORK STATE
  const [serverIp, setServerIp] = useState('Checking...');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // MODALS
  const [showCertModal, setShowCertModal] = useState(false);
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [verifyPassword, setVerifyPassword] = useState('');
  const [pendingAction, setPendingAction] = useState<(() => Promise<void>) | null>(null);

  // SSL CERT MODAL STATE
  const [sslMode, setSslMode] = useState<'letsencrypt' | 'cloudflare_pem'>('letsencrypt');
  const [certDomainInput, setCertDomainInput] = useState(''); 
  const [certPem, setCertPem] = useState('');
  const [keyPem, setKeyPem] = useState('');
  const [leEmail, setLeEmail] = useState('');

  // TABS
  const [activeTab, setActiveTab] = useState<'network' | 'intelligence'>('network');

  // --- INITIALIZATION ---
  useEffect(() => {
    // 1. Check IP
    fetch('https://api.ipify.org?format=json')
      .then(res => res.json())
      .then(data => setServerIp(data.ip))
      .catch(() => setServerIp('Network Error'));

    // 2. Load Global Config
    fetch('/api/control/system/settings', {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
    })
    .then(res => res.json())
    .then(data => {
      if (data.domain) {
        setGlobalDomain(data.domain);
        setIsDomainSaved(true);
        testSslConnection(data.domain);
      }
      if (data.ai) {
          setAiConfig(prev => ({ ...prev, ...data.ai }));
      }
      if (data.db_config) {
          setGlobalDbConfig(prev => ({ ...prev, ...data.db_config }));
      }
    })
    .catch(console.error);

    fetchCerts();
  }, []);

  const fetchCerts = async () => {
      try {
          const res = await fetch('/api/control/system/certificates/status', {
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          const data = await res.json();
          setAvailableCerts(data.domains || []);
      } catch(e) {}
  };

  const copyToClipboard = (text: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setSuccess("Copiado!");
    setTimeout(() => setSuccess(null), 2000);
  };

  // --- ACTIONS ---

  const testSslConnection = async (domain: string) => {
    setTestingSsl(true);
    setSslStatus('pending');
    try {
      const res = await fetch('/api/control/system/ssl-check', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` 
        },
        body: JSON.stringify({ domain })
      });
      const data = await res.json();
      setSslStatus(data.status === 'active' ? 'active' : 'inactive');
    } catch {
      setSslStatus('inactive');
    } finally {
      setTestingSsl(false);
    }
  };

  const handleSaveDomain = async () => {
    setLoading(true);
    try {
      await fetch('/api/control/system/settings', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` 
        },
        body: JSON.stringify({ domain: globalDomain })
      });
      setIsDomainSaved(true);
      setSuccess("Domínio global registrado.");
      testSslConnection(globalDomain);
      setTimeout(() => setSuccess(null), 3000);
    } catch (e) {
      setError("Erro ao salvar domínio.");
    } finally {
      setLoading(false);
    }
  };

  const handleSaveAI = async () => {
      setLoading(true);
      try {
          await fetch('/api/control/system/settings', {
              method: 'POST',
              headers: { 
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` 
              },
              body: JSON.stringify({ ai_config: aiConfig })
          });
          setSuccess("Configuração de IA atualizada.");
          setTimeout(() => setSuccess(null), 3000);
      } catch (e) { setError("Erro ao salvar IA."); }
      finally { setLoading(false); }
  };

  const handleSaveDbConfig = async () => {
      setLoading(true);
      try {
          await fetch('/api/control/system/settings', {
              method: 'POST',
              headers: { 
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` 
              },
              body: JSON.stringify({ db_config: globalDbConfig })
          });
          setSuccess("Limite global de conexões atualizado.");
          setTimeout(() => setSuccess(null), 3000);
      } catch (e) { setError("Erro ao salvar config de banco."); }
      finally { setLoading(false); }
  };

  const handleDeleteDomain = async () => {
    setLoading(true);
    try {
      await fetch('/api/control/system/settings', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` 
        },
        body: JSON.stringify({ domain: '' }) // Clear it
      });
      setGlobalDomain('');
      setIsDomainSaved(false);
      setSslStatus('inactive');
      setSuccess("Domínio removido.");
      setTimeout(() => setSuccess(null), 3000);
    } catch (e) {
      setError("Erro ao remover domínio.");
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateProfile = async () => {
    setLoading(true);
    try {
      await fetch('/api/control/auth/profile', {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` 
        },
        body: JSON.stringify({ email: adminEmail, password: newPassword || undefined })
      });
      setSuccess("Credenciais atualizadas com sucesso.");
      setNewPassword('');
      setTimeout(() => setSuccess(null), 3000);
    } catch (e) {
      setError("Erro ao atualizar perfil.");
    } finally {
      setLoading(false);
    }
  };

  const handleSaveCertificate = async () => {
    if(!certDomainInput) { setError("Defina o domínio do certificado (ex: *.empresa.com)"); return; }
    setLoading(true);
    try {
      const response = await fetch('/api/control/system/certificates', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`
        },
        body: JSON.stringify({ 
          domain: certDomainInput, 
          cert: certPem, 
          key: keyPem, 
          provider: sslMode,
          email: leEmail,
          isSystem: false // Salva no Vault. O backend aplica auto se der match.
        })
      });
      if (!response.ok) throw new Error('Erro na comunicação com o Control Plane.');
      
      setSuccess(sslMode === 'letsencrypt' 
        ? 'Solicitação enviada ao Certbot. Aguarde validação (até 5 min).' 
        : 'Certificado salvo no Cofre.');
      
      setShowCertModal(false);
      fetchCerts();
      
      // Limpa campos
      setCertDomainInput('');
      setCertPem('');
      setKeyPem('');
      
      // Re-test global domain just in case we uploaded a fix for it
      if (globalDomain) setTimeout(() => testSslConnection(globalDomain), 2000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteCert = async (domain: string) => {
      if(!confirm(`Remover certificado para ${domain}? Isso pode quebrar sites que o utilizam.`)) return;
      try {
          await fetch(`/api/control/system/certificates/${domain}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` } });
          setSuccess("Certificado removido.");
          fetchCerts();
      } catch(e) { setError("Erro ao remover."); }
  };

  // --- SECURITY GATE ---
  const triggerSecureAction = (action: () => Promise<void>) => {
    setPendingAction(() => action);
    setShowVerifyModal(true);
  };

  const handleVerifyAndExecute = async () => {
    try {
      const res = await fetch('/api/control/auth/verify', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` 
        },
        body: JSON.stringify({ password: verifyPassword })
      });
      
      if (res.ok) {
        setShowVerifyModal(false);
        setVerifyPassword('');
        if (pendingAction) await pendingAction();
        setPendingAction(null);
      } else {
        setError("Senha incorreta.");
        setTimeout(() => setError(null), 2000);
      }
    } catch (e) { 
      setError("Erro na verificação."); 
    }
  };

  return (
    <div className="p-12 lg:p-20 max-w-7xl mx-auto w-full space-y-16 pb-80">
      {/* Toast Notifications */}
      {(error || success) && (
        <div className={`fixed top-8 left-1/2 -translate-x-1/2 z-[500] p-6 rounded-[2rem] shadow-2xl flex items-center gap-4 animate-in slide-in-from-top-4 ${error ? 'bg-rose-600 text-white' : 'bg-indigo-600 text-white border-b-4 border-white/20'}`}>
          {error ? <AlertCircle size={20} /> : <CheckCircle2 size={20} />}
          <span className="text-sm font-black tracking-tight">{error || success}</span>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-8">
        <div>
          <h1 className="text-7xl font-black text-slate-900 tracking-tighter mb-4 italic">Orchestration</h1>
          <p className="text-slate-400 text-xl font-medium max-w-2xl leading-relaxed">Central de controle para certificados, domínios e identidades mestras.</p>
        </div>
        
        <div className="flex items-center gap-4">
            {activeTab === 'network' && (
                <div className="bg-white p-4 border border-slate-200 rounded-[2rem] flex items-center gap-4 shadow-sm">
                    <div className="w-12 h-12 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center"><Activity size={24} /></div>
                    <div className="flex flex-col">
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block leading-none mb-1">DNS PROPAGATION</span>
                        <span className="text-xs font-mono font-bold text-slate-900">SYNCED (IP: {serverIp})</span>
                    </div>
                </div>
            )}
            <div className="flex bg-slate-200 p-1.5 rounded-[1.5rem]">
                <button onClick={() => setActiveTab('network')} className={`px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'network' ? 'bg-white shadow-md text-indigo-600' : 'text-slate-500'}`}>Network & Vault</button>
                <button onClick={() => setActiveTab('intelligence')} className={`px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'intelligence' ? 'bg-white shadow-md text-indigo-600' : 'text-slate-500'}`}>Intelligence</button>
            </div>
        </div>
      </div>

      {activeTab === 'network' && (
        <div className="space-y-12 animate-in slide-in-from-bottom-2">
            
            {/* Global Limits (New Card) */}
            <div className="bg-white border border-slate-200 rounded-[4rem] p-12 shadow-sm relative overflow-hidden">
                <h3 className="text-2xl font-black text-slate-900 tracking-tight mb-8 flex items-center gap-4">
                    <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center shadow-lg"><Database size={20} /></div>
                    Infrastructure Limits
                </h3>
                <p className="text-slate-400 text-sm font-medium mb-6">
                    Hard Cap for total database connections across all tenants. Prevents Node.js from overwhelming the Postgres instance.
                </p>
                <div className="flex gap-4 items-end max-w-md">
                    <div className="flex-1">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Global Connection Cap</label>
                        <input 
                            type="number" 
                            min="10"
                            value={globalDbConfig.maxConnections} 
                            onChange={(e) => setGlobalDbConfig({...globalDbConfig, maxConnections: parseInt(e.target.value)})} 
                            className="w-full bg-slate-50 border border-slate-100 rounded-[1.8rem] py-5 px-8 text-sm font-bold text-slate-900 outline-none focus:ring-4 focus:ring-blue-500/10 transition-all text-center" 
                        />
                    </div>
                    <button 
                        onClick={handleSaveDbConfig}
                        disabled={loading}
                        className="bg-blue-600 text-white px-8 h-[60px] rounded-[1.8rem] font-black uppercase tracking-widest text-xs flex items-center justify-center hover:bg-blue-700 transition-all shadow-xl disabled:opacity-50"
                    >
                        {loading ? <Loader2 className="animate-spin" size={16}/> : 'Apply'}
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
                {/* Identidade */}
                <div className="bg-white border border-slate-200 rounded-[4rem] p-12 shadow-sm relative overflow-hidden">
                <h3 className="text-2xl font-black text-slate-900 tracking-tight mb-8 flex items-center gap-4">
                    <div className="w-12 h-12 bg-slate-900 text-white rounded-2xl flex items-center justify-center shadow-lg"><Lock size={20} /></div>
                    Perfil Administrativo
                </h3>
                <div className="space-y-6">
                    <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Root Email</label>
                    <input 
                        value={adminEmail} 
                        onChange={(e) => setAdminEmail(e.target.value)} 
                        className="w-full bg-slate-50 border border-slate-100 rounded-[1.8rem] py-5 px-8 text-sm font-bold text-slate-900 outline-none focus:ring-4 focus:ring-indigo-500/10 transition-all" 
                    />
                    </div>
                    <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Nova Senha Mestra</label>
                    <input 
                        type="password" 
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="••••••••" 
                        className="w-full bg-slate-50 border border-slate-100 rounded-[1.8rem] py-5 px-8 text-sm font-bold text-slate-900 outline-none focus:ring-4 focus:ring-indigo-500/10" 
                    />
                    </div>
                    <button 
                    onClick={() => triggerSecureAction(handleUpdateProfile)}
                    disabled={loading}
                    className="w-full bg-slate-900 text-white py-6 rounded-[2rem] font-black uppercase tracking-widest text-xs flex items-center justify-center gap-3 hover:bg-indigo-600 transition-all shadow-xl disabled:opacity-50"
                    >
                    {loading ? <Loader2 className="animate-spin" size={16}/> : 'Atualizar Credenciais'}
                    </button>
                </div>
                </div>

                {/* Domínio Global */}
                <div className="bg-white border border-slate-200 rounded-[4rem] p-12 shadow-sm flex flex-col group relative overflow-hidden">
                <div className="absolute top-0 right-0 p-10 opacity-5 group-hover:scale-110 transition-transform"><Globe size={160} /></div>
                <h3 className="text-2xl font-black text-slate-900 tracking-tight mb-8 flex items-center gap-4">
                    <div className="w-12 h-12 bg-indigo-600 text-white rounded-2xl flex items-center justify-center shadow-lg"><Globe size={20} /></div>
                    Dashboard Endpoint
                </h3>
                <div className="space-y-8 flex-1 relative z-10">
                    <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Domínio do Painel</label>
                    {isDomainSaved ? (
                        <div className="flex items-center justify-between bg-slate-50 border border-slate-100 rounded-[1.8rem] p-2 pl-8">
                            <span className="text-sm font-mono font-bold text-indigo-900">{globalDomain}</span>
                            <button 
                            onClick={() => triggerSecureAction(handleDeleteDomain)}
                            className="bg-white p-3 rounded-2xl text-rose-500 hover:text-white hover:bg-rose-500 transition-all shadow-sm border border-slate-100"
                            title="Remover Domínio"
                            >
                            <Trash2 size={18} />
                            </button>
                        </div>
                    ) : (
                        <div className="flex gap-2">
                            <input 
                            value={globalDomain} 
                            onChange={(e) => setGlobalDomain(e.target.value)} 
                            placeholder="painel.minha-empresa.com"
                            className="flex-1 bg-slate-50 border border-slate-100 rounded-[1.8rem] py-4 px-6 text-sm font-mono font-bold text-slate-900 outline-none focus:ring-4 focus:ring-indigo-500/10" 
                            />
                            <button 
                            onClick={handleSaveDomain}
                            disabled={!globalDomain || loading}
                            className="bg-indigo-600 text-white px-6 rounded-[1.8rem] font-black text-xs uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-lg"
                            >
                            {loading ? <Loader2 className="animate-spin" /> : 'Definir'}
                            </button>
                        </div>
                    )}
                    </div>

                    {isDomainSaved && (
                    <div className="p-8 bg-slate-950 text-white rounded-[2.5rem] space-y-6 border border-white/5 animate-in slide-in-from-bottom-4">
                        <div className="flex items-center justify-between">
                        <div>
                            <h4 className="text-sm font-black uppercase tracking-tight mb-1 flex items-center gap-2">
                                Status da Conexão
                                <button onClick={() => testSslConnection(globalDomain)} className="p-1 hover:bg-white/10 rounded-full transition-all">
                                <RefreshCw size={12} className={testingSsl ? 'animate-spin' : ''} />
                                </button>
                            </h4>
                            <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border text-[9px] font-black uppercase tracking-widest ${sslStatus === 'active' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-rose-500/10 border-rose-500/30 text-rose-400'}`}>
                                <div className={`w-1.5 h-1.5 rounded-full ${sslStatus === 'active' ? 'bg-emerald-400' : 'bg-rose-400'} animate-pulse`}></div>
                                {sslStatus === 'active' ? 'Protegido (SSL Ativo)' : 'Não Seguro / Erro'}
                            </div>
                        </div>
                        {sslStatus !== 'active' && (
                            <p className="text-[10px] text-slate-400 max-w-[150px] text-right">Adicione um certificado para <b>{globalDomain}</b> no cofre abaixo.</p>
                        )}
                        </div>
                    </div>
                    )}
                </div>
                </div>
            </div>

            {/* CERTIFICATE VAULT */}
            <div className="bg-slate-900 text-white rounded-[4rem] p-12 shadow-2xl relative overflow-hidden">
                <div className="absolute top-0 right-0 p-16 opacity-10"><Vault size={200}/></div>
                <div className="relative z-10">
                    <div className="flex justify-between items-center mb-10">
                        <div>
                            <h3 className="text-2xl font-black tracking-tight flex items-center gap-4"><div className="w-12 h-12 bg-emerald-500 text-white rounded-2xl flex items-center justify-center shadow-lg"><Shield size={20} /></div>Certificate Vault</h3>
                            <p className="text-slate-400 text-xs font-bold uppercase tracking-widest mt-2 ml-1">Repositório Central de Chaves & Certificados</p>
                        </div>
                        <button onClick={() => { setShowCertModal(true); setCertDomainInput(globalDomain || ''); }} className="bg-white text-slate-900 px-6 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-emerald-400 transition-all shadow-xl flex items-center gap-2">
                            <Plus size={14}/> Add Certificate
                        </button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {availableCerts.length === 0 && <div className="col-span-full py-10 text-center text-slate-500 font-mono text-xs border-2 border-dashed border-white/10 rounded-[2rem]">O cofre está vazio. Adicione certificados para proteger seus domínios.</div>}
                        {availableCerts.map(cert => (
                            <div key={cert} className="bg-white/5 border border-white/10 p-6 rounded-[2.5rem] flex items-center justify-between group hover:bg-white/10 transition-all">
                                <div>
                                    <div className="flex items-center gap-3 mb-2">
                                        {cert.startsWith('*.') ? <div title="Wildcard" className="p-2 bg-amber-500/20 text-amber-400 rounded-lg"><Globe size={14}/></div> : <div title="Single Domain" className="p-2 bg-emerald-500/20 text-emerald-400 rounded-lg"><Lock size={14}/></div>}
                                        <span className="font-bold text-sm tracking-tight">{cert}</span>
                                    </div>
                                    <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest bg-black/20 px-2 py-1 rounded inline-block">
                                        {cert === globalDomain ? 'System Root' : 'Project Asset'}
                                    </span>
                                </div>
                                <button onClick={() => handleDeleteCert(cert)} className="p-3 bg-rose-500/20 text-rose-400 rounded-2xl hover:bg-rose-500 hover:text-white transition-all"><Trash2 size={16}/></button>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
      )}

      {activeTab === 'intelligence' && (
          <div className="space-y-8 animate-in slide-in-from-bottom-2">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                  {/* OMNI-GATEWAY CARD (ROOT MCP) */}
                  <div className="bg-gradient-to-br from-indigo-950 to-slate-900 border border-slate-800 rounded-[4rem] p-12 shadow-2xl relative overflow-hidden group">
                      <div className="absolute top-0 right-0 p-10 opacity-20"><Bot size={120} className="text-emerald-500"/></div>
                      
                      <div className="relative z-10">
                          <h3 className="text-3xl font-black text-white tracking-tight mb-4 flex items-center gap-3">
                              <Cable size={32} className="text-emerald-400"/>
                              Omni-Gateway
                          </h3>
                          <p className="text-slate-400 text-sm font-medium mb-8 leading-relaxed max-w-lg">
                              Enable your AI Agents to create projects, manage infrastructure, and audit the entire Cascata instance via the Root MCP protocol.
                          </p>

                          <div className="bg-black/30 backdrop-blur-md rounded-3xl p-6 border border-white/10 mb-8">
                              <div className="flex justify-between items-center mb-2">
                                  <label className="text-[10px] font-black text-emerald-500 uppercase tracking-widest">Root MCP Endpoint</label>
                                  <span className="bg-rose-500/20 text-rose-400 text-[9px] font-bold px-2 py-0.5 rounded border border-rose-500/30 uppercase">High Privilege</span>
                              </div>
                              <div className="flex items-center gap-3">
                                  <code className="flex-1 font-mono text-[10px] text-white/80 break-all">
                                      {`${window.location.origin}/api/control/mcp/sse`}
                                  </code>
                                  <button onClick={() => copyToClipboard(`${window.location.origin}/api/control/mcp/sse`)} className="p-2 bg-white/10 hover:bg-white/20 rounded-lg text-white transition-colors">
                                      <Copy size={14}/>
                                  </button>
                              </div>
                              <p className="text-[9px] text-slate-500 mt-3 flex items-center gap-2">
                                  <Info size={10}/> Requires <code>Cookie: admin_token=...</code> or Header <code>Authorization: Bearer ADMIN_TOKEN</code>
                              </p>
                          </div>
                      </div>
                  </div>

                  {/* AI CONFIG */}
                  <div className="bg-white border border-slate-200 rounded-[4rem] p-12 shadow-sm">
                      <h3 className="text-2xl font-black text-slate-900 tracking-tight mb-8 flex items-center gap-4">
                        <div className="w-12 h-12 bg-indigo-600 text-white rounded-2xl flex items-center justify-center shadow-lg"><Brain size={20} /></div>
                        AI Configuration
                      </h3>
                      
                      <div className="space-y-6">
                          <div className="p-4 bg-indigo-50 border border-indigo-100 rounded-2xl flex items-start gap-4">
                              <Sparkles className="text-indigo-600 mt-1" size={20} />
                              <div>
                                  <h4 className="font-bold text-indigo-900 text-sm">Cascata Architect Brain</h4>
                                  <p className="text-xs text-indigo-700 leading-relaxed mt-1">
                                      Configure o modelo de linguagem que alimenta o Assistente de Arquitetura. Use "Active Listening" para ativar o modo mãos-livres com Wake Word.
                                  </p>
                              </div>
                          </div>

                          {/* VOICE SETTINGS */}
                          <div className="p-6 bg-slate-50 border border-slate-100 rounded-[2rem] space-y-4">
                              <div className="flex items-center justify-between">
                                  <label className="text-sm font-bold text-slate-700 flex items-center gap-2"><Mic size={16}/> Active Listening (Hands-Free)</label>
                                  <button 
                                    onClick={() => setAiConfig(prev => ({ ...prev, active_listening: !prev.active_listening }))}
                                    className={`w-14 h-8 rounded-full p-1 transition-colors ${aiConfig.active_listening ? 'bg-emerald-500' : 'bg-slate-300'}`}
                                  >
                                      <div className={`w-6 h-6 bg-white rounded-full shadow-md transition-transform ${aiConfig.active_listening ? 'translate-x-6' : ''}`}></div>
                                  </button>
                              </div>
                              
                              {aiConfig.active_listening && (
                                  <div className="space-y-2 animate-in slide-in-from-top-2">
                                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Wake Word / Activation Phrase</label>
                                      <input 
                                        value={aiConfig.wake_word} 
                                        onChange={(e) => setAiConfig({...aiConfig, wake_word: e.target.value})} 
                                        placeholder="ex: Hey Cascata, Jarvis, Computer..."
                                        className="w-full bg-white border border-slate-200 rounded-[1.5rem] py-4 px-6 text-sm font-bold text-indigo-600 outline-none focus:ring-4 focus:ring-indigo-500/10 transition-all" 
                                      />
                                      <p className="text-[10px] text-slate-400 font-medium px-2">
                                        O assistente ficará ouvindo continuamente. Quando detectar esta frase, ele ativará o modo de comando e capturará sua instrução.
                                      </p>
                                  </div>
                              )}
                          </div>

                          <div className="space-y-2">
                              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">API Key</label>
                              <input 
                                type="password"
                                value={aiConfig.api_key} 
                                onChange={(e) => setAiConfig({...aiConfig, api_key: e.target.value})} 
                                placeholder="sk-..."
                                className="w-full bg-slate-50 border border-slate-100 rounded-[1.8rem] py-5 px-8 text-sm font-bold text-slate-900 outline-none focus:ring-4 focus:ring-indigo-500/10 transition-all" 
                              />
                          </div>

                          <div className="grid grid-cols-2 gap-6">
                              <div className="space-y-2">
                                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Model Name</label>
                                  <input 
                                    value={aiConfig.model} 
                                    onChange={(e) => setAiConfig({...aiConfig, model: e.target.value})} 
                                    placeholder="gemini-3-flash-preview"
                                    className="w-full bg-slate-50 border border-slate-100 rounded-[1.8rem] py-5 px-8 text-sm font-bold text-slate-900 outline-none focus:ring-4 focus:ring-indigo-500/10 transition-all" 
                                  />
                              </div>
                              <div className="space-y-2">
                                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Base URL (OpenAI Comp.)</label>
                                  <input 
                                    value={aiConfig.base_url} 
                                    onChange={(e) => setAiConfig({...aiConfig, base_url: e.target.value})} 
                                    placeholder="https://generativelanguage.googleapis.com/v1beta/openai"
                                    className="w-full bg-slate-50 border border-slate-100 rounded-[1.8rem] py-5 px-8 text-sm font-bold text-slate-900 outline-none focus:ring-4 focus:ring-indigo-500/10 transition-all" 
                                  />
                              </div>
                          </div>

                          <button 
                            onClick={handleSaveAI}
                            disabled={loading}
                            className="w-full bg-slate-900 text-white py-6 rounded-[2rem] font-black uppercase tracking-widest text-xs flex items-center justify-center gap-3 hover:bg-indigo-600 transition-all shadow-xl disabled:opacity-50"
                          >
                            {loading ? <Loader2 className="animate-spin" size={16}/> : 'Salvar Configurações de IA'}
                          </button>
                      </div>
                  </div>
              </div>

              {/* GLOBAL GOVERNANCE CARD */}
              <div className="bg-slate-900 border border-slate-800 rounded-[3.5rem] p-10 shadow-2xl relative overflow-hidden flex flex-col md:flex-row items-center justify-between gap-8 group">
                  <div className="absolute top-0 left-0 p-16 opacity-5 group-hover:scale-110 transition-transform duration-700"><Siren size={200} className="text-rose-500"/></div>
                  
                  <div className="relative z-10 flex-1">
                      <h3 className="text-3xl font-black text-white tracking-tight flex items-center gap-4 mb-2">
                          <div className="w-14 h-14 bg-rose-600 text-white rounded-2xl flex items-center justify-center shadow-lg"><LockKeyhole size={24} /></div>
                          Global Governance
                      </h3>
                      <p className="text-slate-400 font-medium text-sm leading-relaxed max-w-xl">
                          Master Switch for AI Access (MCP Protocol). Disabling this will instantly block ALL AI agents (Cursor, Windsurf, etc.) from accessing ANY project data, regardless of their individual settings.
                      </p>
                  </div>

                  <div className="relative z-10 bg-white/5 backdrop-blur-sm border border-white/10 p-6 rounded-[2.5rem] flex items-center gap-6">
                      <div className="text-right">
                          <span className={`block text-xs font-black uppercase tracking-widest ${aiConfig.mcp_enabled ? 'text-emerald-400' : 'text-rose-400'}`}>
                              {aiConfig.mcp_enabled ? 'MCP Protocol Active' : 'MCP Protocol Terminated'}
                          </span>
                          <span className="text-[10px] text-slate-500 font-bold">System-wide enforcement</span>
                      </div>
                      <button 
                          onClick={() => {
                              const newVal = !aiConfig.mcp_enabled;
                              setAiConfig({...aiConfig, mcp_enabled: newVal});
                              // Immediate save for kill-switch responsiveness
                              fetch('/api/control/system/settings', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
                                  body: JSON.stringify({ ai_config: { ...aiConfig, mcp_enabled: newVal } })
                              }).then(() => setSuccess(newVal ? "MCP System Online" : "MCP System Terminated"));
                          }}
                          className={`w-20 h-10 rounded-full p-1 transition-all duration-300 ${aiConfig.mcp_enabled ? 'bg-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.4)]' : 'bg-rose-900 shadow-inner'}`}
                      >
                          <div className={`w-8 h-8 bg-white rounded-full shadow-md transition-transform duration-300 flex items-center justify-center ${aiConfig.mcp_enabled ? 'translate-x-10' : 'translate-x-0'}`}>
                               {aiConfig.mcp_enabled ? <CheckCircle2 size={16} className="text-emerald-600"/> : <Siren size={16} className="text-rose-600"/>}
                          </div>
                      </button>
                  </div>
              </div>
          </div>
      )}

      {/* Verify Password Modal */}
      {showVerifyModal && (
         <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[800] flex items-center justify-center p-8 animate-in zoom-in-95">
            <div className="bg-white rounded-[3rem] p-10 max-w-sm w-full shadow-2xl text-center border border-slate-200">
               <Lock size={40} className="mx-auto text-slate-900 mb-6" />
               <h3 className="text-xl font-black text-slate-900 mb-2">Confirmação de Segurança</h3>
               <p className="text-xs text-slate-500 font-bold mb-8">Digite sua senha atual para autorizar esta alteração crítica.</p>
               <input 
                 type="password" 
                 autoFocus
                 value={verifyPassword}
                 onChange={e => setVerifyPassword(e.target.value)}
                 className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-center font-bold text-slate-900 outline-none mb-6 focus:ring-4 focus:ring-indigo-500/10"
                 placeholder="••••••••"
               />
               <button onClick={handleVerifyAndExecute} className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-600 transition-all">
                  Confirmar Acesso
               </button>
               <button onClick={() => { setShowVerifyModal(false); setPendingAction(null); }} className="mt-4 text-xs font-bold text-slate-400 hover:text-slate-600">Cancelar</button>
            </div>
         </div>
      )}

      {/* SSL Modal (Vault Edition) */}
      {showCertModal && (
        <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-2xl z-[600] flex items-center justify-center p-8 animate-in fade-in duration-300">
           <div className="bg-white rounded-[4rem] w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl border border-slate-200">
              <header className="p-12 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                 <div className="flex items-center gap-6"><div className="w-16 h-16 bg-indigo-600 text-white rounded-[1.5rem] flex items-center justify-center shadow-xl"><Vault size={32} /></div><div><h3 className="text-3xl font-black text-slate-900 tracking-tighter">Adicionar ao Cofre</h3><p className="text-slate-400 font-bold uppercase tracking-widest text-[10px]">Importação de Certificados (Single ou Wildcard)</p></div></div>
                 <button onClick={() => setShowCertModal(false)} className="p-4 hover:bg-slate-200 rounded-full transition-all text-slate-400"><X size={32} /></button>
              </header>
              <div className="flex-1 overflow-y-auto p-12 space-y-8">
                 <div className="space-y-4">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Domínio do Certificado</label>
                    <input value={certDomainInput} onChange={(e) => setCertDomainInput(e.target.value)} placeholder="*.minha-agencia.com" className="w-full bg-slate-50 border border-slate-200 rounded-3xl py-6 px-10 text-xl font-bold text-slate-900 outline-none focus:ring-4 focus:ring-indigo-600/10" />
                    <p className="text-xs text-slate-500 px-4">Para Wildcards, use o formato <code>*.dominio.com</code>. Para Cloudflare, use o upload manual abaixo.</p>
                 </div>

                 <div className="flex gap-4 p-2 bg-slate-50 rounded-3xl max-w-md mx-auto shadow-inner">
                    <button onClick={() => setSslMode('letsencrypt')} className={`flex-1 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all ${sslMode === 'letsencrypt' ? 'bg-white shadow-md text-indigo-600' : 'text-slate-400'}`}>Let's Encrypt (HTTP-01)</button>
                    <button onClick={() => setSslMode('cloudflare_pem')} className={`flex-1 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all ${sslMode === 'cloudflare_pem' ? 'bg-white shadow-md text-orange-600' : 'text-slate-400'}`}>Cloudflare / Manual PEM</button>
                 </div>

                 {sslMode === 'letsencrypt' ? (
                   <div className="max-w-2xl mx-auto space-y-10 py-4"><div className="bg-indigo-50 border border-indigo-100 p-10 rounded-[3rem] flex gap-8"><Info className="text-indigo-600 shrink-0" size={40} /><div className="space-y-4"><h4 className="font-black text-slate-900 text-xl">Atenção: Sem Wildcards (*)</h4><p className="text-sm text-slate-600 font-medium leading-relaxed">O modo HTTP-01 não suporta Wildcards (*). Use apenas para domínios específicos (ex: painel.site.com). Para Wildcards, use a opção Manual/Cloudflare.</p></div></div><div className="space-y-4"><label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">E-mail para Alertas</label><input value={leEmail} onChange={(e) => setLeEmail(e.target.value)} placeholder="admin@site.com" className="w-full bg-slate-50 border border-slate-200 rounded-3xl py-6 px-10 text-xl font-bold text-slate-900 outline-none" /></div></div>
                 ) : (
                   <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
                      <div className="space-y-4"><label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-2">Certificado (PEM/CRT)</label><textarea value={certPem} onChange={(e) => setCertPem(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" className="w-full h-96 bg-slate-900 text-emerald-400 p-8 rounded-[2.5rem] font-mono text-xs outline-none resize-none shadow-2xl" /></div>
                      <div className="space-y-4"><label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-2">Chave Privada (KEY)</label><textarea value={keyPem} onChange={(e) => setKeyPem(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" className="w-full h-96 bg-slate-900 text-amber-400 p-8 rounded-[2.5rem] font-mono text-xs outline-none resize-none shadow-2xl" /></div>
                   </div>
                 )}
              </div>
              <footer className="p-10 bg-slate-50 border-t border-slate-100 flex gap-6"><button onClick={() => setShowCertModal(false)} className="flex-1 py-6 text-slate-400 font-black uppercase tracking-widest text-[10px] hover:bg-slate-200 rounded-2xl transition-all">Cancelar</button><button onClick={handleSaveCertificate} disabled={loading} className="flex-[3] bg-slate-900 text-white py-6 rounded-[2rem] font-black uppercase tracking-widest text-[10px] flex items-center justify-center gap-4 shadow-2xl active:scale-95 disabled:opacity-30 transition-all">{loading ? <Loader2 size={16} className="animate-spin" /> : <><CheckCircle2 size={18} /> Salvar no Cofre</>}</button></footer>
           </div>
        </div>
      )}
    </div>
  );
};

export default SystemSettings;
