# 🛡️ Blueprint: Cascata Crypto Engine (Go) — Core Soberano

Este documento detalha o planejamento de ponta a ponta para a criação do motor de segurança nativo do Cascata. Este motor substitui o HashiCorp Vault e move a sensibilidade criptográfica para fora do banco de dados PostgreSQL.

---

## 1. Responsabilidades do Engine (Go)

O **Cascata Crypto Engine (CCE)** será um microsserviço binário em Go, altamente performático, com as seguintes obrigações:

| Responsabilidade | Descrição |
|---|---|
| **Soberania de Chave** | A Master Key (KEK) reside apenas no processo Go. O Node.js e o PostgreSQL nunca conhecem a chave mestra. |
| **Envelope Encryption** | Implementação de DEKs (Data Encryption Keys) criptografadas pela KEK. Chaves de dados são rotacionadas sem re-criptografar o DB. |
| **Transit Crypto** | Fornecer endpoints `Encrypt` / `Decrypt` para o backend Node.js via gRPC ou Unix Socket. |
| **Automação de Rotação** | Rotação periódica de chaves de dados sem intervenção humana. |
| **Integridade de Dados** | Uso obrigatório de **AES-256-GCM** (Authenticad Encryption) para garantir que dados não foram alterados. |
| **Audit Ledger** | Registro de toda operação sensível em uma tabela de auditoria protegida. |

---

## 2. Arquitetura Técnica: "The Vault-Slayer"

### 2.1 — Modelo de Derivação de Chave (KEK)
O Engine não salva a chave mestra em texto puro. No boot:
1. Lê `CASCATA_MASTER_SECRET` do ambiente.
2. Deriva a **Master KEK** usando **Argon2id** (Memory-hard ID).
3. Usa a KEK para abrir o `dek_store.enc` no disco.

### 2.2 — Key Hierarchy
1. **KEK (Key Encryption Key)**: Travada no Engine.
2. **DEK (Data Encryption Key)**: Gerada por projeto ou globalmente, salva no disco criptografada pela KEK.
3. **Nonce (Número Único)**: Gerado por cada operação de escrita (evita ataques de frequência).

---

## 3. Mapeamento de Integração (Arquivos Afetados)

Para implementar o CCE, os seguintes arquivos serão modificados para remover a lógica SQL PGP e a dependência de Axios/Vault:

### 3.1 — Camada de Configuração
*   **`.env.txt`**: Adicionar `CRYPTO_ENGINE_URL` e remover variáveis do Vault.
*   **`docker-compose.yml`**: Remover container `vault`, adicionar service `crypto-engine` na rede `cascata_secure`.
*   **`backend/src/config/main.ts`**: Atualizar o bootstrap para validar conexão com o Crypto Engine no boot.

### 3.2 — Camada de Serviços (Services)
*   **`backend/services/VaultService.ts`**: 
    *   **Ação**: Reescrita total. 
    *   **Mudança**: O serviço torna-se um client gRPC/HTTP para o Engine Go. Mantém a interface de métodos (`encrypt`, `decrypt`, `getSecret`) para garantir **Zero Regressão**.
*   **`backend/services/DatabaseService.ts`**:
    *   **Mudança**: Onde usava `VaultService.getDatabaseCredentials`, passará a usar credenciais injetadas via Crypto Engine ou segredos persistidos.

### 3.3 — Camada de Controladores (Controllers)
*   **`backend/src/controllers/AdminController.ts`**:
    *   **Função `createProject`**: Mudar o SQL de `pgp_sym_encrypt($4, $7)` para enviar o valor em texto puro vindo do Crypto Engine. O Node.js pede ao Engine para criptografar ANTES de enviar ao DB.
    *   **Função `listProjects`**: Remover `pgp_sym_decrypt` do SQL. O backend trará o dado cifrado e pedirá ao Engine para decriptar apenas no momento do envio.
    *   **Função `revealKey`**: Idem ao acima.
*   **`backend/src/controllers/SecretsController.ts`**:
    *   **Função `create`**: Remover `pgp_sym_encrypt` do SQL. Chamar `VaultService.encrypt()`.
    *   **Função `reveal`**: Remover `pgp_sym_decrypt` do SQL. Chamar `VaultService.decrypt()`.
*   **`backend/src/controllers/EdgeController.ts`**:
    *   **Função `execute`**: Atualizar a lógica de busca de segredos para passar pelo novo engine.

---

## 4. Pipeline de Operação (Fluxo de Dados)

### No Momento da Escrita (Ex: Criar Projeto)
1. Frontend envia `name`, `slug`.
2. Node.js gera `anon_key` (plain).
3. Node.js chama `CryptoEngine.Encrypt("project-keys", anon_key)`.
4. Go Engine retorna `cse:v1:nonce:ciphertext`. (CSE = Cascata Sovereign Encrypted).
5. Node.js salva `cse:v1:...` no PostgreSQL em uma coluna `TEXT/BYTEA`. (Sem PGP SQL).

### No Momento da Leitura (Ex: Dashboard Admin)
1. Node.js lê `cse:v1:...` do banco.
2. Detecta o prefixo `cse:`.
3. Chama `CryptoEngine.Decrypt("project-keys", ciphertext)`.
4. Go Engine valida tag GCM, decripta e retorna plain text.
5. Node.js envia para o Frontend.

---

## 5. Roadmap de Desenvolvimento (Fases)

### Fase A: Fundação Go (O Embrião)
1. Setup de projeto Go 1.22+.
2. Implementação do package `crypto/internal/aes` com GCM.
3. Implementação da store protegida (JSON criptografado).
4. Servidor gRPC/HTTP interno na porta 50051 (rede isolada).

### Fase B: Integração Node.js (A Substituição)
1. Implementação do `CascataCryptoClient` em TypeScript.
2. Refatoração do `VaultService.ts` para usar este client.
3. Atualização dos SQLs nos Controllers (Secrets/Admin).

### Fase C: Security Hardening (A Prova de Balas)
1. Implementação de log de auditoria via PostgreSQL `system.audit_ledger`.
2. Key Rotation Automática no Engine (DEK V1 -> V2).
3. Monitoramento de saúde e throughput.

---

## 6. Perspectiva Deep Dive (Funções e Nomenclaturas)

| Função Go | Equivalente Vault | Impacto no Cascata |
|---|---|---|
| `api.Encrypt` | `transit/encrypt` | Usado em todos os segredos de inquilinos e keys de sistema. |
| `api.Decrypt` | `transit/decrypt` | Usado no reveal de chaves e injeção de envs em Edge Functions. |
| `keys.Rotate` | `keys/rotate` | Executado periodicamente para re-gerar DEKs sem trocar a Master Key. |
| `store.Init` | `vault init` | Gerado no primeiro boot para criar a estrutura criptográfica. |

---

> [!IMPORTANT]
> **Conformidade com a Lei 3 (Zero Regression)**: O prefixo `cse:v1:` será introduzido para permitir que o sistema conviva com dados antigos (se houver) e novos, facilitando a transição. Todas as funções no backend Node.js manterão as mesmas assinaturas de chamada, alterando apenas a implementação interna para desviar o tráfego do SQL/Axios para o novo binário Go.

**Próximo Passo Proposto**: Revisar este blueprint e autorizar a criação da estrutura de pastas e o primeiro arquivo `main.go`.
