/**
 * Cascata Core SDK v2.0 (Production Master)
 * Client robusto com Auto-Refresh, Retry Logic e Realtime Nativo.
 */

interface CascataSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: any;
}

interface ClientConfig {
  autoRefresh?: boolean;
  persistSession?: boolean;
}

export class CascataClient {
  private url: string;
  private key: string;
  private session: CascataSession | null = null;
  private config: ClientConfig;

  constructor(url: string, key: string, config: ClientConfig = { autoRefresh: true, persistSession: true }) {
    this.url = url.replace(/\/$/, '');
    this.key = key;
    this.config = config;

    if (this.config.persistSession && typeof window !== 'undefined') {
      this.loadSession();
    }
  }

  private loadSession() {
    try {
      const stored = localStorage.getItem(`cascata_session_${this.key}`);
      if (stored) {
        this.session = JSON.parse(stored);
      }
    } catch (e) { /* ignore */ }
  }

  private saveSession(session: CascataSession) {
    this.session = session;
    if (this.config.persistSession && typeof window !== 'undefined') {
      localStorage.setItem(`cascata_session_${this.key}`, JSON.stringify(session));
    }
  }

  setSession(session: CascataSession) {
    this.saveSession(session);
    return this;
  }

  async refreshSession(): Promise<boolean> {
    if (!this.session?.refresh_token) return false;

    try {
      const res = await fetch(`${this.url}/auth/v1/token`, {
        method: 'POST',
        headers: { 
          'apikey': this.key,
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ 
            grant_type: 'refresh_token',
            refresh_token: this.session.refresh_token 
        })
      });

      if (!res.ok) {
        this.signOut(); 
        return false;
      }

      const newSession = await res.json();
      this.saveSession(newSession);
      return true;
    } catch (e) {
      return false;
    }
  }

  async signOut() {
    this.session = null;
    if (this.config.persistSession && typeof window !== 'undefined') {
      localStorage.removeItem(`cascata_session_${this.key}`);
    }
  }

  private async request(path: string, options: RequestInit = {}, retry = true): Promise<any> {
    const headers: any = {
      'apikey': this.key,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };

    if (this.session?.access_token) {
      headers['Authorization'] = `Bearer ${this.session.access_token}`;
    }

    const response = await fetch(`${this.url}${path}`, { ...options, headers });
    
    // Auto-refresh token on 401
    if (response.status === 401 && retry && this.config.autoRefresh && this.session?.refresh_token) {
      const refreshed = await this.refreshSession();
      if (refreshed) {
        return this.request(path, options, false);
      }
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Connection failure' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  from(table: string) {
    return {
      select: async (columns = '*') => {
        return this.request(`/rest/v1/${table}?select=${columns}`);
      },
      insert: async (values: any | any[]) => {
        return this.request(`/rest/v1/${table}`, {
          method: 'POST',
          headers: { 'Prefer': 'return=representation' },
          body: JSON.stringify(values)
        });
      },
      update: async (values: any, match: { col: string, val: any }) => {
        return this.request(`/rest/v1/${table}?${match.col}=eq.${match.val}`, {
          method: 'PATCH',
          headers: { 'Prefer': 'return=representation' },
          body: JSON.stringify(values)
        });
      },
      delete: async (match: { col: string, val: any }) => {
        return this.request(`/rest/v1/${table}?${match.col}=eq.${match.val}`, {
          method: 'DELETE'
        });
      },
      subscribe: (callback: (payload: any) => void) => {
        const queryParams = new URLSearchParams({
          apikey: this.key,
          table: table,
          ...(this.session?.access_token ? { token: this.session.access_token } : {})
        });
        
        const eventSource = new EventSource(`${this.url}/realtime?${queryParams.toString()}`);
        
        eventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            callback(data);
          } catch (e) {
            console.error('[Cascata SDK] Realtime Parse Error', e);
          }
        };

        return () => eventSource.close();
      }
    };
  }

  storage(bucket: string) {
    return {
      upload: async (path: string, file: File) => {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('path', path);
        
        const headers: any = { 'apikey': this.key };
        if (this.session?.access_token) headers['Authorization'] = `Bearer ${this.session.access_token}`;

        const res = await fetch(`${this.url}/storage/${bucket}/upload`, {
          method: 'POST',
          headers,
          body: formData
        });
        
        if (!res.ok) throw new Error("Upload failed");
        return res.json();
      },
      getPublicUrl: (path: string) => {
        return `${this.url}/storage/${bucket}/object/${path}?apikey=${this.key}`;
      }
    };
  }

  rpc(functionName: string, params: any = {}) {
    return this.request(`/rpc/${functionName}`, {
      method: 'POST',
      body: JSON.stringify(params)
    });
  }

  // Acesso direto ao Vector Proxy para o projeto "memory"
  vector() {
      return {
          search: (vector: number[], params: any = {}) => this.request('/vector/points/search', {
              method: 'POST',
              body: JSON.stringify({ vector, ...params })
          }),
          upsert: (points: any[]) => this.request('/vector/points', {
              method: 'PUT',
              body: JSON.stringify({ points })
          }),
          delete: (ids: string[]) => this.request('/vector/points/delete', {
              method: 'POST',
              body: JSON.stringify({ points: ids })
          })
      };
  }
}

export const createClient = (url: string, key: string) => new CascataClient(url, key);