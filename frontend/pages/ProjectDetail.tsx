
import React, { useState, useEffect, useMemo } from 'react';
import { 
  Shield, Key, Database, Activity, CheckCircle2, Loader2, Server, 
  Settings2, Globe, Lock, Workflow, ExternalLink, Power, ArrowRight, 
  BookOpen, Zap, BarChart3, AlertCircle, Brain, Cable, Network, 
  Cpu, HardDrive, Wifi, Radio, Clock
} from 'lucide-react';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, 
  ResponsiveContainer, BarChart, Bar, Cell, PieChart, Pie
} from 'recharts';
import ProjectSettings from './ProjectSettings';
import ProjectIntelligence from './ProjectIntelligence';

// --- TYPES ---
type TabType = 'overview' | 'intelligence' | 'settings';

interface ProjectStats {
  tables: number;
  users: number;
  size: string;
  active_connections: number;
  throughput: Array<{ name: string; requests: number; success: number; error: number }>;
}

interface ProjectData {
  id: string;
  name: string;
  slug: string;
  status: string;
  custom_domain?: string;
  metadata?: {
    external_db_url?: string;
    timezone?: string;
  };
}

// --- SUB-COMPONENTS (Hoisted for Safety) ---

const StatCard: React.FC<{ 
  title: string; 
  value: string; 
  icon: React.ReactNode; 
  label: string; 
  trend?: string;
  trendUp?: boolean;
  color?: string;
}> = ({ title, value, icon, label, trend, trendUp, color = "indigo" }) => {
  const colorClasses: Record<string, string> = {
    indigo: "text-indigo-600 bg-indigo-50 border-indigo-100 group-hover:border-indigo-200",
    emerald: "text-emerald-600 bg-emerald-50 border-emerald-100 group-hover:border-emerald-200",
    blue: "text-blue-600 bg-blue-50 border-blue-100 group-hover:border-blue-200",
    amber: "text-amber-600 bg-amber-50 border-amber-100 group-hover:border-amber-200",
    rose: "text-rose-600 bg-rose-50 border-rose-100 group-hover:border-rose-200",
  };

  const bgClass = colorClasses[color] || colorClasses.indigo;

  return (
    <div className="bg-white border border-slate-200 rounded-[2rem] p-6 shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all duration-300 group relative overflow-hidden">
      <div className={`absolute top-0 right-0 p-6 opacity-5 scale-150 transition-transform group-hover:scale-[1.75] duration-500 ${color === 'indigo' ? 'text-indigo-900' : ''}`}>
        {icon}
      </div>
      <div className="relative z-10">
        <div className="flex justify-between items-start mb-4">
           <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${bgClass} shadow-inner transition-colors`}>
              {icon}
           </div>
           {trend && (
             <div className={`px-2 py-1 rounded-lg text-[10px] font-bold flex items-center gap-1 ${trendUp ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                {trendUp ? '↑' : '↓'} {trend}
             </div>
           )}
        </div>
        <div className="space-y-1">
           <div className="text-3xl font-black text-slate-900 tracking-tighter">{value}</div>
           <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
             {title}
             <span className="w-1 h-1 rounded-full bg-slate-300"></span>
             <span>{label}</span>
           </div>
        </div>
      </div>
    </div>
  );
};

const QuickAction: React.FC<{
  icon: React.ReactNode;
  label: string;
  desc: string;
  onClick: () => void;
}> = ({ icon, label, desc, onClick }) => (
  <button 
    onClick={onClick}
    className="flex items-center gap-4 p-4 rounded-2xl bg-white border border-slate-100 hover:border-indigo-200 hover:shadow-lg hover:bg-slate-50 transition-all text-left group w-full"
  >
    <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-slate-500 group-hover:bg-indigo-600 group-hover:text-white transition-all shadow-sm">
      {icon}
    </div>
    <div>
      <div className="text-xs font-bold text-slate-900 group-hover:text-indigo-700 transition-colors">{label}</div>
      <div className="text-[10px] text-slate-400 font-medium">{desc}</div>
    </div>
    <div className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity transform translate-x-2 group-hover:translate-x-0">
      <ArrowRight size={14} className="text-indigo-400"/>
    </div>
  </button>
);

