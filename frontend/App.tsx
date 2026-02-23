
import React, { useState, useEffect } from 'react';
import { 
  Database, Settings, Shield, Activity, Code2, Users, Layers,
  Plus, Search, Terminal, Server, Key, LogOut, Clock, Settings2, HardDrive, Zap, BookOpen,
  Pin, PinOff, Smartphone, GitBranch, Rocket, Loader2, RefreshCw, Trash2, Sliders, GitPullRequest, Play, RefreshCcw, ChevronRight
} from 'lucide-react';
import Dashboard from './pages/Dashboard';
import ProjectDetail from './pages/ProjectDetail';
import DatabaseExplorer from './pages/DatabaseExplorer';
import AuthConfig from './pages/AuthConfig';
import RLSManager from './pages/RLSManager';
import RPCManager from './pages/RPCManager';
import Login from './pages/Login';
import SystemSettings from './pages/SystemSettings';
import StorageExplorer from './pages/StorageExplorer';
import EventManager from './pages/EventManager';
import ProjectLogs from './pages/ProjectLogs';
import RLSDesigner from './pages/RLSDesigner';
import APIDocs from './pages/APIDocs';
import PushManager from './pages/PushManager';
import ProjectBackups from './pages/ProjectBackups';
import CascataArchitect from './components/CascataArchitect';
import DeployWizard from './components/deploy/DeployWizard'; // NEW IMPORT

// --- GLOBAL FETCH INTERCEPTOR ---
const originalFetch = window.fetch;
window.fetch = async (input, init = {}) => {
    const env = localStorage.getItem('cascata_env');
    if (env) {
        init.headers = { 
            ...(init.headers || {}), 
            'x-cascata-env': env 
        };
    }
    return originalFetch(input, init);
};

