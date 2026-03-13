# Relatório Técnico: Implementação de Limites Avançados e Expurgo Multinível

Este relatório detalha as atualizações realizadas no **Cascata Orchestrator** para elevar o sistema de Rate Limiting e Gestão de Logs ao nível "Enterprise Production Grade", focando em flexibilidade, persistência e performance.

---

## 1. Gestão de Logs e Expurgo (Tiered Retention)

### O Que foi feito:
Implementação de um sistema de "Cold Storage" interno. Em vez de simplesmente deletar logs antigos, o sistema agora permite arquivá-los em uma tabela separada para auditoria de longo prazo antes da remoção definitiva.

### Arquivos e Alterações:
*   **[backend/migrations/032_tiered_retention.sql.txt](file:///home/cocorico/Downloads/cascata-main%20%285%29/cascata/backend/migrations/032_tiered_retention.sql.txt) [NEW]**:
    *   Criação da tabela `system.archived_logs` (espelho de `api_logs`).
    *   Atualização da função SQL `system.purge_old_logs` para aceitar um parâmetro booleano `p_archive`. Se `true`, os logs são movidos (não apenas deletados).
    *   Adição da coluna `archive_logs` na tabela `system.projects` para controle individual por inquilino.
*   **[backend/services/QueueService.ts](file:///home/cocorico/Downloads/cascata-main%20%285%29/cascata/backend/services/QueueService.ts) [MODIFY]**:
    *   O `maintenanceWorker` (que roda o expurgo global às 04:00 AM) foi atualizado para ler a flag `archive_logs` de cada projeto e passá-la para a função do banco de dados.
*   **[backend/src/controllers/AdminController.ts](file:///home/cocorico/Downloads/cascata-main%20%285%29/cascata/backend/src/controllers/AdminController.ts) [MODIFY]**:
    *   A API de gerenciamento agora permite que o administrador ative/desative o arquivamento via painel e trigger expurgos manuais com opção de arquivamento (`?archive=true`).

---

## 2. Limites Avançados: Pesos de Operação (Weights)

### Por que foi feito:
Uma requisição `DELETE` ou `POST` (Create) consome muito mais recursos do servidor e banco de dados do que um `GET` (Read). O sistema agora atribui "pesos" a essas operações.

### O Que foi feito:
O motor de Rate Limit agora incrementa o contador baseado no peso da operação em vez de apenas "+1".

### Lógica e Arquivos:
*   **[backend/services/RateLimitService.ts](file:///home/cocorico/Downloads/cascata-main%20%285%29/cascata/backend/services/RateLimitService.ts) [MODIFY]**:
    *   Implementada lógica que identifica a operação (Read/Create/Update/Delete).
    *   Busca os pesos configurados no metadado da regra (Padrão: Get=1, Post=5, Put=2, Del=3).
    *   Usa `incrby(key, weight)` no Dragonfly (Redis) em vez de `incr(key)`.

---

## 3. Janelas Temporais Multi-Dimensionais

### Por que foi feito:
Limitar apenas por "requisições por segundo" não impede abusos sustentados ao longo do dia. Agora é possível configurar limites simultâneos (Ex: 10 req/seg + 5.000 req/dia + 100.000 req/mês).

### O Que foi feito:
Backend e Frontend agora suportam um array de janelas temporais aplicadas a uma única regra.

### Arquivos:
*   **[backend/services/RateLimitService.ts](file:///home/cocorico/Downloads/cascata-main%20%285%29/cascata/backend/services/RateLimitService.ts) [MODIFY]**:
    *   A função [check()](file:///home/cocorico/Downloads/cascata-main%20%285%29/cascata/backend/services/RateLimitService.ts#509-696) foi refatorada para um loop que valida cada janela definida (`default`, `daily`, `weekly`, `monthly`). A requisição só passa se **todas** as janelas permitirem.
*   **[frontend/pages/RLSManager.tsx](file:///home/cocorico/Downloads/cascata-main%20%285%29/cascata/frontend/pages/RLSManager.tsx) [MODIFY]**:
    *   Adicionado seletor visual no modal "Traffic Guard" para ativar Janelas Diárias/Semanais/Mensais com um clique.

---

## 4. Quotas Acumulativas (Rollover)

### Por que foi feito:
Permitir que usuários que não consumiram sua cota em janelas anteriores possam utilizá-la em momentos de pico (Burst), recompensando o baixo uso prévio.

### O Que foi feito:
Persistência de saldo não utilizado em banco de dados para que sobreviva a reinicializações de cache.

### Arquivos e Lógica:
*   **[backend/migrations/031_advanced_quotas.sql.txt](file:///home/cocorico/Downloads/cascata-main%20%285%29/cascata/backend/migrations/031_advanced_quotas.sql.txt) [NEW]**:
    *   Criação da tabela `system.quota_balances` para rastrear o saldo acumulado por usuário/chave.
*   **[backend/services/RateLimitService.ts](file:///home/cocorico/Downloads/cascata-main%20%285%29/cascata/backend/services/RateLimitService.ts) [MODIFY]**:
    *   Substituída a lógica volátil por uma que consulta e atualiza o saldo no PostgreSQL antes de recorrer ao limite de "tempo real" do Dragonfly.
*   **[frontend/pages/RLSManager.tsx](file:///home/cocorico/Downloads/cascata-main%20%285%29/cascata/frontend/pages/RLSManager.tsx) [MODIFY]**:
    *   Inclusão de checkboxes "Rollover" em nível de regra e de "Defaults" em nível de Key Group (Plano).

---

## 5. Proteção de Infraestrutura (Nginx)

*   **[nginx/nginx.conf.txt](file:///home/cocorico/Downloads/cascata-main%20%285%29/cascata/nginx/nginx.conf.txt) [MODIFY]**:
    *   O limite fail-safe do Nginx foi elevado para **1000r/s**.
    *   **Motivo**: O Nginx deve atuar apenas como proteção contra DDoS volumétrico de baixo nível. A inteligência e granulometria dos planos e punições devem ficar no Orquestrador (Backend), evitando bloqueios rígidos que exigiriam restart do Nginx para alteração.

---

## Resumo de Localização (Caminhos Absolutos)

1.  **Lógica Core**: [/home/cocorico/Downloads/cascata-main (5)/cascata/backend/services/RateLimitService.ts](file:///home/cocorico/Downloads/cascata-main%20%285%29/cascata/backend/services/RateLimitService.ts)
2.  **Workers de Manutenção**: [/home/cocorico/Downloads/cascata-main (5)/cascata/backend/services/QueueService.ts](file:///home/cocorico/Downloads/cascata-main%20%285%29/cascata/backend/services/QueueService.ts)
3.  **UI de Controle**: [/home/cocorico/Downloads/cascata-main (5)/cascata/frontend/pages/RLSManager.tsx](file:///home/cocorico/Downloads/cascata-main%20%285%29/cascata/frontend/pages/RLSManager.tsx)
4.  **Esquema de Dados (Migrações)**:
    *   [/home/cocorico/Downloads/cascata-main (5)/cascata/backend/migrations/031_advanced_quotas.sql.txt](file:///home/cocorico/Downloads/cascata-main%20%285%29/cascata/backend/migrations/031_advanced_quotas.sql.txt)
    *   [/home/cocorico/Downloads/cascata-main (5)/cascata/backend/migrations/032_tiered_retention.sql.txt](file:///home/cocorico/Downloads/cascata-main%20%285%29/cascata/backend/migrations/032_tiered_retention.sql.txt)
5.  **Configuração Nginx**: [/home/cocorico/Downloads/cascata-main (5)/cascata/nginx/nginx.conf.txt](file:///home/cocorico/Downloads/cascata-main%20%285%29/cascata/nginx/nginx.conf.txt)

**Nota Final**: Todas as implementações seguiram a regra de **Zero Regressão**, mantendo compatibilidade com as rotas de API existentes enquanto adicionam camadas de personalização Enterprise.