// --- MAIN COMPONENT ---

const ProjectDetail: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [projectData, setProjectData] = useState<ProjectData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());

  const fetchProjectData = async () => {
    try {
      const token = localStorage.getItem('cascata_token');
      const headers = { 'Authorization': `Bearer ${token}` };

      // Parallel Fetching for Performance
      const [statsRes, projRes] = await Promise.all([
          fetch(`/api/data/${projectId}/stats`, { headers }),
          fetch('/api/control/projects', { headers })
      ]);

      if (!statsRes.ok) throw new Error("Failed to fetch stats");
      if (!projRes.ok) throw new Error("Failed to fetch project info");

      const statsData = await statsRes.json();
      const projects = await projRes.json();
      
      const current = Array.isArray(projects) ? projects.find((p: any) => p.slug === projectId) : null;
      
      if (!current) throw new Error("Project not found");

      setStats(statsData);
      setProjectData(current);
      setError(null);
      setLastRefreshed(new Date());
    } catch (err: any) {
      console.error('Error fetching data:', err);
      setError(err.message || "Failed to load dashboard data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjectData();
    const interval = setInterval(fetchProjectData, 10000); // 10s auto-refresh
    return () => clearInterval(interval);
  }, [projectId]);

  const getBaseUrl = () => {
      if (projectData?.custom_domain) {
          return `https://${projectData.custom_domain}`;
      }
      return `${window.location.origin}/api/data/${projectId}`;
  };

  const isEjected = !!projectData?.metadata?.external_db_url;

  // Memoized Chart Data
  const chartData = useMemo(() => {
    if (!stats?.throughput) return [];
    return stats.throughput.map(item => ({
        ...item,
        total: item.requests
    }));
  }, [stats]);

  const statusDistribution = useMemo(() => {
    if (!stats?.throughput) return [];
    const totalSuccess = stats.throughput.reduce((acc, cur) => acc + (cur.success || 0), 0);
    const totalError = stats.throughput.reduce((acc, cur) => acc + (cur.error || 0), 0);
    const total = totalSuccess + totalError;
    
    if (total === 0) return [];

    return [
      { name: 'Success (2xx)', value: totalSuccess, color: '#10B981' }, // Emerald
      { name: 'Errors (4xx/5xx)', value: totalError, color: '#F43F5E' } // Rose
    ];
  }, [stats]);

  if (loading && !projectData) {
      return (
          <div className="flex h-full flex-col items-center justify-center space-y-4">
              <Loader2 className="animate-spin text-indigo-600" size={48} />
              <p className="text-slate-400 font-bold text-xs uppercase tracking-widest">Initializing Dashboard...</p>
          </div>
      );
  }

  if (error && !projectData) {
      return (
          <div className="flex h-full items-center justify-center flex-col gap-6 text-slate-400 p-10">
              <div className="w-20 h-20 bg-rose-50 rounded-full flex items-center justify-center">
                  <AlertCircle size={40} className="text-rose-500"/>
              </div>
              <div className="text-center">
                  <h3 className="text-xl font-black text-slate-900 mb-2">Connection Error</h3>
                  <p className="font-medium text-sm text-slate-500 max-w-md">{error}</p>
              </div>
              <button onClick={() => window.location.reload()} className="px-6 py-3 bg-slate-900 text-white rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-indigo-600 transition-all shadow-lg">Retry Connection</button>
          </div>
      );
  }

  // --- RENDER CONTENT ---
  return (
    <div className="p-8 lg:p-12 max-w-[1920px] mx-auto w-full space-y-10 pb-40">
      
      {/* HEADER SECTION */}
      <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-8 animate-in slide-in-from-top-4 duration-700">
        <div>
          <div className="flex items-center gap-3 mb-2">
              <div className={`w-3 h-3 rounded-full ${isEjected ? 'bg-amber-400' : 'bg-emerald-500'} animate-pulse shadow-[0_0_10px_rgba(16,185,129,0.5)]`}></div>
              <span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
                  {isEjected ? 'External Topology' : 'Managed Infrastructure'}
              </span>
          </div>
          <h1 className="text-5xl lg:text-6xl font-black text-slate-900 tracking-tighter leading-tight">
            {projectData?.name || projectId}
          </h1>
          <div className="flex items-center gap-4 mt-4">
             <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-100 rounded-lg border border-slate-200">
                <Globe size={12} className="text-slate-400"/>
                <span className="font-mono text-[10px] font-bold text-slate-600">{projectData?.slug}</span>
             </div>
             <div className="flex items-center gap-2 px-3 py-1.5 bg-indigo-50 rounded-lg border border-indigo-100">
                <Clock size={12} className="text-indigo-400"/>
                <span className="font-mono text-[10px] font-bold text-indigo-700">{projectData?.metadata?.timezone || 'UTC'}</span>
             </div>
          </div>
        </div>

        {/* TAB NAVIGATION */}
        <div className="flex bg-slate-100 p-1.5 rounded-2xl shadow-inner overflow-x-auto max-w-full">
          {[
              { id: 'overview', icon: Activity, label: 'Mission Control' },
              { id: 'intelligence', icon: Brain, label: 'Neural Core (AI)' },
              { id: 'settings', icon: Settings2, label: 'System Config' }
          ].map(tab => (
              <button 
                key={tab.id}
                onClick={() => setActiveTab(tab.id as TabType)} 
                className={`
                    px-6 py-3.5 text-xs font-black rounded-xl transition-all flex items-center gap-3 whitespace-nowrap
                    ${activeTab === tab.id 
                        ? 'bg-white shadow-xl text-indigo-600 ring-1 ring-black/5 scale-100' 
                        : 'text-slate-500 hover:text-slate-800 hover:bg-white/50'}
                `}
              >
                  <tab.icon size={16} strokeWidth={2.5}/> 
                  <span className="uppercase tracking-widest">{tab.label}</span>
              </button>
          ))}
        </div>
      </div>

      {/* DYNAMIC CONTENT AREA */}
      <div className="min-h-[500px]">
        {activeTab === 'overview' && (
          <div className="space-y-10 animate-in fade-in slide-in-from-bottom-8 duration-500">
            
            {/* KPI STATS GRID */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <StatCard 
                title="Total Entities" 
                value={stats?.tables?.toString() || '0'} 
                icon={<Database size={24}/>} 
                label="public schema" 
                color="indigo"
              />
              <StatCard 
                title="Identity Records" 
                value={stats?.users?.toString() || '0'} 
                icon={<Shield size={24}/>} 
                label="auth.users" 
                color="emerald"
                trend="+2%" trendUp={true}
              />
              <StatCard 
                title="Volume Usage" 
                value={stats?.size || '0 MB'} 
                icon={<HardDrive size={24}/>} 
                label="physical disk" 
                color="blue"
              />
              <StatCard 
                title="Active Sessions" 
                value={stats?.active_connections?.toString() || '0'} 
                icon={<Network size={24}/>} 
                label="db connections" 
                color="amber"
              />
            </div>

            {/* MAIN DASHBOARD LAYOUT */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                
                {/* LEFT: CHARTS (8 cols) */}
                <div className="lg:col-span-8 space-y-8">
                    {/* Throughput Chart */}
                    <div className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm relative overflow-hidden group">
                        <div className="absolute inset-0 bg-gradient-to-b from-white via-white to-slate-50/50 opacity-0 group-hover:opacity-100 transition-opacity duration-700"></div>
                        <div className="relative z-10">
                            <div className="flex items-center justify-between mb-8">
                                <div>
                                    <h3 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-3">
                                        <Activity size={20} className="text-indigo-600"/> Traffic Pulse
                                    </h3>
                                    <p className="text-slate-400 text-xs font-bold mt-1 uppercase tracking-widest">Requests / Hour (Last 24h)</p>
                                </div>
                                <div className="text-[10px] font-mono text-slate-400 bg-slate-50 px-2 py-1 rounded">
                                    Last update: {lastRefreshed.toLocaleTimeString()}
                                </div>
                            </div>
                            
                            <div className="h-[350px] w-full">
                                {chartData.length > 0 ? (
                                    <ResponsiveContainer width="100%" height="100%">
                                        <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                                            <defs>
                                                <linearGradient id="colorReq" x1="0" y1="0" x2="0" y2="1">
                                                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3}/>
                                                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                                                </linearGradient>
                                                <linearGradient id="colorErr" x1="0" y1="0" x2="0" y2="1">
                                                    <stop offset="5%" stopColor="#F43F5E" stopOpacity={0.3}/>
                                                    <stop offset="95%" stopColor="#F43F5E" stopOpacity={0}/>
                                                </linearGradient>
                                            </defs>
                                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                                            <XAxis 
                                                dataKey="name" 
                                                axisLine={false} 
                                                tickLine={false} 
                                                tick={{fontSize: 10, fill: '#94a3b8', fontWeight: 700}} 
                                                minTickGap={40}
                                                dy={10}
                                            />
                                            <YAxis 
                                                axisLine={false} 
                                                tickLine={false} 
                                                tick={{fontSize: 10, fill: '#94a3b8', fontWeight: 700}} 
                                            />
                                            <Tooltip 
                                                contentStyle={{borderRadius: '16px', border: 'none', boxShadow: '0 20px 40px rgba(0,0,0,0.1)', padding: '16px', background: 'rgba(255,255,255,0.95)'}}
                                                itemStyle={{fontSize: '12px', fontWeight: 'bold', color: '#1e293b'}}
                                                cursor={{stroke: '#cbd5e1', strokeWidth: 1, strokeDasharray: '4 4'}}
                                            />
                                            <Area type="monotone" dataKey="requests" stroke="#6366f1" strokeWidth={3} fillOpacity={1} fill="url(#colorReq)" name="Total Requests" />
                                            <Area type="monotone" dataKey="error" stroke="#F43F5E" strokeWidth={3} fillOpacity={1} fill="url(#colorErr)" name="Errors" />
                                        </AreaChart>
                                    </ResponsiveContainer>
                                ) : (
                                    <div className="flex h-full flex-col items-center justify-center text-slate-300">
                                         <Wifi size={48} className="mb-4 opacity-20"/>
                                         <span className="text-xs font-black uppercase tracking-widest">Awaiting Traffic Signal</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Quick Actions Grid */}
                    <div>
                        <h4 className="text-sm font-black text-slate-400 uppercase tracking-widest mb-4 px-2">Quick Navigation</h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            <QuickAction 
                                icon={<Database size={20}/>}
                                label="SQL Editor"
                                desc="Execute raw queries"
                                onClick={() => window.location.hash = `#/project/${projectId}/database`}
                            />
                            <QuickAction 
                                icon={<Lock size={20}/>}
                                label="Security Rules"
                                desc="RLS & Policies"
                                onClick={() => window.location.hash = `#/project/${projectId}/rls`}
                            />
                            <QuickAction 
                                icon={<Server size={20}/>}
                                label="Storage"
                                desc="Buckets & Assets"
                                onClick={() => window.location.hash = `#/project/${projectId}/storage`}
                            />
                        </div>
                    </div>
                </div>

                {/* RIGHT: INFO & HEALTH (4 cols) */}
                <div className="lg:col-span-4 space-y-8">
                    
                    {/* Health Status Widget */}
                    <div className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm flex flex-col h-[400px]">
                        <h3 className="text-lg font-black text-slate-900 mb-6 flex items-center gap-2">
                           <Radio size={20} className="text-emerald-500 animate-pulse"/> Health Monitor
                        </h3>
                        <div className="flex-1 relative">
                             {statusDistribution.length > 0 ? (
                                <ResponsiveContainer width="100%" height="100%">
                                    <BarChart data={statusDistribution} layout="vertical" barSize={32}>
                                        <XAxis type="number" hide />
                                        <YAxis 
                                            dataKey="name" 
                                            type="category" 
                                            width={110} 
                                            tick={{fontSize: 10, fill: '#64748b', fontWeight: 700}} 
                                            axisLine={false} 
                                            tickLine={false}
                                        />
                                        <Tooltip 
                                            cursor={{fill: 'transparent'}} 
                                            contentStyle={{borderRadius: '12px', border: 'none', boxShadow: '0 5px 20px rgba(0,0,0,0.1)'}}
                                        />
                                        <Bar dataKey="value" radius={[0, 10, 10, 0]}>
                                            {statusDistribution.map((entry: any, index: number) => (
                                                <Cell key={`cell-${index}`} fill={entry.color} />
                                            ))}
                                        </Bar>
                                    </BarChart>
                                </ResponsiveContainer>
                             ) : (
                                <div className="flex h-full items-center justify-center text-xs text-slate-400 font-bold uppercase tracking-widest">No health data</div>
                             )}
                        </div>
                    </div>

                    {/* Endpoint Card */}
                    <div className="bg-gradient-to-br from-indigo-900 to-slate-900 text-white rounded-[2.5rem] p-8 relative overflow-hidden shadow-xl">
                        <div className="absolute top-0 right-0 p-6 opacity-10"><Globe size={120}/></div>
                        <div className="relative z-10">
                            <h3 className="text-lg font-black mb-4 flex items-center gap-2"><Globe size={18} className="text-indigo-400"/> API Endpoint</h3>
                            
                            <div className="bg-white/10 backdrop-blur-md border border-white/10 rounded-xl px-4 py-4 mb-6">
                                <code className="font-mono text-[10px] text-indigo-200 block break-all select-all cursor-text">
                                    {getBaseUrl()}
                                </code>
                            </div>

                            <button 
                                onClick={() => window.location.hash = `#/project/${projectId}/docs`}
                                className="w-full py-3.5 bg-white text-indigo-900 rounded-xl shadow-lg flex items-center justify-center gap-2 group hover:bg-indigo-50 transition-all text-xs font-black uppercase tracking-widest"
                            >
                                <BookOpen size={14} className="text-indigo-600"/> 
                                Open Documentation 
                                <ArrowRight size={14} className="-ml-1 opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all"/>
                            </button>
                        </div>
                    </div>

                    {/* System Meta */}
                    <div className="bg-slate-50 rounded-[2.5rem] p-6 border border-slate-200">
                        <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-4 px-2">System Info</h4>
                        <div className="space-y-3">
                            <div className="flex justify-between items-center px-2">
                                <span className="text-xs font-bold text-slate-600">Database</span>
                                <span className="text-xs font-mono text-slate-400">{projectData?.status === 'healthy' ? 'Online' : 'Degraded'}</span>
                            </div>
                            <div className="flex justify-between items-center px-2">
                                <span className="text-xs font-bold text-slate-600">Region</span>
                                <span className="text-xs font-mono text-slate-400">Local (Edge)</span>
                            </div>
                            <div className="flex justify-between items-center px-2">
                                <span className="text-xs font-bold text-slate-600">Version</span>
                                <span className="text-xs font-mono text-slate-400">v2.4.0</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
          </div>
        )}

        {activeTab === 'intelligence' && (
          <div className="animate-in fade-in slide-in-from-right-4 duration-500">
             <ProjectIntelligence projectId={projectId} />
          </div>
        )}

        {activeTab === 'settings' && (
           <div className="animate-in fade-in slide-in-from-right-4 duration-500">
             <ProjectSettings projectId={projectId} />
           </div>
        )}
      </div>
    </div>
  );
};

export default ProjectDetail;
