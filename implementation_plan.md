# 🔐 Plano de Implementação Supremo — Cascata Crypto Engine (Go)

> **Classificação**: Enterprise Production Grade  
> **Lei 3**: Zero Regression — Avançamos sem quebrar  
> **Lei 4**: Sem MVP — Direto ao Production Grade  
> **Premissa**: Não há projetos no ar. Código limpo, sem abstração de compatibilidade.  
> **Versão**: 1.0.0.0  
> **Data**: 28/03/2026

---

## Sumário Executivo

Este documento é o guia supremo para a implementação do **Cascata Crypto Engine (CCE)** — um microsserviço Go binário que assume **toda a responsabilidade criptográfica** do sistema Cascata. Ele substitui completamente:

1. O `pgp_sym_encrypt()` / `pgp_sym_decrypt()` do PostgreSQL (30+ queries SQL)
2. O `VaultService.ts` (client HTTP para HashiCorp Vault — inativo mas presente)
3. O uso direto de `SYS_SECRET` como chave de criptografia

> [!IMPORTANT]
> **Não há dados legados.** Não precisamos de scripts de migração, prefixos de versão (`cse:v1:`), ou dupla leitura. O sistema será implantado limpo em VPS nova a cada teste.

---

## Inventário Completo — O Que Existe Hoje

### Estado Atual da Criptografia

O sistema atual usa **PGP Simétrico via SQL** (`pgcrypto` extension) com `SYSTEM_JWT_SECRET` como chave:

| Padrão Atual | Problema |
|---|---|
| `pgp_sym_encrypt($valor, $SYS_SECRET)` no INSERT | A chave viaja do Node.js até o Postgres em texto puro na query |
| `pgp_sym_decrypt(coluna::bytea, $SYS_SECRET)` no SELECT | A chave aparece em logs de slow-query, pg_stat_statements |
| SYS_SECRET = `SYSTEM_JWT_SECRET` do `.env` | A mesma chave serve para JWT e criptografia — violação de responsabilidade |
| `VaultService.ts` existe mas não é usado | Código morto que referencia HashiCorp Vault inexistente |

### Mapa Completo de Arquivos Afetados (30+ Pontos de Crypto)

