
import React, { useState, useEffect } from 'react';
import { 
  Database, Settings, Shield, Activity, Code2, Users, Layers,
  ChevronRight, Plus, Search, Terminal, Server, Key, Bell,
  Command, LogOut, Clock, Settings2, HardDrive, Zap, BookOpen,
  PanelLeftClose, PanelLeftOpen, Pin, PinOff
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
import CascataArchitect from './components/CascataArchitect';

const App: React.FC = () => {
  const [currentHash, setCurrentHash] = useState(window.location.hash || '#/projects');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(!!localStorage.getItem('cascata_token'));

  // --- SIDEBAR STATE ---
  const [isSidebarLocked, setIsSidebarLocked] = useState<boolean>(() => {
    return localStorage.getItem('cascata_sidebar_locked') !== 'false'; // Default true
  });
  const [isSidebarHovered, setIsSidebarHovered] = useState(false);

  // Calcula se a sidebar está expandida visualmente (Locked OU Hovered)
  const isExpanded = isSidebarLocked || isSidebarHovered;

  useEffect(() => {
    localStorage.setItem('cascata_sidebar_locked', String(isSidebarLocked));
  }, [isSidebarLocked]);

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

      switch(section) {
        case 'overview': return <ProjectDetail projectId={projectId} />;
        case 'database': return <DatabaseExplorer projectId={projectId} />;
        case 'auth': return <AuthConfig projectId={projectId} />;
        case 'rls': return <RLSManager projectId={projectId} />;
        case 'rpc': return <RPCManager projectId={projectId} />;
        case 'storage': return <StorageExplorer projectId={projectId} />;
        case 'events': return <EventManager projectId={projectId} />;
        case 'logs': return <ProjectLogs projectId={projectId} />;
        case 'docs': return <APIDocs projectId={projectId} />;
        default: return <ProjectDetail projectId={projectId} />;
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
          {/* 
            SIDEBAR CONTAINER 
            Z-Index alto para flutuar sobre o conteúdo quando expandido via hover.
          */}
          <aside 
            className={`
              fixed top-0 left-0 h-full bg-white border-r border-slate-200 shadow-xl z-50 
              transition-all duration-300 ease-in-out flex flex-col
              ${isExpanded ? 'w-[260px]' : 'w-[88px]'}
            `}
            onMouseEnter={() => setIsSidebarHovered(true)}
            onMouseLeave={() => setIsSidebarHovered(false)}
          >
            {/* HEADER DA SIDEBAR */}
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

              {/* LOCK TOGGLE BUTTON (Só visível expandido) */}
              {isExpanded && (
                <button 
                  onClick={() => setIsSidebarLocked(!isSidebarLocked)}
                  className={`p-1.5 rounded-lg transition-colors ${isSidebarLocked ? 'text-indigo-600 bg-indigo-50' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'}`}
                  title={isSidebarLocked ? "Destravar Menu (Flutuante)" : "Travar Menu (Fixo)"}
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
                  
                  <SidebarItem 
                    icon={<Activity />} 
                    label="Overview" 
                    active={currentHash.includes('/overview')} 
                    expanded={isExpanded}
                    onClick={() => navigate(`#/project/${selectedProjectId}/overview`)} 
                  />
                  <SidebarItem 
                    icon={<Database />} 
                    label="Data Browser" 
                    active={currentHash.includes('/database')} 
                    expanded={isExpanded}
                    onClick={() => navigate(`#/project/${selectedProjectId}/database`)} 
                  />
                  <SidebarItem 
                    icon={<HardDrive />} 
                    label="Native Storage" 
                    active={currentHash.includes('/storage')} 
                    expanded={isExpanded}
                    onClick={() => navigate(`#/project/${selectedProjectId}/storage`)} 
                  />
                  <SidebarItem 
                    icon={<Zap />} 
                    label="Event Hooks" 
                    active={currentHash.includes('/events')} 
                    expanded={isExpanded}
                    onClick={() => navigate(`#/project/${selectedProjectId}/events`)} 
                  />
                  <SidebarItem 
                    icon={<Terminal />} 
                    label="API Traffic" 
                    active={currentHash.includes('/logs')} 
                    expanded={isExpanded}
                    onClick={() => navigate(`#/project/${selectedProjectId}/logs`)} 
                  />
                  <SidebarItem 
                    icon={<Shield />} 
                    label="Access Control" 
                    active={currentHash.includes('/rls')} 
                    expanded={isExpanded}
                    onClick={() => navigate(`#/project/${selectedProjectId}/rls`)} 
                  />
                  <SidebarItem 
                    icon={<Clock />} 
                    label="RPC & Logic" 
                    active={currentHash.includes('/rpc')} 
                    expanded={isExpanded}
                    onClick={() => navigate(`#/project/${selectedProjectId}/rpc`)} 
                  />
                  <SidebarItem 
                    icon={<Users />} 
                    label="Auth Services" 
                    active={currentHash.includes('/auth')} 
                    expanded={isExpanded}
                    onClick={() => navigate(`#/project/${selectedProjectId}/auth`)} 
                  />
                  <SidebarItem 
                    icon={<BookOpen />} 
                    label="API Docs" 
                    active={currentHash.includes('/docs')} 
                    expanded={isExpanded}
                    onClick={() => navigate(`#/project/${selectedProjectId}/docs`)} 
                  />
                  
                  <div className={`my-4 h-[1px] bg-slate-100 ${isExpanded ? 'mx-3' : 'mx-1'}`}></div>
                </>
              )}
            </nav>

            {/* FOOTER NAV */}
            <div className="mt-auto p-3 pb-4 space-y-2 bg-white">
              {isExpanded && <div className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] mb-2 px-3 animate-in fade-in">Main Console</div>}
              
              <SidebarItem 
                icon={<Server />} 
                label="All Projects" 
                active={currentHash === '#/projects'} 
                expanded={isExpanded}
                onClick={() => navigate('#/projects')} 
              />
              <SidebarItem 
                icon={<Settings2 />} 
                label="System Settings" 
                active={currentHash === '#/settings'} 
                expanded={isExpanded}
                onClick={() => navigate('#/settings')} 
              />
              
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
                    <LogOut size={isExpanded ? 14 : 28} /> {/* Ícone maior quando recolhido */}
                    {isExpanded && <span>Logout</span>}
                 </div>
              </button>
            </div>
          </aside>

          {/* 
            GHOST SPACER 
            Empurra o conteúdo principal apenas se a barra estiver TRAVADA (isLocked).
            Se não estiver travada (hover mode), o conteúdo ocupa quase tudo, deixando apenas a margem da doca (88px).
          */}
          <div 
            className={`shrink-0 transition-all duration-300 ease-in-out ${isSidebarLocked ? 'w-[260px]' : 'w-[88px]'}`} 
          />
        </>
      )}

      <main className="flex-1 overflow-y-auto flex flex-col relative text-slate-900 h-full w-full">
        <div className="flex-1 min-w-0">
            {renderContent()}
        </div>
        {/* Floating Architect Assistant (Only when inside a project) */}
        {selectedProjectId && <CascataArchitect projectId={selectedProjectId} />}
      </main>
    </div>
  );
};

