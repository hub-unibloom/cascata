# PLANO DE AÇÃO: CASCATA SOVEREIGN ELITE
## Implementação de Estado Selado e Pântano Criptográfico (Anti-Mass-Leak)

### 1. ALVOS DE MUDANÇA (MOTOR GO — CCE)

#### Arquivo: `crypto-engine/internal/keystore/store.go`
- **Mudança:** Adicionar campo `Sealed bool` e `kek []byte` (volátil) à struct `Manager`.
- **Lógica:** No boot, o `Manager` não tenta ler o arquivo `keys.enc` se a Master Secret não estiver no ambiente. Ele marca `Sealed = true`.
- **Novos Métodos:** 
    - `Unlock(secret string)`: Deriva a KEK via Argon2id e descriptografa a Keystore para a memória RAM.

#### Arquivo: `crypto-engine/internal/api/handlers.go`
- **Mudança:** Criar o `AuthBarrierMiddleware`.
- **Lógica:** Se `Status = Sealed`, qualquer chamada para `/v1/encrypt` ou `/v1/decrypt` retorna `HTTP 503` com corpo `{"status": "sealed"}`.
- **Novos Endpoints:**
    - `POST /v1/sys/unseal`: Recebe a Master Secret para abrir o cofre.
    - `GET /v1/sys/status`: Informa se o cofre está aberto ou selado.

#### Arquivo (Novo): `crypto-engine/internal/crypto/tarpit.go`
- **Mudança:** Implementar o motor de **Atraso Exponencial**.
- **Lógica:** Um contador atômico rastreia requisições por segundo. Se ultrapassar o limite (ex: 50 reqs/seg), o motor injeta `time.Sleep(ExponentialDelay)`.

---

### 2. ALVOS DE MUDANÇA (BACKEND — NODE.JS)

#### Arquivo: `backend/services/CryptoService.ts`
- **Mudança:** Refatorar a detecção de erro.
- **Lógica:** Se o Motor Go retornar `503 Sealed`, o Backend deve lançar uma exceção específica `EngineSealedError`.

#### Arquivo: `backend/src/middlewares/core.ts` (ou novo `security.ts`)
- **Mudança:** Adicionar o `MasterKeyGuard`.
- **Lógica:** Antes de qualquer resolução de inquilino, verifica se o motor Go está aberto. Se estiver selado, bloqueia o acesso ao Painel e APIs com uma tela de instrução para o Unseal.

---

### 3. ALVOR DE MUDANÇA (INSTALADOR — INSTALL.SH)

#### Arquivo: `install.sh.txt`
- **Mudança:** Adicionar a Fase 2.4 — "Definição do Perfil de Soberania".
- **Lógica:** 
    - **Modo Standard:** Mantém como está (conveniência).
    - **Modo Sovereign Elite:** Gera a `MASTER_SECRET`, limpa a variável do shell e **NUNCA** a escreve no `.env`. Exibe um QR Code ou texto gigante para o usuário salvar a chave em um local físico (papel/vault externo offline).

---

### 4. FLUXO DE VIDA "SOVEREIGN ELITE"

1.  **Boot:** Containers sobem. O arquivo `.env` não tem a Master Secret.
2.  **Sealed:** O Cascata fica em "Modo de Espera". Nenhum inquilino pode ser acessado.
3.  **Unseal:** O Administrador acessa uma URL especial (ex: `/cascata/unseal`) ou usa o CLI e cola sua chave mestre.
4.  **Ready:** A chave preenche a RAM do Go, o cofre abre e o sistema ganha vida.
5.  **Shutdown:** No momento em que o container para, o rastro da chave desaparece.

---

### 5. GARANTIA DE ZERO REGRESSÃO
- O modo Elite será opcional. 
- Se o usuário não ativar, o Cascata funciona no modo "Normal" (Master Secret no .env).
- Se ativar, ele tem a segurança máxima protegida por hardware-like logic.

**A nova VPS será o palco desta evolução final.**
