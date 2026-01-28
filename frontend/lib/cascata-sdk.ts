/**
 * Cascata JavaScript SDK v2.1 (Universal)
 * 
 * Official Client for interacting with Cascata Backend as a Service.
 * Supports: Database (CRUD), Storage, RPC, Auth, and Realtime.
 * 
 * Usage:
 * import { createClient } from './cascata-sdk';
 * const cascata = createClient('https://api.myapp.com', 'anon_key');
 */

export interface CascataSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: {
      id: string;
      email?: string;
      app_metadata?: Record<string, any>;
      user_metadata?: Record<string, any>;
      [key: string]: any;
  };
}

export interface ClientConfig {
  /** Automatically refresh the token before it expires. Default: true */
  autoRefresh?: boolean;
  /** Persist the session in localStorage (Browser only). Default: true */
  persistSession?: boolean;
  /** Custom fetch implementation (e.g., node-fetch) */
  fetch?: any;
}

export class CascataClient {
  private url: string;
  private key: string;
  private session: CascataSession | null = null;
  private config: ClientConfig;
  private fetchImpl: any;

  constructor(url: string, key: string, config: ClientConfig = {}) {
    this.url = url.replace(/\/$/, '');
    this.key = key;
    this.config = { autoRefresh: true, persistSession: true, ...config };
    
    // Environment detection for fetch
    if (typeof window !== 'undefined') {
        this.fetchImpl = window.fetch.bind(window);
    } else {
        this.fetchImpl = config.fetch || global.fetch;
    }

    if (this.config.persistSession && typeof window !== 'undefined') {
      this.loadSession();
    }
  }

  private loadSession() {
    try {
      const key = `cascata_session_${this.getKeyHash()}`;
      const stored = localStorage.getItem(key);
      if (stored) {
        this.session = JSON.parse(stored);
      }
    } catch (e) { /* Storage access denied or invalid JSON */ }
  }

  private saveSession(session: CascataSession) {
    this.session = session;
    if (this.config.persistSession && typeof window !== 'undefined') {
      try {
          const key = `cascata_session_${this.getKeyHash()}`;
          localStorage.setItem(key, JSON.stringify(session));
      } catch (e) { console.warn('Cascata SDK: Failed to persist session'); }
    }
  }

  private getKeyHash(): string {
      // Simple hash to differentiate sessions between projects on localhost
      let hash = 0;
      for (let i = 0; i < this.key.length; i++) {
          hash = ((hash << 5) - hash) + this.key.charCodeAt(i);
          hash |= 0;
      }
      return hash.toString(36);
  }

  /**
   * Manually set the active session.
   */
  setSession(session: CascataSession) {
    this.saveSession(session);
    return this;
  }

  /**
   * Get the current active session.
   */
  getSession(): CascataSession | null {
      return this.session;
  }