const App: React.FC = () => {
  const [currentHash, setCurrentHash] = useState(window.location.hash || '#/projects');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(!!localStorage.getItem('cascata_token'));

  // --- ENVIRONMENT STATE ---
  const [currentEnv, setCurrentEnv] = useState<'live' | 'draft'>(() => 
      (localStorage.getItem('cascata_env') as 'live'|'draft') || 'live'
  );
  
  // DEPLOY STATE (Now Managed by Wizard)
  const [showDeployWizard, setShowDeployWizard] = useState(false);
  
  const [envLoading, setEnvLoading] = useState(false);

  // --- DRAFT CREATION & REBASE STATE ---
  const [showCreateDraftModal, setShowCreateDraftModal] = useState(false);
  const [showRebaseModal, setShowRebaseModal] = useState(false);
  const [draftDataPercent, setDraftDataPercent] = useState<number>(100);
  
  // --- SIDEBAR STATE ---
  const [isSidebarLocked, setIsSidebarLocked] = useState<boolean>(() => {
    return localStorage.getItem('cascata_sidebar_locked') !== 'false'; 
  });
  const [isSidebarHovered, setIsSidebarHovered] = useState(false);

  const isExpanded = isSidebarLocked || isSidebarHovered;

  useEffect(() => {
    localStorage.setItem('cascata_sidebar_locked', String(isSidebarLocked));
  }, [isSidebarLocked]);

  useEffect(() => {
    localStorage.setItem('cascata_env', currentEnv);
    window.dispatchEvent(new Event('cascata_env_change'));
  }, [currentEnv]);

  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash || '#/projects';
      setCurrentHash(hash);
      const parts = hash.split('/');
      if (parts[1] === 'project' && parts[2]) setSelectedProjectId(parts[2]);
      else setSelectedProjectId(null);
    };
    window.addEventListener('hashchange', handleHashChange);
    handleHashChange();
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const navigate = (hash: string) => { window.location.hash = hash; };
  const handleLogout = () => { localStorage.removeItem('cascata_token'); setIsAuthenticated(false); navigate('#/login'); };

  // --- ENVIRONMENT LOGIC ---
  const handleEnvSwitchClick = async () => {
      if (currentEnv === 'draft') {
          setCurrentEnv('live');
          window.location.reload();
          return;
      }
      setEnvLoading(true);
      try {
          const res = await fetch(`/api/data/${selectedProjectId}/branch/status`, {
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          const data = await res.json();
          if (data.has_draft) {
              // DRAFT EXISTS: OFFER SYNC (REBASE) OPTION
              setShowRebaseModal(true);
          } else {
              // NO DRAFT: CREATE NEW
              setShowCreateDraftModal(true);
              setDraftDataPercent(100); // Reset to full clone default
          }
      } catch (e) {
          console.error("Draft check failed", e);
      } finally {
          setEnvLoading(false);
      }
  };

  const handleCreateDraft = async () => {
      setEnvLoading(true);
      try {
          await fetch(`/api/data/${selectedProjectId}/branch/create`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ percent: draftDataPercent })
          });
          setShowCreateDraftModal(false);
          setShowRebaseModal(false);
          setCurrentEnv('draft');
          window.location.reload();
      } catch (e) {
          alert("Failed to create draft.");
      } finally {
          setEnvLoading(false);
      }
  };

  const handleResumeDraft = () => {
      setShowRebaseModal(false);
      setCurrentEnv('draft');
      window.location.reload();
  };

  const handleDeleteDraft = async () => {
      if (!confirm("Are you sure? This will delete the Draft environment and all un-deployed changes.")) return;
      setEnvLoading(true);
      try {
          await fetch(`/api/data/${selectedProjectId}/branch/draft`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          setCurrentEnv('live');
          window.location.reload();
      } catch (e) {
          alert("Failed to delete draft.");
          setEnvLoading(false);
      }
  };

  const renderContent = () => {
    if (currentHash === '#/login') return <Login onLoginSuccess={() => setIsAuthenticated(true)} />;
    if (!isAuthenticated) return <Login onLoginSuccess={() => setIsAuthenticated(true)} />;
    if (currentHash === '#/projects' || currentHash === '') return <Dashboard onSelectProject={(id) => navigate(`#/project/${id}`)} />;
    if (currentHash === '#/settings') return <SystemSettings />;
    
    if (currentHash.startsWith('#/project/')) {
      const parts = currentHash.split('/');
      const projectId = parts[2];
      const section = parts[3] || 'overview';

      if (section === 'rls-editor') {
        const entityType = parts[4] as 'table' | 'bucket';
        const entityName = parts[5];
        return <RLSDesigner projectId={projectId} entityType={entityType} entityName={entityName} onBack={() => navigate(`#/project/${projectId}/rls`)} />;
      }
      const key = `${projectId}-${currentEnv}`;

      switch(section) {
        case 'overview': return <ProjectDetail key={key} projectId={projectId} />;
        case 'database': return <DatabaseExplorer key={key} projectId={projectId} />;
        case 'auth': return <AuthConfig key={key} projectId={projectId} />;
        case 'rls': return <RLSManager key={key} projectId={projectId} />;
        case 'rpc': return <RPCManager key={key} projectId={projectId} />;
        case 'storage': return <StorageExplorer key={key} projectId={projectId} />;
        case 'events': return <EventManager key={key} projectId={projectId} />;
        case 'push': return <PushManager key={key} projectId={projectId} />;
        case 'logs': return <ProjectLogs key={key} projectId={projectId} />;
        case 'docs': return <APIDocs key={key} projectId={projectId} />;
        case 'backups': return <ProjectBackups key={key} projectId={projectId} />;
        default: return <ProjectDetail key={key} projectId={projectId} />;
      }
    }
    return <Dashboard onSelectProject={(id) => navigate(`#/project/${id}`)} />;
  };

  if (currentHash === '#/login' || !isAuthenticated) return renderContent();

  const isImmersive = currentHash.includes('/rls-editor');

  return (
    <div className="flex h-screen bg-[#F8FAFC] overflow-hidden">
      {!isImmersive && (
        <>
          {/* SIDEBAR CONTAINER */}
          <aside 
            className={`
              fixed top-0 left-0 h-full bg-white border-r border-slate-200 shadow-xl z-50 
              transition-all duration-300 ease-in-out flex flex-col
              ${isExpanded ? 'w-[260px]' : 'w-[88px]'}
            `}
            onMouseEnter={() => setIsSidebarHovered(true)}
            onMouseLeave={() => setIsSidebarHovered(false)}
          >
            {/* HEADER */}
            <div className={`p-5 flex items-center ${isExpanded ? 'justify-between' : 'justify-center'} border-b border-slate-100 transition-all duration-300`}>
              {isExpanded ? (
                <div className="flex items-center gap-3 animate-in fade-in duration-300">
                  <div className="w-9 h-9 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-200 shrink-0">
                    <Layers className="text-white w-5 h-5" />
                  </div>
                  <div>
                    <span className="font-bold text-lg tracking-tight text-slate-900 block leading-none">Cascata</span>
                    <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1 block">Studio v1.0</span>
                  </div>
                </div>
              ) : (
                <div className="w-12 h-12 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-200 shrink-0 mb-2">
                  <Layers className="text-white w-7 h-7" />
                </div>
              )}

              {isExpanded && (
                <button 
                  onClick={() => setIsSidebarLocked(!isSidebarLocked)}
                  className={`p-1.5 rounded-lg transition-colors ${isSidebarLocked ? 'text-indigo-600 bg-indigo-50' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'}`}
                  title={isSidebarLocked ? "Destravar Menu" : "Travar Menu"}
                >
                  {isSidebarLocked ? <Pin size={16} className="fill-current" /> : <PinOff size={16} />}
                </button>
              )}
            </div>

            {/* NAV CONTENT */}
            <nav className="flex-1 p-3 space-y-2 overflow-y-auto overflow-x-hidden custom-scrollbar">
              {selectedProjectId && (
                <>
                  {isExpanded && <div className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] mb-2 px-3 mt-2 animate-in fade-in">Instance</div>}
                  
                  <SidebarItem icon={<Activity />} label="Overview" active={currentHash.includes('/overview')} expanded={isExpanded} onClick={() => navigate(`#/project/${selectedProjectId}/overview`)} />
                  <SidebarItem icon={<Database />} label="Data Browser" active={currentHash.includes('/database')} expanded={isExpanded} onClick={() => navigate(`#/project/${selectedProjectId}/database`)} />
                  <SidebarItem icon={<HardDrive />} label="Native Storage" active={currentHash.includes('/storage')} expanded={isExpanded} onClick={() => navigate(`#/project/${selectedProjectId}/storage`)} />
                  <SidebarItem icon={<Zap />} label="Event Hooks" active={currentHash.includes('/events')} expanded={isExpanded} onClick={() => navigate(`#/project/${selectedProjectId}/events`)} />
                  <SidebarItem icon={<Terminal />} label="API Traffic" active={currentHash.includes('/logs')} expanded={isExpanded} onClick={() => navigate(`#/project/${selectedProjectId}/logs`)} />
                  <SidebarItem icon={<Shield />} label="Access Control" active={currentHash.includes('/rls')} expanded={isExpanded} onClick={() => navigate(`#/project/${selectedProjectId}/rls`)} />
                  <SidebarItem icon={<Clock />} label="RPC & Logic" active={currentHash.includes('/rpc')} expanded={isExpanded} onClick={() => navigate(`#/project/${selectedProjectId}/rpc`)} />
                  <SidebarItem icon={<Smartphone />} label="Push Engine" active={currentHash.includes('/push')} expanded={isExpanded} onClick={() => navigate(`#/project/${selectedProjectId}/push`)} />
                  <SidebarItem icon={<Users />} label="Auth Services" active={currentHash.includes('/auth')} expanded={isExpanded} onClick={() => navigate(`#/project/${selectedProjectId}/auth`)} />
                  <SidebarItem icon={<Settings />} label="Backups" active={currentHash.includes('/backups')} expanded={isExpanded} onClick={() => navigate(`#/project/${selectedProjectId}/backups`)} />
                  <SidebarItem icon={<BookOpen />} label="API Docs" active={currentHash.includes('/docs')} expanded={isExpanded} onClick={() => navigate(`#/project/${selectedProjectId}/docs`)} />
                  
                  <div className={`my-4 h-[1px] bg-slate-100 ${isExpanded ? 'mx-3' : 'mx-1'}`}></div>
                </>
              )}
            </nav>

            {/* ENVIRONMENT SWITCHER WIDGET */}
            {selectedProjectId && (
              <div className="px-3 pb-2 animate-in fade-in slide-in-from-bottom-2">
                <div 
                  className={`
                    rounded-xl border transition-all duration-300 relative overflow-hidden
                    ${currentEnv === 'live' ? 'bg-emerald-50/50 border-emerald-100' : 'bg-amber-50/50 border-amber-100'}
                    ${isExpanded ? 'p-3' : 'p-2 flex flex-col items-center gap-2'}
                  `}
                >
                  <div className={`flex items-center ${isExpanded ? 'justify-between' : 'justify-center'} w-full`}>
                    {isExpanded ? (
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${currentEnv === 'live' ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]'}`}></div>
                        <span className={`text-xs font-black uppercase tracking-widest ${currentEnv === 'live' ? 'text-emerald-800' : 'text-amber-800'}`}>
                          {currentEnv}
                        </span>
                      </div>
                    ) : (
                      <div 
                         className={`w-3 h-3 rounded-full ${currentEnv === 'live' ? 'bg-emerald-500' : 'bg-amber-500'}`}
                         title={`Current Environment: ${currentEnv.toUpperCase()}`}
                      ></div>
                    )}
                    
                    <button 
                      onClick={handleEnvSwitchClick}
                      className={`p-1.5 rounded-lg transition-colors ${currentEnv === 'live' ? 'hover:bg-emerald-100 text-emerald-600' : 'hover:bg-amber-100 text-amber-600'}`}
                      title={currentEnv === 'live' ? "Switch to Draft" : "Switch to Live"}
                    >
                      <RefreshCw size={14} className={envLoading ? 'animate-spin' : ''} />
                    </button>
                  </div>

                  {currentEnv === 'draft' && isExpanded && (
                     <div className="flex gap-2 mt-3">
                         <button 
                            onClick={handleDeleteDraft}
                            className="flex-1 bg-rose-50 hover:bg-rose-100 text-rose-600 text-[10px] font-black uppercase tracking-widest py-2 rounded-lg transition-all active:scale-95 flex items-center justify-center"
                            title="Discard Draft"
                         >
                            <Trash2 size={12} />
                         </button>
                         <button 
                            onClick={() => setShowDeployWizard(true)}
                            className="flex-[3] bg-amber-500 hover:bg-amber-600 text-white text-[10px] font-black uppercase tracking-widest py-2 rounded-lg shadow-sm flex items-center justify-center gap-2 transition-all active:scale-95"
                         >
                            <Rocket size={12} /> Deploy
                         </button>
                     </div>
                  )}
                  
                  {currentEnv === 'draft' && !isExpanded && (
                     <button onClick={() => setShowDeployWizard(true)} className="mt-1 text-amber-500 hover:text-amber-600"><Rocket size={16}/></button>
                  )}
                </div>
              </div>
            )}

            {/* FOOTER NAV */}
            <div className="p-3 pb-4 space-y-2 bg-white border-t border-slate-50">
              {isExpanded && <div className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] mb-2 px-3 animate-in fade-in">Main Console</div>}
              
              <SidebarItem icon={<Server />} label="All Projects" active={currentHash === '#/projects'} expanded={isExpanded} onClick={() => navigate('#/projects')} />
              <SidebarItem icon={<Settings2 />} label="System Settings" active={currentHash === '#/settings'} expanded={isExpanded} onClick={() => navigate('#/settings')} />
              
              <div className={`my-2 h-[1px] bg-slate-100 ${isExpanded ? 'mx-0' : 'mx-1'}`}></div>
              
              <button 
                onClick={handleLogout} 
                className={`
                  w-full flex items-center rounded-xl transition-all group font-medium border border-transparent
                  ${isExpanded 
                    ? 'justify-between px-3 py-2 bg-slate-50 border-slate-200 text-slate-500 hover:text-rose-600 text-xs' 
                    : 'justify-center p-3 text-slate-400 hover:bg-rose-50 hover:text-rose-600'}
                `}
                title="Logout"
              >
                 <div className="flex items-center gap-2">
                    <LogOut size={isExpanded ? 14 : 20} />
                    {isExpanded && <span>Logout</span>}
                 </div>
              </button>
            </div>
          </aside>

          <div className={`shrink-0 transition-all duration-300 ease-in-out ${isSidebarLocked ? 'w-[260px]' : 'w-[88px]'}`} />
        </>
      )}

      <main className="flex-1 overflow-y-auto flex flex-col relative text-slate-900 h-full w-full">
        <div className="flex-1 min-w-0">
            {renderContent()}
        </div>
        {selectedProjectId && <CascataArchitect projectId={selectedProjectId} />}
      </main>

      {/* CREATE DRAFT MODAL */}
      {showCreateDraftModal && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[900] flex items-center justify-center p-8 animate-in zoom-in-95">
              <div className="bg-white rounded-[2.5rem] w-full max-w-lg p-10 shadow-2xl border border-slate-200 flex flex-col">
                  <div className="mb-6 text-center">
                      <div className="w-16 h-16 bg-amber-50 rounded-2xl flex items-center justify-center mx-auto mb-4 text-amber-600"><GitBranch size={32}/></div>
                      <h3 className="text-2xl font-black text-slate-900 tracking-tight">Create Draft Environment</h3>
                      <p className="text-xs text-slate-500 font-bold uppercase tracking-widest mt-2">Configure Data Snapshot</p>
                  </div>
                  
                  <div className="space-y-6 mb-8">
                      {/* SLIDER FOR PERCENTAGE */}
                      <div className="bg-slate-50 rounded-2xl p-6 border border-slate-100">
                           <div className="flex justify-between items-center mb-4">
                               <label className="text-xs font-black text-slate-600 uppercase tracking-widest flex items-center gap-2">
                                   <Sliders size={14}/> Static Data Clone
                               </label>
                               <span className={`text-sm font-black px-3 py-1 rounded-lg ${draftDataPercent === 100 ? 'bg-indigo-600 text-white' : draftDataPercent === 0 ? 'bg-slate-200 text-slate-600' : 'bg-indigo-100 text-indigo-700'}`}>
                                   {draftDataPercent}%
                               </span>
                           </div>
                           
                           <input 
                               type="range" 
                               min="0" 
                               max="100" 
                               step="10" 
                               value={draftDataPercent} 
                               onChange={(e) => setDraftDataPercent(parseInt(e.target.value))}
                               className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600 hover:accent-indigo-700"
                           />
                           
                           <div className="flex justify-between text-[9px] font-bold text-slate-400 mt-2 uppercase tracking-widest">
                               <span>0% (Empty)</span>
                               <span>50%</span>
                               <span>100% (Full Copy)</span>
                           </div>

                           <div className="mt-4 p-3 bg-white border border-slate-100 rounded-xl">
                               <p className="text-[10px] text-slate-500 leading-relaxed font-medium">
                                   This creates a <b>Static Snapshot</b> of your current live data. 
                                   <br/>
                                   Changes made to data in the Draft environment <b>do not sync</b> to live, and live changes do not sync here.
                                   <br/>
                                   {draftDataPercent === 0 && "Use 0% for pure schema updates (faster)."}
                               </p>
                           </div>
                      </div>
                  </div>

                  <div className="flex gap-4">
                      <button onClick={() => setShowCreateDraftModal(false)} className="flex-1 py-4 text-xs font-black text-slate-400 uppercase tracking-widest hover:bg-slate-50 rounded-2xl transition-all">Cancel</button>
                      <button onClick={handleCreateDraft} disabled={envLoading} className="flex-[2] bg-slate-900 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-600 transition-all flex items-center justify-center gap-2">
                          {envLoading ? <Loader2 size={16} className="animate-spin"/> : 'Provision Environment'}
                      </button>
                  </div>
              </div>
          </div>
      )}

      {/* REBASE MODAL (SYNC FROM LIVE) */}
      {showRebaseModal && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[900] flex items-center justify-center p-8 animate-in zoom-in-95">
              <div className="bg-white rounded-[2.5rem] w-full max-w-xl p-10 shadow-2xl border border-slate-200 flex flex-col">
                  <div className="mb-6">
                      <div className="flex items-center gap-4 mb-4">
                          <div className="w-14 h-14 bg-indigo-100 text-indigo-600 rounded-2xl flex items-center justify-center shadow-sm">
                              <GitPullRequest size={28}/>
                          </div>
                          <div>
                              <h3 className="text-2xl font-black text-slate-900 tracking-tight">Sync Strategy</h3>
                              <p className="text-xs text-slate-500 font-bold uppercase tracking-widest mt-1">Existing Draft Detected</p>
                          </div>
                      </div>
                      <p className="text-sm text-slate-600 leading-relaxed font-medium">
                          You already have a Draft environment active. <br/>
                          Live production may have changed since you last worked on this draft.
                      </p>
                  </div>

                  <div className="space-y-4 mb-8">
                      <button 
                          onClick={handleResumeDraft}
                          className="w-full text-left p-5 rounded-2xl border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50 transition-all group relative overflow-hidden"
                      >
                          <div className="flex items-center justify-between relative z-10">
                              <div>
                                  <h4 className="font-black text-slate-800 group-hover:text-indigo-700 flex items-center gap-2">
                                      <Play size={16}/> Resume Work
                                  </h4>
                                  <p className="text-xs text-slate-500 mt-1">Keep current draft state. Do not sync.</p>
                              </div>
                              <ChevronRight className="text-slate-300 group-hover:text-indigo-400"/>
                          </div>
                      </button>

                      <div className="relative">
                          <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-slate-100"></div></div>
                          <div className="relative flex justify-center"><span className="bg-white px-2 text-[10px] font-black text-slate-300 uppercase tracking-widest">OR</span></div>
                      </div>

                      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5">
                          <div className="flex items-center gap-2 mb-4">
                              <RefreshCcw size={16} className="text-amber-600"/>
                              <h4 className="font-black text-slate-800 uppercase text-xs tracking-widest">Rebase from Live (Overwrite)</h4>
                          </div>
                          <p className="text-[10px] text-slate-500 mb-4 leading-relaxed">
                              This will <b>discard all changes</b> in your current Draft and re-clone the Schema, Triggers, and RPCs from Live.
                          </p>
                          
                          {/* Mini Slider for Rebase */}
                          <div className="flex items-center gap-3 mb-4 bg-white p-3 rounded-xl border border-slate-100">
                               <span className="text-[9px] font-bold text-slate-400 uppercase">Data Clone:</span>
                               <input 
                                   type="range" min="0" max="100" step="10" 
                                   value={draftDataPercent} 
                                   onChange={(e) => setDraftDataPercent(parseInt(e.target.value))}
                                   className="flex-1 h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-amber-500"
                               />
                               <span className="text-[10px] font-black text-slate-700 w-8 text-right">{draftDataPercent}%</span>
                          </div>

                          <button 
                              onClick={handleCreateDraft} // Re-uses create logic which acts as overwrite
                              disabled={envLoading}
                              className="w-full bg-slate-900 text-white py-3 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-amber-600 transition-all shadow-lg flex items-center justify-center gap-2"
                          >
                              {envLoading ? <Loader2 size={14} className="animate-spin"/> : 'Confirm Rebase & Sync'}
                          </button>
                      </div>
                  </div>
              </div>
          </div>
      )}

      {/* NEW DEPLOY WIZARD */}
      {showDeployWizard && selectedProjectId && (
          <DeployWizard 
             projectId={selectedProjectId} 
             onClose={() => setShowDeployWizard(false)}
             onSuccess={() => {
                 setCurrentEnv('live');
                 window.location.reload();
             }}
          />
      )}

    </div>
  );
};

