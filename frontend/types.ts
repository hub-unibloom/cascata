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
  metadata?: any;
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