| # | Arquivo | Funções com Crypto | Tipo de Operação |
|---|---|---|---|
| 1 | [AdminController.ts](file:///home/cocorico/Documentos/proejetos/cascata/backend/src/controllers/AdminController.ts) | `listProjects` (L271), `createProject` (L297), `recoverProject` (L353), `revealKey` (L538), `rotateKeys` (L545), `exportProject` (L563), `createWebhook` (L703), `testWebhook` (L771) | encrypt + decrypt |
| 2 | [SecretsController.ts](file:///home/cocorico/Documentos/proejetos/cascata/backend/src/controllers/SecretsController.ts) | `create` (L48), `reveal` (L77) | encrypt + decrypt |
| 3 | [EdgeController.ts](file:///home/cocorico/Documentos/proejetos/cascata/backend/src/controllers/EdgeController.ts) | `execute` (L16-20) | decrypt |
| 4 | [WebhookController.ts](file:///home/cocorico/Documentos/proejetos/cascata/backend/src/controllers/WebhookController.ts) | `handleIncoming` (L76-81) | decrypt (pg_sym_decrypt) |
| 5 | [BackupController.ts](file:///home/cocorico/Documentos/proejetos/cascata/backend/src/controllers/BackupController.ts) | `listPolicies` (L46), `createPolicy` (L79), `updatePolicy` (L110), `getDownloadLink` (L182), `restoreBackup` (L220) | encrypt + decrypt |
| 6 | [core.ts (middleware)](file:///home/cocorico/Documentos/proejetos/cascata/backend/src/middlewares/core.ts) | `resolveProject` (L138-140) | decrypt |
| 7 | [RateLimitService.ts](file:///home/cocorico/Documentos/proejetos/cascata/backend/services/RateLimitService.ts) | `warmupCache` fallback (L367-374) | decrypt |
| 8 | [BackupService.ts](file:///home/cocorico/Documentos/proejetos/cascata/backend/services/BackupService.ts) | `executePolicyJob` (L189-195) | decrypt |
| 9 | [AutomationService.ts](file:///home/cocorico/Documentos/proejetos/cascata/backend/services/AutomationService.ts) | `resolveVaultSecret` (L769) | decrypt (usa `pg_sym_decrypt` — **NOTA: bug no código, falta o `p` em `pgp_sym_decrypt`**) |
| 10 | [RootMcpService.ts](file:///home/cocorico/Documentos/proejetos/cascata/backend/services/RootMcpService.ts) | `executeTool → create_project` (L61) | encrypt |
| 11 | [VaultService.ts](file:///home/cocorico/Documentos/proejetos/cascata/backend/services/VaultService.ts) | ARQUIVO INTEIRO | **SERÁ DELETADO** |

---

## Arquitetura do Crypto Engine (Go)

### Hierarquia de Chaves

```
CASCATA_MASTER_SECRET (ENV var, 64 hex chars)
        │
        ▼ Argon2id (time=3, memory=256MB, threads=4)
        │
    KEK (Key Encryption Key) — 32 bytes na RAM
        │
        ▼ AES-256-GCM
        │
    DEK Store (dek_store.enc no disco)
        │
        ├── "system" DEK  ← projetos, segredos do sistema
        ├── "project-{slug}" DEK  ← segredos de cada tenant
        └── "backup" DEK  ← configurações de backup
```

### Formato do Dado Criptografado

O dado criptografado é armazenado como string TEXT no PostgreSQL:

```
cse:v1:<dek_name>:<dek_version>:<base64(nonce + ciphertext + gcm_tag)>
```

Exemplo: `cse:v1:system:1:dGhpcyBpcyBh...`

### Container Docker

```yaml
# crypto-engine (Go binary)
- Container: cascata-crypto-engine
- Imagem: Build local (golang:1.22-alpine → distroless)
- Porta: 50051 (HTTP interno, NÃO exposta)
- Rede: cascata_secure (nova, interna)
- Volume: ${CASCATA_DATA_DIR}/crypto:/data/crypto (chaves persistidas)
- Env: CASCATA_MASTER_SECRET (derivação da KEK)
- RAM: ~25MB
- Boot: ~50ms
```

### API HTTP Interna

| Endpoint | Método | Body | Resposta |
|---|---|---|---|
| `/v1/encrypt` | POST | `{ "key": "system", "plaintext": "base64..." }` | `{ "ciphertext": "cse:v1:system:1:..." }` |
| `/v1/decrypt` | POST | `{ "ciphertext": "cse:v1:system:1:..." }` | `{ "plaintext": "base64..." }` |
| `/v1/encrypt-batch` | POST | `{ "key": "system", "items": ["base64...", ...] }` | `{ "items": ["cse:v1:...", ...] }` |
| `/v1/decrypt-batch` | POST | `{ "items": ["cse:v1:...", ...] }` | `{ "items": ["base64...", ...] }` |
| `/v1/keys/rotate` | POST | `{ "key": "system" }` | `{ "version": 2, "rotated_at": "..." }` |
| `/v1/keys/list` | GET | — | `{ "keys": [{ "name": "...", "version": N }] }` |
| `/v1/health` | GET | — | `{ "status": "ok", "uptime_ms": N }` |

> [!TIP]
> Usamos HTTP (não gRPC) para simplicidade no client TypeScript. A latência HTTP interna na rede Docker é ~0.1ms, sem benefício real de gRPC para payloads pequenos. O endpoint `encrypt-batch` resolve a latência de múltiplas chamadas (ex: criptografar 3 chaves de projeto de uma vez).

---

## Deploy Phases (2 Passos → Teste → 2 Passos → Teste)

### ⚡ DEPLOY 1 — Fundação Go + Novo Docker Service

**Objetivo**: Crypto Engine rodando, respondendo na rede interna, sem tocar o backend Node.js.

#### Criações Novas:

##### [NEW] `crypto-engine/` (Módulo Go)

```
crypto-engine/
├── Dockerfile.txt          # Multi-stage: golang:1.22-alpine → gcr.io/distroless/static
├── go.mod                  # module github.com/hub-unibloom/cascata/crypto-engine
├── go.sum
├── main.go                 # Entry point: HTTP server, boot, Argon2id derivation
├── internal/
│   ├── crypto/
│   │   ├── aes.go          # AES-256-GCM encrypt/decrypt core
│   │   └── aes_test.go     # Unit tests
│   ├── keystore/
│   │   ├── store.go        # DEK store: load, save, rotate, versioning
│   │   └── store_test.go
│   ├── kek/
│   │   ├── derive.go       # Argon2id KEK derivation + mlock
│   │   └── derive_test.go
│   └── api/
│       ├── handlers.go     # HTTP handlers: /v1/encrypt, /v1/decrypt, etc.
│       ├── middleware.go    # Internal auth middleware (shared secret)
│       └── handlers_test.go
```

##### [MODIFY] [docker-compose.yml](file:///home/cocorico/Documentos/proejetos/cascata/docker-compose.yml)

**Mudanças:**
1. Adicionar rede `cascata_secure` (internal: true)
2. Adicionar service `crypto_engine`
3. Conectar `backend_control`, `backend_data`, `backend_engine` à rede `cascata_secure`
4. Adicionar `CRYPTO_ENGINE_URL=http://crypto_engine:50051` aos 3 backends
5. Adicionar `CASCATA_MASTER_SECRET=${CASCATA_MASTER_SECRET}` ao crypto_engine
6. Adicionar volume `${CASCATA_DATA_DIR:-/cascata-data}/crypto:/data/crypto`

##### [MODIFY] [.env.txt](file:///home/cocorico/Documentos/proejetos/cascata/.env.txt)

**Mudanças:**
1. Adicionar `CASCATA_MASTER_SECRET=` (gerado no install.sh)
2. Adicionar `CRYPTO_ENGINE_URL=http://crypto_engine:50051`

---

### 🧪 CHECKPOINT 1 — Teste em VPS Nova

**Verificação:**
1. `docker compose up -d` — todos os containers sobem
2. `curl http://crypto_engine:50051/v1/health` — responde `{"status":"ok"}`
3. Teste de encrypt/decrypt via `curl` manual
4. Backend Node.js sobe normalmente (ainda usa PGP SQL, sem mudança nele)

---

### ⚡ DEPLOY 2 — CryptoService TypeScript + Refatoração dos Controllers

**Objetivo**: Todo código Node.js para de usar PGP SQL e passa a chamar o Crypto Engine.

#### Criações Novas:

##### [NEW] `backend/services/CryptoService.ts`

Client HTTP para o Crypto Engine Go. Interface limpa:

```typescript
export class CryptoService {
  static async encrypt(keyName: string, plaintext: string): Promise<string>;
  static async decrypt(ciphertext: string): Promise<string>;
  static async encryptBatch(keyName: string, items: string[]): Promise<string[]>;
  static async decryptBatch(items: string[]): Promise<string[]>;
  static async rotateKey(keyName: string): Promise<void>;
  static async healthCheck(): Promise<boolean>;
}
```

##### [DELETE] `backend/services/VaultService.ts`

Removido por completo. Nenhum código referencia mais.

#### Refatorações nos 10 Arquivos (Cirúrgica):

---

##### [MODIFY] [AdminController.ts](file:///home/cocorico/Documentos/proejetos/cascata/backend/src/controllers/AdminController.ts) — 8 Funções

| Função | Linha | Mudança |
|---|---|---|
| `listProjects` | 271 | Remover `pgp_sym_decrypt(anon_key::bytea, $1::text)`. Trazer `anon_key` cifrado e chamar `CryptoService.decrypt()` |
| `createProject` | 297 | Remover `pgp_sym_encrypt($4, $7)`. Chamar `CryptoService.encryptBatch("system", [keys.anon, keys.service, keys.jwt])` ANTES do INSERT |
| `recoverProject` | 353 | Idem `createProject` |
| `revealKey` | 538 | Remover `pgp_sym_decrypt(${safeKeyType}::bytea, $2)`. Trazer cifrado e chamar `CryptoService.decrypt()` |
| `rotateKeys` | 545 | Remover `pgp_sym_encrypt($1, $3)`. Chamar `CryptoService.encrypt("system", newKey)` ANTES do UPDATE |
| `exportProject` | 563 | Remover `pgp_sym_decrypt` triplo. Buscar cifrado e `CryptoService.decryptBatch()` |
| `createWebhook` | 703 | Remover `pgp_sym_decrypt(jwt_secret::bytea, $1)`. Buscar cifrado e `CryptoService.decrypt()` |
| `testWebhook` | 771 | Idem `createWebhook` |

---

##### [MODIFY] [SecretsController.ts](file:///home/cocorico/Documentos/proejetos/cascata/backend/src/controllers/SecretsController.ts) — 2 Funções

| Função | Linha | Mudança |
|---|---|---|
| `create` | 48 | Remover `pgp_sym_encrypt($6, $7)`. Chamar `CryptoService.encrypt("project-{slug}", value)` ANTES do INSERT. Salvar o ciphertext como TEXT simples |
| `reveal` | 77 | Remover `pgp_sym_decrypt(secret_value::bytea, $3)`. Trazer `secret_value` cifrado e chamar `CryptoService.decrypt()` |

---

##### [MODIFY] [EdgeController.ts](file:///home/cocorico/Documentos/proejetos/cascata/backend/src/controllers/EdgeController.ts) — 1 Função

| Função | Linha | Mudança |
|---|---|---|
| `execute` | 16-20 | Remover `pgp_sym_decrypt(secret_value::bytea, $2)`. Buscar `secret_value` como TEXT e chamar `CryptoService.decryptBatch()` para todos os segredos do projeto |

---

##### [MODIFY] [WebhookController.ts](file:///home/cocorico/Documentos/proejetos/cascata/backend/src/controllers/WebhookController.ts) — 1 Função

| Função | Linha | Mudança |
|---|---|---|
| `handleIncoming` | 76 | Remover `pg_sym_decrypt(p.jwt_secret::bytea, $3)`. Buscar cifrado e `CryptoService.decrypt()` |

---

##### [MODIFY] [BackupController.ts](file:///home/cocorico/Documentos/proejetos/cascata/backend/src/controllers/BackupController.ts) — 5 Funções

| Função | Linha | Mudança |
|---|---|---|
| `listPolicies` | 46 | Remover `pgp_sym_decrypt(decode(config->>'encrypted_data', 'base64'), $2)`. Trazer `config->>'encrypted_data'` e `CryptoService.decrypt()` |
| `createPolicy` | 79 | Remover `pgp_sym_encrypt($5::text, $7)`. Chamar `CryptoService.encrypt("backup", config)` e salvar como `jsonb_build_object('encrypted_data', $N)` |
| `updatePolicy` | 110 | Idem `createPolicy` |
| `getDownloadLink` | 182 | Idem `listPolicies` |
| `restoreBackup` | 220 | Idem `listPolicies` |

---

##### [MODIFY] [core.ts (middleware)](file:///home/cocorico/Documentos/proejetos/cascata/backend/src/middlewares/core.ts) — 1 Bloco

| Função | Linha | Mudança |
|---|---|---|
| `resolveProject` | 138-140 | Remover `pgp_sym_decrypt(jwt_secret::bytea, $1::text)` triplo. SELECT das colunas como TEXT e chamar `CryptoService.decryptBatch([jwt_secret, anon_key, service_key])`. **NOTA:** Este é o HOT-PATH. O resultado é cacheado no L1/L2.  |

---

##### [MODIFY] [RateLimitService.ts](file:///home/cocorico/Documentos/proejetos/cascata/backend/services/RateLimitService.ts) — 1 Bloco

| Função | Linha | Mudança |
|---|---|---|
| `warmupCache` fallback | 367-374 | Idem `core.ts`. Remover `pgp_sym_decrypt` triplo, usar `CryptoService.decryptBatch()` |

---

##### [MODIFY] [BackupService.ts](file:///home/cocorico/Documentos/proejetos/cascata/backend/services/BackupService.ts) — 1 Função

| Função | Linha | Mudança |
|---|---|---|
| `executePolicyJob` | 189-195 | Remover `pgp_sym_decrypt` quádruplo (config + jwt + anon + service). Usar `CryptoService.decryptBatch()` |

---

##### [MODIFY] [AutomationService.ts](file:///home/cocorico/Documentos/proejetos/cascata/backend/services/AutomationService.ts) — 1 Função

| Função | Linha | Mudança |
|---|---|---|
| `resolveVaultSecret` | 762-780 | **Renomear para `resolveSecret`**. Remover `pg_sym_decrypt` (que aliás tem um bug — falta o `p` do `pgp_sym_decrypt`). Trazer `secret_value` como TEXT e usar `CryptoService.decrypt()`. Manter o protocolo `vault://` nas automações como referência semântica. |

---

##### [MODIFY] [RootMcpService.ts](file:///home/cocorico/Documentos/proejetos/cascata/backend/services/RootMcpService.ts) — 1 Função

| Função | Linha | Mudança |
|---|---|---|
| `executeTool → create_project` | 61 | Remover `pgp_sym_encrypt($4, $7)` triplo. Usar `CryptoService.encryptBatch()` ANTES do INSERT |

---

##### [MODIFY] [main.ts (config)](file:///home/cocorico/Documentos/proejetos/cascata/backend/src/config/main.ts)

| Mudança | Detalhe |
|---|---|
| Remover `SYS_SECRET` como export | `SYS_SECRET` deixa de ser usado para criptografia. Continua existindo APENAS para JWT signing (`jwt.sign(payload, SYS_SECRET)`) |
| Adicionar validação `CRYPTO_ENGINE_URL` | No boot, verificar se o Crypto Engine responde em `/v1/health` |

> [!WARNING]
> O `SYS_SECRET` (`SYSTEM_JWT_SECRET`) **NÃO será removido**. Ele continua sendo usado para assinar JWTs de admin. O que muda é que ele **não será mais usado como chave de criptografia** no banco de dados. A separação de responsabilidades é crítica.

---

##### [MODIFY] [install.sh.txt](file:///home/cocorico/Documentos/proejetos/cascata/install.sh.txt)

| Mudança | Detalhe |
|---|---|
| Gerar `CASCATA_MASTER_SECRET` | `gen_hex_secret 64` — 64 chars hex (32 bytes) |
| Injetar no `.env` | `sed -i "s\|^CASCATA_MASTER_SECRET=.*\|CASCATA_MASTER_SECRET=${MASTER_SECRET}\|" .env` |
| Adicionar ao FILE_MAP | `["crypto-engine/Dockerfile.txt"]="crypto-engine/Dockerfile"` |

---

### 🧪 CHECKPOINT 2 — Teste em VPS Nova

**Verificação:**
1. `docker compose up -d` — todos os containers sobem
2. Dashboard abre normalmente
3. Criar um projeto → chaves são salvas CIFRADAS pelo Engine (começa com `cse:v1:`)
4. Listar projetos → `anon_key` aparece decifrada corretamente
5. Secrets: criar e revelar segredo → funciona
6. Edge Functions: injeção de envs funciona
7. Backup: criar política e executar → config cifrada e decifrada
8. Webhooks: criar webhook → assina com jwt_secret decifrado

---

### ⚡ DEPLOY 3 — Fortalecimento de Segurança

**Objetivo**: Hardening final para produção.

##### [MODIFY] `crypto-engine/internal/api/middleware.go`

Adicionar autenticação por token compartilhado entre containers:
- Header: `X-Crypto-Auth: ${CRYPTO_INTERNAL_SECRET}`
- Rejeitar qualquer request sem este header

##### [NEW] Rotação Automática de DEKs

- Cron interno no Go: a cada 24h, rotacionar DEKs (nova versão)
- Dados antigos continuam legíveis (DEK v1 fica armazenada)
- Dados novos usam DEK v2+

##### [MODIFY] Audit Log

No `CryptoService.ts`, após cada `encrypt`/`decrypt`, registrar em `system.api_logs`:
- Quem (admin/tenant)
- O que (key_name, operation)
- Quando (timestamp)

---

### 🧪 CHECKPOINT 3 — Teste Final em VPS

**Verificação completa:**
1. Boot completo do zero
2. CRUD de projetos
3. CRUD de segredos
4. Edge Functions com secrets
5. Backups (criar, listar, restaurar)
6. Webhooks (criar, testar)
7. Automações com `vault://` resolvendo corretamente
8. Rotação de chaves (via Dashboard ou API)
9. Log de auditoria verificado

---

## Mudança no Schema do Banco de Dados

### Colunas que mudam de tipo

As colunas que hoje armazenam dados PGP (`bytea` output de `pgp_sym_encrypt`) continuarão armazenando `TEXT` — a diferença é que o conteúdo será uma string `cse:v1:...` em vez de binary PGP.

| Tabela | Coluna | Tipo Atual | Tipo Novo | Nota |
|---|---|---|---|---|
| `system.projects` | `anon_key` | TEXT (armazena PGP bytea) | TEXT | Conteúdo muda de PGP blob para `cse:v1:...` |
| `system.projects` | `service_key` | TEXT | TEXT | Idem |
| `system.projects` | `jwt_secret` | TEXT | TEXT | Idem |
| `system.project_secrets` | `secret_value` | TEXT | TEXT | Idem |
| `system.backup_policies` | `config` | JSONB | JSONB | O campo `encrypted_data` muda de base64(PGP) para `cse:v1:...` |

> [!NOTE]
> **NÃO é necessária nenhuma migration SQL de schema.** As colunas continuam TEXT/JSONB. Apenas o CONTEÚDO muda. Como não há dados legados, não há problemas de compatibilidade.

---

## Segurança em Profundidade — O Que Alcançamos

| Camada | Antes (PGP SQL) | Depois (Crypto Engine Go) |
|---|---|---|
| **Chave de criptografia** | Trafega do Node.js ao Postgres como parâmetro SQL | Nunca sai do processo Go |
| **Visibilidade em logs** | Visível em `pg_stat_statements`, slow query log | Invisível — o Postgres só vê ciphertext |
| **Proteção de memória** | V8 garbage collector pode expor em crash dump | `mlock` + zeroing manual em Go |
| **Isolamento** | Mesmo processo que serve HTTP | Container separado sem shell (distroless) |
| **Derivação** | Texto puro da ENV | Argon2id memory-hard (256MB, resistente a GPU) |
| **Rotação de chaves** | Manual — re-encriptar todo o DB | Automática — só troca o DEK, dados antigos legíveis |
| **Invasor com acesso root** | Lê SYS_SECRET do .env → decripta tudo | Precisa reconstruir Argon2id com params exatos |
| **Backup do DB roubado** | PGP + chave do .env → decripta | Ciphertext AES-256-GCM sem chave = lixo matemático |

---

## Decisões do Usuário Necessárias

> [!IMPORTANT]
> 1. **Protocolo de comunicação**: HTTP interno (recomendado por simplicidade). Alternativa: gRPC + protobuf. **Recomendação: HTTP.**
> 2. **Porta do Engine**: 50051 (convenção de serviços internos). Pode ser qualquer porta não utilizada.
> 3. **Rotação automática**: A cada 24h? 7 dias? Configurável via ENV?
> 4. **O protocolo `vault://` nas automações** permanece como referência semântica para resolver segredos, ou renomeamos para `secret://`?

## Questões Abertas

> [!CAUTION]
> - O `AutomationService.ts` linha 769 tem um **BUG**: usa `pg_sym_decrypt` em vez de `pgp_sym_decrypt` (falta o `p`). Isso significa que automações com `vault://` provavelmente estão falhando silenciosamente. O Crypto Engine corrige isso automaticamente.
> - O `WebhookController.ts` linha 76 também usa `pg_sym_decrypt` (falta o `p`). Mesmo problema.

---

## Verificação

### Testes Automatizados (Go)
```bash
cd crypto-engine && go test ./...
```

### Testes Manuais (VPS Nova)
1. Instalar com `install.sh` limpo
2. Verificar logs de boot do `cascata-crypto-engine`
3. Criar projeto, verificar DB: `SELECT anon_key FROM system.projects` deve começar com `cse:v1:`
4. Revelar chave via Dashboard
5. Criar segredo, revelar
6. Testar Edge Function com segredo injetado
7. Criar backup policy, executar backup