// COMPONENTE DE ITEM INTELIGENTE
const SidebarItem: React.FC<{ 
  icon: React.ReactElement, 
  label: string, 
  active: boolean, 
  expanded: boolean, 
  onClick: () => void 
}> = ({ icon, label, active, expanded, onClick }) => {
  // Ajuste do tamanho solicitado: 18px expandido, 23px recolhido (+5px)
  const iconSize = expanded ? 18 : 23;
  const TheIcon = React.cloneElement(icon as React.ReactElement<any>, { size: iconSize });

  return (
    <button 
      onClick={onClick} 
      title={!expanded ? label : undefined}
      className={`
        flex items-center transition-all duration-200 rounded-xl group relative
        ${expanded 
          ? 'w-full gap-3 px-3 py-2.5 text-sm justify-start' 
          : 'w-full justify-center py-4'
        }
        ${active 
          ? 'bg-indigo-600 text-white font-semibold shadow-lg shadow-indigo-200' 
          : 'text-slate-500 hover:bg-slate-50 hover:text-indigo-600'
        }
      `}
    >
      <span className={`transition-colors ${active ? 'text-white' : 'text-slate-400 group-hover:text-indigo-600'}`}>
        {TheIcon}
      </span>
      
      {expanded && (
        <span className="truncate animate-in fade-in slide-in-from-left-2 duration-200">
          {label}
        </span>
      )}

      {/* Indicador Ativo no modo recolhido */}
      {!expanded && active && (
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-indigo-600 rounded-r-full"></div>
      )}
    </button>
  );
};

export default App;
