
import React, { useState, useEffect, useRef } from 'react';
import { Layers, ArrowRight, Lock, Mail, AlertCircle, Loader2 } from 'lucide-react';

interface LoginProps {
  onLoginSuccess: () => void;
}

const Login: React.FC<LoginProps> = ({ onLoginSuccess }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [otpRequired, setOtpRequired] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [secureMode, setSecureMode] = useState<boolean | null>(null); // null = checking
  
  // Interactive Background State
  const containerRef = useRef<HTMLDivElement>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (containerRef.current) {
        const { clientWidth, clientHeight } = containerRef.current;
        const x = (e.clientX / clientWidth - 0.5) * 30;
        const y = (e.clientY / clientHeight - 0.5) * 30;
        setMousePos({ x, y });
      }
    };
    window.addEventListener('mousemove', handleMouseMove);

    // Pré-verificar se o backend suporta handshake seguro (não bloqueante)
    fetch('/api/control/auth/handshake', { method: 'GET' })
      .then(r => setSecureMode(r.ok && typeof window.crypto?.subtle !== 'undefined'))
      .catch(() => setSecureMode(false));

    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      let token: string | null = null;

      // ── MODO SEGURO: Criptografia de Payload ECDH X25519 + AES-256-GCM ──────
      if (secureMode !== false) {
        try {
          const { secureLogin } = await import('../lib/PayloadCrypto');

          // secureLogin() abstrai todo o handshake, cifração e decifração
          // OTP é tratado como segunda etapa (após primeiro submit falhar com otp_required)
          const result = await secureLogin('/api/control', email, password);
          token = result.token;

        } catch (secureErr: any) {
          // OTP obrigatório — mostrar campo e aguardar novo submit
          if (secureErr?.otp_required || String(secureErr?.message).includes('OTP')) {
            setOtpRequired(true);
            setLoading(false);
            return;
          }
          // Fallback: se handshake não disponível, tenta texto puro
          if (!String(secureErr?.message).toLowerCase().includes('handshake')) {
            throw secureErr;
          }
          console.warn('[Login] Handshake unavailable, falling back to plain login.');
        }
      }

      // ── FALLBACK: Login em texto puro (legado / handshake indisponível) ──────
      if (!token) {
        const body: Record<string, string> = { email, password };
        if (otpRequired && otpCode) body.otp_code = otpCode;

        const response = await fetch('/api/control/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        const contentType = response.headers.get('content-type');
        if (!contentType?.includes('application/json')) {
          throw new Error(response.status === 404
            ? 'System API unreachable (404). Check backend services.'
            : 'Unexpected server response.'
          );
        }

        const data = await response.json();

        if (!response.ok) {
          if (data.otp_required) {
            setOtpRequired(true);
            setLoading(false);
            return;
          }
          throw new Error(data.error || 'Authentication failed');
        }

        token = data.token;
      }

      if (!token) throw new Error('No token received from server.');

      localStorage.setItem('cascata_token', token);
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
            <p className="text-slate-400 text-sm flex items-center gap-2">
              Secure Infrastructure Management
              {/* Indicador de modo de segurança */}
              {secureMode === true && (
                <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded-full border border-emerald-400/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" />
                  E2E Encrypted
                </span>
              )}
              {secureMode === false && (
                <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded-full border border-amber-400/20">
                  Standard Mode
                </span>
              )}
            </p>
          </div>

          {error && (
            <div className="mb-6 p-4 bg-rose-500/10 border border-rose-500/20 rounded-2xl flex items-center gap-3 text-rose-500 text-sm animate-in slide-in-from-top-2">
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
                  autoComplete="username"
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
                  autoComplete="current-password"
                  className="w-full bg-slate-800/50 border border-slate-700 rounded-2xl py-3.5 pl-12 pr-4 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition-all placeholder:text-slate-600"
                  required
                />
              </div>
            </div>

            {/* Campo OTP — aparece dinamicamente se o backend sinalizar otp_required */}
            {otpRequired && (
              <div className="space-y-2 animate-in slide-in-from-bottom-2 duration-300">
                <label className="text-[10px] font-bold text-amber-400 uppercase tracking-widest ml-1 flex items-center gap-2" htmlFor="otp_code">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse inline-block" />
                  Two-Factor Authentication Required
                </label>
                <input
                  id="otp_code"
                  name="otp_code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  autoComplete="one-time-code"
                  className="w-full bg-amber-950/20 border border-amber-500/30 rounded-2xl py-3.5 px-4 text-white text-center text-2xl font-mono tracking-[0.3em] focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500 transition-all placeholder:text-slate-600 placeholder:text-base placeholder:tracking-normal"
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                  required
                />
                <p className="text-[10px] text-slate-500 text-center">
                  Enter the 6-digit code from your authenticator app
                </p>
              </div>
            )}

            <button 
              type="submit"
              disabled={loading}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-bold py-4 rounded-2xl shadow-xl shadow-indigo-600/20 transition-all flex items-center justify-center gap-2 group active:scale-95"
            >
              {loading ? (
                <>
                  <Loader2 className="animate-spin" size={20} />
                  <span>{secureMode ? 'Encrypting & Verifying...' : 'Verifying...'}</span>
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
              Cascata Engine v1.2 • {secureMode ? 'E2E Encrypted Secure Enclave' : 'Secure Enclave'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Login;
