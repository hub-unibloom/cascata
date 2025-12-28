
import React, { useState, useEffect } from 'react';
import { Shield, Key, Database, Activity, CheckCircle2, Loader2, Server, Settings2, Globe, Lock, Workflow, ExternalLink, Power, ArrowRight, BookOpen } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import ProjectSettings from './ProjectSettings';

const mockChartData = [
  { name: '00:00', requests: 400 }, { name: '08:00', requests: 900 },
  { name: '12:00', requests: 1200 }, { name: '16:00', requests: 1500 },
  { name: '23:59', requests: 600 }
];

const ProjectDetail: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'settings'>('overview');
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [projectData, setProjectData] = useState<any>(null);

  const fetchProjectData = async () => {
    try {
      // Fetch stats
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

  return (
    <div className="p-8 lg:p-12 max-w-7xl mx-auto w-full space-y-12 pb-40">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-8">
        <div>
          <h1 className="text-5xl font-black text-slate-900 tracking-tighter">{projectId} Instance</h1>
          <div className="flex items-center gap-4 mt-3">
            <span className="font-mono text-xs bg-slate-100 text-slate-500 px-3 py-1.5 rounded-xl font-bold border border-slate-200 uppercase tracking-widest">Isolated Host</span>
            <span className="flex items-center gap-1.5 text-emerald-600 font-black text-[10px] uppercase tracking-widest bg-emerald-50 px-3 py-1.5 rounded-xl border border-emerald-100">
              <CheckCircle2 size={14} /> System Healthy
            </span>
          </div>
        </div>

        <div className="flex items-center bg-slate-100 p-1.5 rounded-2xl">
          <button onClick={() => setActiveTab('overview')} className={`px-6 py-3 text-xs font-black rounded-xl transition-all flex items-center gap-2 ${activeTab === 'overview' ? 'bg-white shadow-xl text-indigo-600' : 'text-slate-500'}`}><Activity size={16}/> MONITOR</button>
          <button onClick={() => setActiveTab('settings')} className={`px-6 py-3 text-xs font-black rounded-xl transition-all flex items-center gap-2 ${activeTab === 'settings' ? 'bg-white shadow-xl text-indigo-600' : 'text-slate-500'}`}><Settings2 size={16}/> SETTINGS</button>
        </div>
      </div>

      {activeTab === 'overview' && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <StatCard title="Data Entities" value={loading ? '...' : stats?.tables?.toString() || '0'} icon={<Database className="text-indigo-600" />} label="public" />
            <StatCard title="Auth Records" value={loading ? '...' : stats?.users?.toString() || '0'} icon={<Shield className="text-emerald-500" />} label="auth" />
            <StatCard title="Physical Volume" value={loading ? '...' : stats?.size || '0 MB'} icon={<Server className="text-blue-500" />} label="disk_usage" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
            <div className="lg:col-span-2 border border-slate-200 rounded-[3rem] p-10 bg-white shadow-sm overflow-hidden relative group">
              <div className="flex items-center justify-between mb-10">
                <h3 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-3"><Activity size={24} className="text-indigo-600"/> Real-time Throughput</h3>
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Last 24 Hours</span>
              </div>
              <div className="h-[350px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={mockChartData}>
                    <defs>
                      <linearGradient id="colorReq" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.15}/>
                        <stop offset="95%" stopColor="#4f46e5" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fontSize: 10, fill: '#94a3b8', fontWeight: 700}} />
                    <YAxis axisLine={false} tickLine={false} tick={{fontSize: 10, fill: '#94a3b8', fontWeight: 700}} />
                    <Tooltip contentStyle={{borderRadius: '20px', border: 'none', boxShadow: '0 20px 40px rgba(0,0,0,0.1)', padding: '15px'}} />
                    <Area type="monotone" dataKey="requests" stroke="#4f46e5" fillOpacity={1} fill="url(#colorReq)" strokeWidth={4} dot={{r: 4, strokeWidth: 2, fill: '#fff'}} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="border border-slate-200 rounded-[3rem] p-10 bg-white shadow-sm space-y-10 flex flex-col group">
              <h3 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-3"><Globe size={24} className="text-indigo-600"/> Infrastructure Manifest</h3>
              <div className="space-y-6 flex-1">
                <ConfigItem label="API Endpoint" value={`${window.location.origin}/api/data/${projectId}`} />
                <ConfigItem label="Database ID" value={`cascata_proj_${projectId.replace(/-/g, '_')}`} />
                <ConfigItem label="Auth Protocol" value="JWT physical isolation" />
              </div>
              
              <button 
                onClick={() => window.location.hash = `#/project/${projectId}/docs`}
                className="p-6 bg-slate-900 text-white rounded-[2rem] shadow-2xl flex items-center justify-between group/btn hover:bg-indigo-600 transition-all"
              >
                <div className="flex items-center gap-3">
                    <BookOpen size={20} className="text-white/80"/>
                    <span className="text-xs font-black uppercase tracking-widest">API Documentation</span>
                </div>
                <ArrowRight size={16} className="opacity-0 group-hover/btn:opacity-100 transition-opacity -translate-x-2 group-hover/btn:translate-x-0"/>
              </button>
            </div>
          </div>
        </>
      )}

      {activeTab === 'settings' && (
        <ProjectSettings projectId={projectId} />
      )}
    </div>
  );
};

const StatCard: React.FC<{ title: string, value: string, icon: React.ReactNode, label: string }> = ({ title, value, icon, label }) => (
  <div className="bg-white border border-slate-200 rounded-[2.5rem] p-10 shadow-sm hover:shadow-2xl hover:shadow-indigo-500/5 transition-all group relative overflow-hidden">
    <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:scale-125 transition-transform duration-500">{icon}</div>
    <div className="flex items-center justify-between mb-6">
      <div className="w-14 h-14 rounded-2xl bg-slate-50 flex items-center justify-center text-slate-400 group-hover:bg-indigo-600 group-hover:text-white transition-all duration-300 border border-slate-100 shadow-inner">
        {icon}
      </div>
      <span className="text-[10px] font-black text-slate-300 uppercase tracking-[0.2em]">{label}</span>
    </div>
    <div className="text-5xl font-black text-slate-900 mb-2 tracking-tighter">{value}</div>
    <div className="text-[11px] font-black text-slate-400 uppercase tracking-widest">{title}</div>
  </div>
);

const ConfigItem: React.FC<{ label: string, value: string }> = ({ label, value }) => (
  <div className="space-y-2">
    <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-1">{label}</span>
    <div className="bg-white border border-slate-200 rounded-2xl px-5 py-3.5 font-mono text-xs text-slate-600 truncate font-bold shadow-sm">
      {value}
    </div>
  </div>
);

export default ProjectDetail;
