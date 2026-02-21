export interface Project {
  id: string;
  name: string;
  slug: string;
  status: 'healthy' | 'degraded' | 'error';
  database_url: string;
  api_url: string;
  created_at: string;
  jwt_secret: string;
  custom_domain?: string;
  ssl_certificate_source?: string;
  anon_key?: string;
  service_key?: string;
  metadata?: {
    db_config?: {
      max_connections?: number;
      idle_timeout_seconds?: number;
      statement_timeout_ms?: number;
    };
    // BYOD / Ejection Fields
    external_db_url?: string;
    read_replica_url?: string;
    // Security
    allowed_origins?: Array<string | { url: string; require_auth: boolean }>;
    auth_config?: any;
    auth_strategies?: any;
    security?: any;
    // UI
    ui_settings?: any;
    schema_exposure?: boolean;
    // Secrets
    secrets?: Record<string, string>;
    linked_tables?: string[];
    // Storage
    storage_governance?: any;
    storage_config?: any;
    [key: string]: any;
  };
}

export interface Table {
  name: string;
  schema: string;
  columns: Column[];
  rowCount: number;
}

export interface Column {
  name: string;
  type: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  defaultValue?: string;
}

export interface RPC {
  name: string;
  args: Array<{ name: string; type: string }>;
  returnType: string;
  definition: string;
}

export interface Policy {
  id: string;
  name: string;
  table: string;
  action: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL';
  check: string;
  roles: string[];
}