// COMPONENTE DE ITEM INTELIGENTE
const SidebarItem: React.FC<{ 
  icon: React.ReactElement, // Alterado para Element para clonar com novo tamanho
  label: string, 
  active: boolean, 
  expanded: boolean,
  onClick: () => void 
}> = ({ icon, label, active, expanded, onClick }) => {
  
  // Clone o ícone para ajustar o tamanho dinamicamente
  // Se expandido: tamanho padrão (18)
  // Se recolhido: tamanho aumentado (+14px = 32px) para clique fácil
  const iconSize = expanded ? 18 : 32;
  const TheIcon = React.cloneElement(icon as React.ReactElement<any>, { size: iconSize });

  return (
    <button 
      onClick={onClick} 
      title={!expanded ? label : undefined}
      className={`
        flex items-center transition-all duration-200 rounded-xl group relative
        ${expanded 
          ? 'w-full gap-3 px-3 py-2.5 text-sm justify-start' 
          : 'w-full justify-center py-4' // Mais padding vertical quando recolhido
        }
        ${active 
          ? 'bg-indigo-600 text-white font-semibold shadow-lg shadow-indigo-200' 
          : 'text-slate-500 hover:bg-slate-50 hover:text-indigo-600'
        }
      `}
    >
      <span className={`transition-colors ${active ? 'text-white' : expanded ? 'text-slate-400 group-hover:text-indigo-600' : 'text-slate-400 group-hover:text-indigo-600'}`}>
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
