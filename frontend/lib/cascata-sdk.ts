
/**
 * Cascata Core SDK v2.0 (Production)
 * robust client with Auto-Refresh, Retry Logic, and Type Safety.
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

  /**
   * Manually set the auth session (e.g. after login)
   */
  setSession(session: CascataSession) {
    this.saveSession(session);
    return this;
  }

  /**
   * Attempt to refresh the session using the stored refresh token
   */
  async refreshSession(): Promise<boolean> {
    if (!this.session?.refresh_token) return false;

    try {
      const res = await fetch(`${this.url}/auth/token/refresh`, {
        method: 'POST',
        headers: { 
          'apikey': this.key,
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ refresh_token: this.session.refresh_token })
      });

      if (!res.ok) {
        this.signOut(); // Refresh failed (expired/revoked), force logout
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
    
    // Handle 401 (Unauthorized) with Auto-Refresh
    if (response.status === 401 && retry && this.config.autoRefresh && this.session?.refresh_token) {
      const refreshed = await this.refreshSession();
      if (refreshed) {
        // Retry the original request with new token
        return this.request(path, options, false);
      }
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown connection error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  // --- DATA METHODS ---

  from(table: string) {
    return {
      select: async (columns = '*') => {
        return this.request(`/tables/${table}/data?select=${columns}`);
      },
      insert: async (values: any | any[]) => {
        return this.request(`/tables/${table}/rows`, {
          method: 'POST',
          body: JSON.stringify({ data: values })
        });
      },
      update: async (values: any, match: { col: string, val: any }) => {
        return this.request(`/tables/${table}/rows`, {
          method: 'PUT',
          body: JSON.stringify({ data: values, pkColumn: match.col, pkValue: match.val })
        });
      },
      delete: async (match: { col: string, val: any }) => {
        return this.request(`/tables/${table}/rows`, {
          method: 'DELETE',
          body: JSON.stringify({ ids: [match.val], pkColumn: match.col })
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
        
        // Custom fetch for multipart (no Content-Type header)
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
}

export const createClient = (url: string, key: string) => new CascataClient(url, key);
