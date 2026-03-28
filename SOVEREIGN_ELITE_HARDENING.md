# CASCATA — SOVEREIGN ELITE HARDENING BLUEPRINT
## Arquitetura de Criptografia Soberana e Isolamento de Estado

### 1. FILOSOFIA: "Zero-Knowledge Root"
O objetivo deste endurecimento é garantir que, mesmo se um invasor tiver acesso físico ao servidor ou controle total do sistema operacional, ele não conseguirá descriptografar os dados dos inquilinos sem uma interação humana externa e soberana.

---

### 2. COMPONENTE A: UNSEAL MANUAL (DESBLOQUEIO SOBERANO)
Elimina o "Ponto Único de Falha" do arquivo `.env` no disco.

**A. Funcionamento:**
1.  O instalador oferece o modo **Sovereign Elite**. Se selecionado, a `CASCATA_MASTER_SECRET` nunca é salva no `.env`.
2.  Ao iniciar (Boot), o container `crypto-engine` entra no modo `SEALED` (Selado).
3.  Todas as chamadas de API do backend retornam `503 Service Unavailable: Engine Sealed`.
4.  O Administrador deve realizar um comando via CLI ou Painel de Resgate injetando a chave **apenas na memória RAM**.

**B. Segurança:**
- A chave existe apenas enquanto o processo Go estiver vivo.
- Queda de energia ou reinicialização forçada apaga a chave instantaneamente.
- Ataques de "Forense em Disco" (roubo de HD) são inúteis.

---

### 3. COMPONENTE B: O PÂNTANO CRIPTOGRÁFICO (CRYPTOGRAPHIC TARPIT)
Proteção contra "Mass Decryption" (Vazamento em Lote).

**A. Lógica de Defesa:**
O motor Go monitora o ritmo de pedidos de descriptografia oriundos do container backend.
1.  **Fluxo Normal:** < 10 pedidos/segundo (Login/Uso comum) -> Latência de 1ms.
2.  **Alerta de Vazamento:** > 50 pedidos/segundo (Início de um dump de banco) -> Inicia o **Atraso Exponencial**.
3.  **Pântano:** A latência aumenta para `100ms * 2^n`. 
    - O atacante conseguiria extrair 50 chaves, mas a centésima chave levaria horas para ser processada.
4.  **Auto-Seal:** Se o ataque persistir, o motor Go se "suicida" na memória, exigindo um novo Unseal Manual.

**B. Objetivo:** Transformar um ataque de 5 minutos em um ataque de 50 anos, tornando o roubo de dados matematicamente inviável.

---

### 4. COMPONENTE C: GOVERNANÇA — ESQUEMA DE SHAMIR (CONSELHO SOBERANO)
Divide a autoridade de desbloqueio para evitar coerção ou perda da chave única.

**A. Mecanismo (Opcional Elite):**
- A Master Secret é dividida em **N partes** (ex: 3 partes).
- O sistema exige **M partes** (ex: 2 de 3) para reconstruir a chave.
- Você pode guardar uma parte no celular, outra em um cofre físico e uma terceira com um sucessor de confiança.

---

### 5. ROTEIRO DE IMPLEMENTAÇÃO (PATCHES)

#### Patch 1: O Motor Go (CCE)
- Implementar variável `IsSealed bool` no `keystore.Manager`.
- Adicionar endpoint `/v1/sys/unseal` (apenas via rede interna protegida).
- Implementar o `TarpitInterceptor` no roteador do Go.

#### Patch 2: O Instalador (install.sh)
- Adicionar flag `--sovereign-elite`.
- Se ativa: gerar a chave, exibi-la na tela do usuário (UMA VEZ) e **proibir** a escrita no `.env`.
- Configurar o backend para aguardar o estado `unsealed` antes de aceitar conexões.

---

### 6. RESUMO DA DEFESA EM PROFUNDIDADE

| Nível de Acesso do Invasor | Resultado (Padrão) | Resultado (Sovereign Elite) |
| :--- | :--- | :--- |
| Acesso ao .env | Acesso ao cofre | **Cofre permanece trancado** (chave não está lá). |
| Roubo do HD Físico | Dados criptografados no HD | **Dados perdidos para o ladrão** (chave nunca tocou o disco). |
| Invasão do Node.js | Pode tentar decriptar dados | **Atolado no Pântano Criptográfico** (latência infinita). |

---
**Este plano torna o Cascata um sistema de segurança militar operando em território público.**
