import { Request } from 'express';
import pg from 'pg';
import { IncomingHttpHeaders } from 'http';
import { Socket } from 'net';

/**
 * SOVEREIGN ENTITY: Authentication Policy
 * Defines granular security laws for the orchestrator.
 */
export interface AuthPolicy {
  id: string;
  name: string;
  priority: number;
  provider: string; // '*' or specific like 'email', 'google'
  origin: string;   // '*' or specific hostname
  require_password: boolean;
  require_otp: boolean;
  require_user_mfa_choice: boolean;
  auto_login: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * SOVEREIGN ENTITY: App Client
 * Identity-Aware Key bridging for external applications.
 */
export interface AppClientConfig {
  id: string;
  name: string;
  anon_key: string;
  site_url?: string;
  allowed_origins?: string[];
}

/**
 * SOVEREIGN ENTITY: Project Metadata
 * The heart of the tenant's configuration.
 */
export interface ProjectMetadata {
  allowed_origins?: string[];
  external_db_url?: string;
  read_replica_url?: string;
  db_config?: {
    max_connections?: number;
    idle_timeout_seconds?: number;
  };
  auth_strategies?: Record<string, any>; // Dynamic providers like Social, CPF, etc.
  auth_config?: {
    site_url?: string;
    security?: {
      max_attempts?: number;
      lockout_minutes?: number;
      strategy?: 'ip' | 'identifier' | 'hybrid';
      disabled?: boolean;
    };
    providers?: Record<string, any>;
    email_templates?: any;
    messaging_templates?: any;
  };
  app_clients?: AppClientConfig[];
  schema_discovery_enabled?: boolean;
}

/**
 * SOVEREIGN ENTITY: Decoded User
 * Derived from JWT claims.
 */
export interface CascataUser {
  sub: string;
  role: string;
  aud: string;
  email?: string;
  identifier?: string;
  provider?: string;
  app_metadata?: {
    provider?: string;
    role?: string;
  };
  user_metadata?: Record<string, any>;
}

export interface CascataProject {
  id: string;
  name: string;
  slug: string;
  db_name: string;
  custom_domain?: string;
  status: string;
  jwt_secret: string;
  anon_key: string;
  service_key: string;
  metadata: ProjectMetadata;
  config?: any;
  blocklist?: string[];
}

/**
 * CORE INTERFACE: CascataRequest
 * Strongly typed replacement for the generic Express Request.
 */
export interface CascataRequest extends Request {
  // Enforced typing for core Cascata properties
  project: CascataProject;
  projectPool: pg.Pool;
  user?: CascataUser;
  userRole: 'service_role' | 'authenticated' | 'anon';
  appClient?: AppClientConfig;
  isSystemRequest: boolean;

  // Middleware utilities
  file?: any;
  files?: any;

  // Express override (with stronger enforcement)
  body: any; // Body often varies, but 'any' is still risky here (consider Zod)
  params: Record<string, string>;
  query: Record<string, any>;
  headers: IncomingHttpHeaders;
}