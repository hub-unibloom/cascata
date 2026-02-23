
import React, { useState, useEffect, useRef } from 'react';
import { Layers, ArrowRight, Lock, Mail, AlertCircle, Loader2 } from 'lucide-react';

interface LoginProps {
  onLoginSuccess: () => void;
}

const Login: React.FC<LoginProps> = ({ onLoginSuccess }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  
  // Interactive Background State
  const containerRef = useRef<HTMLDivElement>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (containerRef.current) {
        // Calculate normalized mouse position (-1 to 1)
        const { clientWidth, clientHeight } = containerRef.current;
        const x = (e.clientX / clientWidth - 0.5) * 30; // 30px movement range
        const y = (e.clientY / clientHeight - 0.5) * 30;
        setMousePos({ x, y });
      }
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await fetch('/api/control/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      // Handle Nginx 404 HTML responses gracefully
      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        if (response.status === 404) {
          throw new Error("System API unreachable (404). Check backend services.");
        }
        throw new Error("Unexpected server response.");
      }

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Authentication failed');
      }

      // Security Note: In a future iteration, we will move to httpOnly cookies.
      // For now, we store in localStorage to maintain compatibility with existing pages.
      localStorage.setItem('cascata_token', data.token);
      onLoginSuccess();
      window.location.hash = '#/projects';
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div 
        ref={containerRef}
        className="min-h-screen bg-slate-950 flex items-center justify-center p-6 relative overflow-hidden"
    >
      {/* Interactive Background Gradient Layers */}
      <div 
        className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-indigo-600/20 rounded-full blur-[120px] transition-transform duration-150 ease-out will-change-transform"
        style={{ transform: `translate(${mousePos.x}px, ${mousePos.y}px)` }}
      ></div>
      <div 
        className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-purple-600/10 rounded-full blur-[120px] transition-transform duration-150 ease-out will-change-transform"
        style={{ transform: `translate(${-mousePos.x}px, ${-mousePos.y}px)` }}
      ></div>

      <div className="w-full max-w-md relative z-10 animate-in fade-in zoom-in-95 duration-500">
        <div className="flex justify-center mb-8">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-2xl shadow-indigo-500/40">
              <Layers className="text-white w-7 h-7" />
            </div>
            <span className="text-3xl font-black text-white tracking-tighter">Cascata</span>
          </div>
        </div>

        <div className="bg-slate-900/50 backdrop-blur-xl border border-slate-800 p-8 rounded-[2.5rem] shadow-2xl transition-all hover:shadow-indigo-500/10">
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-white mb-2">Control Plane</h1>
            <p className="text-slate-400 text-sm">Secure Infrastructure Management</p>
          </div>

          {error && (
            <div className="mb-6 p-4 bg-rose-500/10 border border-rose-500/20 rounded-2xl flex items-center gap-3 text-rose-500 text-sm animate-pulse">
              <AlertCircle size={18} className="shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest ml-1" htmlFor="email">Administrator Email</label>
              <div className="relative">
                <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" size={18} />
                <input 
                  id="email"
                  name="email"
                  type="email" 
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@cascata.io"
                  autoComplete="username" // Fix for autocomplete warning
                  className="w-full bg-slate-800/50 border border-slate-700 rounded-2xl py-3.5 pl-12 pr-4 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition-all placeholder:text-slate-600"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest ml-1" htmlFor="password">Security Credentials</label>
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" size={18} />
                <input 
                  id="password"
                  name="password"
                  type="password" 
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password" // Fix for autocomplete warning
                  className="w-full bg-slate-800/50 border border-slate-700 rounded-2xl py-3.5 pl-12 pr-4 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition-all placeholder:text-slate-600"
                  required
                />
              </div>
            </div>

            <button 
              type="submit"
              disabled={loading}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-bold py-4 rounded-2xl shadow-xl shadow-indigo-600/20 transition-all flex items-center justify-center gap-2 group active:scale-95"
            >
              {loading ? (
                <>
                  <Loader2 className="animate-spin" size={20} />
                  <span>Verifying...</span>
                </>
              ) : (
                <>
                  <span>Access Dashboard</span>
                  <ArrowRight size={18} className="group-hover:translate-x-1 transition-transform" />
                </>
              )}
            </button>
          </form>

          <div className="mt-8 pt-6 border-t border-slate-800 text-center">
            <p className="text-slate-500 text-[10px] font-bold uppercase tracking-widest">
              Cascata Engine v1.1 • Secure Enclave
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Login;