  /**
   * Refresh the current session using the refresh_token.
   * Returns true if successful.
   */
  async refreshSession(): Promise<boolean> {
    if (!this.session?.refresh_token) return false;

    try {
      const res = await this.fetchImpl(`${this.url}/auth/v1/token`, {
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

  /**
   * Sign out the user and clear local storage.
   */
  async signOut() {
    if (this.session?.access_token) {
        try {
            await this.fetchImpl(`${this.url}/auth/v1/logout`, {
                method: 'POST',
                headers: { 
                    'apikey': this.key,
                    'Authorization': `Bearer ${this.session.access_token}`
                }
            });
        } catch(e) {}
    }

    this.session = null;
    if (this.config.persistSession && typeof window !== 'undefined') {
      localStorage.removeItem(`cascata_session_${this.getKeyHash()}`);
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

    try {
        const response = await this.fetchImpl(`${this.url}${path}`, { ...options, headers });
        
        // Auto-refresh token on 401 (Unauthorized)
        if (response.status === 401 && retry && this.config.autoRefresh && this.session?.refresh_token) {
          const refreshed = await this.refreshSession();
          if (refreshed) {
            return this.request(path, options, false);
          }
        }

        const contentType = response.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
            const data = await response.json();
            if (!response.ok) throw { status: response.status, ...data };
            return data;
        } else {
            if (!response.ok) throw { status: response.status, error: response.statusText };
            return response.text();
        }
    } catch (e: any) {
        throw e.error ? e : { error: e.message || 'Network Error' };
    }
  }

  /**
   * Query Builder for Database Tables.
   * @param table Name of the table
   */
  from(table: string) {
    return {
      select: async <T = any>(columns = '*', filters: Record<string, any> = {}): Promise<T[]> => {
        const query = new URLSearchParams({ select: columns, ...filters });
        return this.request(`/rest/v1/${table}?${query.toString()}`);
      },
      insert: async <T = any>(values: Partial<T> | Partial<T>[]): Promise<T[]> => {
        return this.request(`/rest/v1/${table}`, {
          method: 'POST',
          headers: { 'Prefer': 'return=representation' },
          body: JSON.stringify(values)
        });
      },
      update: async <T = any>(values: Partial<T>, match: Record<string, any>): Promise<T[]> => {
        const query = new URLSearchParams();
        Object.entries(match).forEach(([k, v]) => query.append(`${k}`, `eq.${v}`));
        return this.request(`/rest/v1/${table}?${query.toString()}`, {
          method: 'PATCH',
          headers: { 'Prefer': 'return=representation' },
          body: JSON.stringify(values)
        });
      },
      delete: async <T = any>(match: Record<string, any>): Promise<T[]> => {
        const query = new URLSearchParams();
        Object.entries(match).forEach(([k, v]) => query.append(`${k}`, `eq.${v}`));
        return this.request(`/rest/v1/${table}?${query.toString()}`, {
          method: 'DELETE',
          headers: { 'Prefer': 'return=representation' }
        });
      },
      /**
       * Subscribe to real-time changes on this table.
       * @param callback Function to execute on event
       */
      subscribe: (callback: (payload: { action: 'INSERT'|'UPDATE'|'DELETE', record: any }) => void) => {
        if (typeof EventSource === 'undefined') {
            console.warn('Cascata SDK: Realtime not supported in this environment (missing EventSource).');
            return () => {};
        }

        const queryParams = new URLSearchParams({
          apikey: this.key,
          table: table,
          ...(this.session?.access_token ? { token: this.session.access_token } : {})
        });
        
        const eventSource = new EventSource(`${this.url}/realtime?${queryParams.toString()}`);
        
        eventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'connected') return;
            callback(data);
          } catch (e) {
            console.error('[Cascata Realtime] Parse Error', e);
          }
        };

        return () => eventSource.close();
      }
    };
  }

  /**
   * Storage Manager
   * @param bucket Name of the storage bucket
   */
  storage(bucket: string) {
    return {
      upload: async (path: string, file: File | Blob) => {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('path', path);
        
        const headers: any = { 'apikey': this.key };
        if (this.session?.access_token) headers['Authorization'] = `Bearer ${this.session.access_token}`;

        // Uses fetch directly because we don't want Content-Type: application/json
        const res = await this.fetchImpl(`${this.url}/storage/${bucket}/upload`, {
          method: 'POST',
          headers,
          body: formData
        });
        
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || "Upload failed");
        }
        return res.json();
      },
      getPublicUrl: (path: string) => {
        return `${this.url}/storage/${bucket}/object/${path}?apikey=${this.key}`;
      },
      list: async (path = '') => {
          return this.request(`/storage/${bucket}/list?path=${encodeURIComponent(path)}`);
      },
      remove: async (paths: string[]) => {
          // Note: Bulk delete implementation depends on backend support, assuming loop for SDK safety
          // This is a simplified interface
           for (const p of paths) {
               await this.request(`/storage/${bucket}/object?path=${encodeURIComponent(p)}`, { method: 'DELETE' });
           }
           return true;
      }
    };
  }

  /**
   * Execute a Stored Procedure (RPC)
   */
  rpc(functionName: string, params: any = {}) {
    return this.request(`/rpc/${functionName}`, {
      method: 'POST',
      body: JSON.stringify(params)
    });
  }

  /**
   * Execute an Edge Function
   */
  edge(functionName: string, params: any = {}) {
    return this.request(`/edge/${functionName}`, {
      method: 'POST',
      body: JSON.stringify(params)
    });
  }

  /**
   * Vector Search (AI Memory)
   */
  vector() {
      return {
          search: (vector: number[], params: { limit?: number, filter?: any } = {}) => this.request('/vector/points/search', {
              method: 'POST',
              body: JSON.stringify({ vector, ...params })
          }),
          upsert: (points: Array<{ id: string | number, vector: number[], payload?: any }>) => this.request('/vector/points', {
              method: 'PUT',
              body: JSON.stringify({ points })
          }),
          delete: (ids: (string | number)[]) => this.request('/vector/points/delete', {
              method: 'POST',
              body: JSON.stringify({ points: ids })
          })
      };
  }
}

/**
 * Factory function to initialize the client.
 */
export const createClient = (url: string, key: string, config?: ClientConfig) => new CascataClient(url, key, config);
