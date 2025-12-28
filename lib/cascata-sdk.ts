
/**
 * Cascata Core SDK v1.1
 * Zero-dependency client for the Cascata BaaS platform.
 */
export class CascataClient {
  private url: string;
  private key: string;
  private token?: string;

  constructor(url: string, key: string) {
    this.url = url.replace(/\/$/, '');
    this.key = key;
  }

  setAuth(token: string) {
    this.token = token;
    return this;
  }

  private async request(path: string, options: RequestInit = {}) {
    const headers = {
      'apikey': this.key,
      'Content-Type': 'application/json',
      ...(this.token ? { 'Authorization': `Bearer ${this.token}` } : {}),
      ...(options.headers || {})
    };

    const response = await fetch(`${this.url}${path}`, { ...options, headers });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown connection error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

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
      // Realtime Subscription (Native SSE)
      subscribe: (callback: (payload: any) => void) => {
        const queryParams = new URLSearchParams({
          apikey: this.key,
          table: table,
          ...(this.token ? { token: this.token } : {})
        });
        
        const eventSource = new EventSource(`${this.url}/realtime?${queryParams.toString()}`);
        
        eventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            callback(data);
          } catch (e) {
            console.error('Cascata Realtime Parse Error', e);
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
        if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

        const res = await fetch(`${this.url}/storage/${bucket}/upload`, {
          method: 'POST',
          headers,
          body: formData
        });
        return res.json();
      },
      getPublicUrl: (path: string) => {
        return `${this.url}/storage/${bucket}/object/${path}?apikey=${this.key}`;
      }
    };
  }
}

export const createClient = (url: string, key: string) => new CascataClient(url, key);
