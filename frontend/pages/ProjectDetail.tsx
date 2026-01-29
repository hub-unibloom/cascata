
import React, { useState, useEffect } from 'react';
import { Shield, Key, Database, Activity, CheckCircle2, Loader2, Server, Settings2, Globe, Lock, Workflow, ExternalLink, Power, ArrowRight, BookOpen, Zap, BarChart3, AlertCircle, Brain, Cable } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Cell } from 'recharts';
import ProjectSettings from './ProjectSettings';
import ProjectIntelligence from './ProjectIntelligence';

const ProjectDetail: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'intelligence' | 'settings'>('overview');
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [projectData, setProjectData] = useState<any>(null);

  const fetchProjectData = async () => {
    try {
      // Fetch stats with real log aggregation
      const statsRes = await fetch(`/api/data/${projectId}/stats`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      const statsData = await statsRes.json();
      setStats(statsData);

      // Fetch project details
      const projRes = await fetch('/api/control/projects', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      const projects = await projRes.json();
      const current = projects.find((p: any) => p.slug === projectId);
      setProjectData(current);

    } catch (err) {
      console.error('Error fetching data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjectData();
  }, [projectId]);

  const getBaseUrl = () => {
      if (projectData?.custom_domain) {
          return `https://${projectData.custom_domain}`;
      }
      return `${window.location.origin}/api/data/${projectId}`;
  };

  const isEjected = !!projectData?.metadata?.external_db_url;
  const hasReplica = !!projectData?.metadata?.read_replica_url;

  // Process data for Status Code Chart
  const statusData = stats?.throughput ? [
    { name: 'Success (2xx)', value: stats.throughput.reduce((acc:any, cur:any) => acc + (cur.success || 0), 0), color: '#10B981' },
    { name: 'Errors (4xx/5xx)', value: stats.throughput.reduce((acc:any, cur:any) => acc + (cur.error || 0), 0), color: '#F43F5E' }
  ] : [];

  return (
    <div className="p-8 lg:p-12 max-w-[1600px] mx-auto w-full space-y-12 pb-40">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-8">
        <div>
          <h1 className="text-5xl font-black text-slate-900 tracking-tighter">{projectData?.name || projectId}</h1>
          <div className="flex items-center gap-4 mt-3">
            <span className={`font-mono text-xs px-3 py-1.5 rounded-xl font-bold border uppercase tracking-widest flex items-center gap-2 ${isEjected ? 'bg-indigo-50 text-indigo-600 border-indigo-200' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
                {isEjected ? <Zap size={12}/> : <Server size={12}/>}
                {isEjected ? 'Ejected (External)' : 'Managed (Local)'}
            </span>
            <span className="flex items-center gap-1.5 text-emerald-600 font-black text-[10px] uppercase tracking-widest bg-emerald-50 px-3 py-1.5 rounded-xl border border-emerald-100">
              <CheckCircle2 size={14} /> System Healthy
            </span>
          </div>
        </div>

        <div className="flex items-center bg-slate-100 p-1.5 rounded-2xl shadow-sm">
          <button onClick={() => setActiveTab('overview')} className={`px-6 py-3 text-xs font-black rounded-xl transition-all flex items-center gap-2 ${activeTab === 'overview' ? 'bg-white shadow-xl text-indigo-600' : 'text-slate-500 hover:text-slate-700'}`}><Activity size={16}/> MONITOR</button>
          <button onClick={() => setActiveTab('intelligence')} className={`px-6 py-3 text-xs font-black rounded-xl transition-all flex items-center gap-2 ${activeTab === 'intelligence' ? 'bg-white shadow-xl text-indigo-600' : 'text-slate-500 hover:text-slate-700'}`}><Brain size={16}/> MCP & AI GOVERNANCE</button>
          <button onClick={() => setActiveTab('settings')} className={`px-6 py-3 text-xs font-black rounded-xl transition-all flex items-center gap-2 ${activeTab === 'settings' ? 'bg-white shadow-xl text-indigo-600' : 'text-slate-500 hover:text-slate-700'}`}><Settings2 size={16}/> SETTINGS</button>
        </div>
      </div>

      {activeTab === 'overview' && (
        <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <StatCard title="Data Entities" value={loading ? '...' : stats?.tables?.toString() || '0'} icon={<Database className="text-indigo-600" />} label="public schema" />
            <StatCard title="Auth Records" value={loading ? '...' : stats?.users?.toString() || '0'} icon={<Shield className="text-emerald-500" />} label="active users" />
            <StatCard title="Physical Volume" value={loading ? '...' : stats?.size || '0 MB'} icon={<Server className="text-blue-500" />} label="disk usage" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
            {/* MAIN CHART - Throughput */}
            <div className="lg:col-span-2 border border-slate-200 rounded-[3rem] p-8 bg-white/60 backdrop-blur-xl shadow-sm relative group overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-white via-white to-slate-50 opacity-50 z-0"></div>
              <div className="relative z-10 flex flex-col h-full">
                <div className="flex items-center justify-between mb-8">
                    <div>
                        <h3 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-3"><Activity size={24} className="text-indigo-600"/> Traffic Pulse</h3>
                        <p className="text-slate-400 text-xs font-medium mt-1">Live Requests / Hour (Last 24h)</p>
                    </div>
                </div>
                
                {stats?.throughput && stats.throughput.length > 0 ? (
                    <div className="h-[300px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={stats.throughput}>
                            <defs>
                            <linearGradient id="colorReq" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.2}/>
                                <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                            </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                            <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fontSize: 10, fill: '#94a3b8', fontWeight: 700}} minTickGap={30} />
                            <YAxis axisLine={false} tickLine={false} tick={{fontSize: 10, fill: '#94a3b8', fontWeight: 700}} />
                            <Tooltip 
                                contentStyle={{borderRadius: '16px', border: 'none', boxShadow: '0 10px 30px rgba(0,0,0,0.1)', padding: '12px', background: 'rgba(255,255,255,0.95)'}}
                                itemStyle={{fontSize: '12px', fontWeight: 'bold', color: '#1e293b'}}
                            />
                            <Area type="monotone" dataKey="requests" stroke="#6366f1" strokeWidth={3} fillOpacity={1} fill="url(#colorReq)" activeDot={{r: 6, strokeWidth: 0, fill: '#4f46e5'}} />
                        </AreaChart>
                        </ResponsiveContainer>
                    </div>
                ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-slate-300">
                         <Activity size={48} className="mb-4 opacity-20"/>
                         <span className="text-xs font-black uppercase tracking-widest">No traffic data yet</span>
                    </div>
                )}
              </div>
            </div>

            {/* SECONDARY CHART & INFO - Status & Manifest */}
            <div className="flex flex-col gap-8">
                {/* Health Status Chart */}
                <div className="flex-1 border border-slate-200 rounded-[2.5rem] p-8 bg-white/60 backdrop-blur-xl shadow-sm relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-bl from-white via-white to-emerald-50/30 opacity-50 z-0"></div>
                    <div className="relative z-10 h-full flex flex-col">
                         <div className="flex items-center justify-between mb-6">
                            <h3 className="text-lg font-black text-slate-900 flex items-center gap-2"><BarChart3 size={20} className="text-emerald-500"/> Health & Quality</h3>
                         </div>
                         {statusData.length > 0 && statusData.some((d:any) => d.value > 0) ? (
                             <div className="flex-1 min-h-[150px]">
                                <ResponsiveContainer width="100%" height="100%">
                                    <BarChart data={statusData} layout="vertical" barSize={20}>
                                        <XAxis type="number" hide />
                                        <YAxis dataKey="name" type="category" width={100} tick={{fontSize: 10, fill: '#64748b', fontWeight: 700}} axisLine={false} tickLine={false}/>
                                        <Tooltip cursor={{fill: 'transparent'}} contentStyle={{borderRadius: '12px', border: 'none', boxShadow: '0 5px 20px rgba(0,0,0,0.1)'}}/>
                                        <Bar dataKey="value" radius={[0, 10, 10, 0]}>
                                            {statusData.map((entry: any, index: number) => (
                                                <Cell key={`cell-${index}`} fill={entry.color} />
                                            ))}
                                        </Bar>
                                    </BarChart>
                                </ResponsiveContainer>
                             </div>
                         ) : (
                             <div className="flex-1 flex items-center justify-center text-xs text-slate-400 font-bold uppercase tracking-widest">No status data</div>
                         )}
                    </div>
                </div>

                {/* Manifest Mini Card */}
                <div className="border border-indigo-100 bg-gradient-to-br from-indigo-50 to-white rounded-[2.5rem] p-8 relative overflow-hidden group">
                     <div className="absolute top-0 right-0 p-6 opacity-5 group-hover:scale-110 transition-transform"><Globe size={100}/></div>
                     <div className="relative z-10">
                        <h3 className="text-lg font-black text-slate-900 mb-4 flex items-center gap-2"><Globe size={18} className="text-indigo-600"/> Endpoint</h3>
                        <div className="bg-white/80 border border-indigo-100 rounded-xl px-4 py-3 font-mono text-[10px] text-slate-600 truncate font-bold mb-6 shadow-sm">
                            {getBaseUrl()}
                        </div>
                        <button 
                            onClick={() => window.location.hash = `#/project/${projectId}/docs`}
                            className="w-full py-3 bg-slate-900 text-white rounded-xl shadow-lg flex items-center justify-center gap-2 group/btn hover:bg-indigo-600 transition-all text-xs font-black uppercase tracking-widest"
                        >
                            <BookOpen size={14} className="text-white/80"/> API Docs <ArrowRight size={14} className="-ml-1 opacity-0 group-hover/btn:opacity-100 group-hover/btn:translate-x-1 transition-all"/>
                        </button>
                     </div>
                </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'intelligence' && (
        <ProjectIntelligence projectId={projectId} />
      )}

      {activeTab === 'settings' && (
        <ProjectSettings projectId={projectId} />
      )}
    </div>
  );
};

const StatCard: React.FC<{ title: string, value: string, icon: React.ReactNode, label: string }> = ({ title, value, icon, label }) => (
  <div className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm hover:shadow-2xl hover:shadow-indigo-500/5 transition-all group relative overflow-hidden">
    <div className="absolute inset-0 bg-gradient-to-b from-white to-slate-50 opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
    <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:scale-125 transition-transform duration-500">{icon}</div>
    <div className="relative z-10">
        <div className="flex items-center justify-between mb-6">
        <div className="w-12 h-12 rounded-2xl bg-white border border-slate-100 flex items-center justify-center text-slate-400 group-hover:bg-indigo-600 group-hover:text-white transition-all duration-300 shadow-sm">
            {icon}
        </div>
        <span className="text-[9px] font-black text-slate-400 uppercase tracking-[0.2em]">{label}</span>
        </div>
        <div className="text-4xl font-black text-slate-900 mb-1 tracking-tighter">{value}</div>
        <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{title}</div>
    </div>
  </div>
);

export default ProjectDetail;
