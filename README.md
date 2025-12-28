
# Cascata - Production BaaS

Cascata is a high-performance, self-hosted multi-tenant Backend-as-a-Service platform. It is designed as a direct, robust alternative to Supabase self-hosted, focusing on strict project isolation and clean enterprise architecture.

## Architecture

- **Control Plane**: Manages project lifecycles, global settings, and admin authentication.
- **Data Plane**: Per-project API surface with automatic REST/RPC generation and RLS enforcement.
- **Isolation**: Each project uses a dedicated connection pool and unique JWT secrets.

## Deployment Instructions

1. **Prerequisites**: Ubuntu 22.04+ with Docker and Docker Compose installed.
2. **Rename Files**:
   ```bash
   mv Dockerfile.txt Dockerfile
   mv .env.txt .env
   mv nginx.conf.txt nginx.conf
   mv database/init.sql.txt database/init.sql
   ```
3. **Configure**: Update `.env` with your system secrets and database credentials.
4. **Launch**:
   ```bash
   docker-compose up -d --build
   ```
5. **Access**:
   - Management Studio: `http://localhost` (or your configured domain)
   - Control API: `http://localhost/api/control`
   - Data API: `http://localhost/api/data/{project_id}`

## Security

- Row-Level Security (RLS) is recommended on all user tables.
- JWT secrets are unique per project and are not shared with the Control Plane.
- All database connections use parameterized queries to prevent SQL injection.

---
© 2024 Cascata. Production-Grade Backend Orchestration.
