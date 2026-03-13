#!/usr/bin/env bash
# =============================================================
#  stress_db.sh — Stress + Relatório Máximo
#  Ubuntu 24.04 | Cascata / PostgREST
# =============================================================

set -uo pipefail

# ── Config ────────────────────────────────────────────────────
BASE="http://100.52.212.178/api/data/teste/rest/v1"
API_KEY="3c03b415e14a4ef814a4a731d25b9792d05ef6797a73cdc84cc7dddd21667aac"

CONCURRENCY=50
TOTAL_REQUESTS=2000
RAMP_UP_DELAY="0.02"

REPORT_DIR="/home/cocorico/Documentos/proejetos/cascata/relatorios"
TS=$(date +%Y%m%d_%H%M%S)
LOG_FILE="${REPORT_DIR}/stress_${TS}.csv"
REPORT_FILE="${REPORT_DIR}/relatorio_${TS}.txt"
ERRORS_FILE="${REPORT_DIR}/erros_${TS}.jsonl"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

# ── Dependências ──────────────────────────────────────────────
check_deps() {
    local missing=()
    for cmd in curl bc parallel jq; do
        command -v "$cmd" &>/dev/null || missing+=("$cmd")
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        echo -e "${YELLOW}[setup]${RESET} Instalando: ${missing[*]}"
        sudo apt-get update -qq && sudo apt-get install -y -qq "${missing[@]}"
    fi
    mkdir -p "$REPORT_DIR"
}

# ── fire_request ──────────────────────────────────────────────
# CSV: req_id, timestamp, http_code, elapsed_ms, time_connect_ms,
#      ttfb_ms, size_bytes, status, payload_name
fire_request() {
    local req_id="$1"
    local pick=$(( RANDOM % 6 ))
    local method url payload payload_name

    case "$pick" in
        0)  payload_name="get_produtos"
            method="GET"
            url="${BASE}/produtos?select=id,nome,preco,estoque&ativo=eq.true&order=preco.desc"
            payload="" ;;
        1)  payload_name="get_pedidos"
            method="GET"
            url="${BASE}/pedidos?select=id,status,total,criado_em&order=criado_em.desc"
            payload="" ;;
        2)  payload_name="get_top_itens"
            method="GET"
            url="${BASE}/pedido_itens?select=quantidade,preco_unit,produto_id&order=preco_unit.desc&limit=10"
            payload="" ;;
        3)  payload_name="get_estoque_baixo"
            method="GET"
            url="${BASE}/produtos?select=nome,estoque,preco&estoque=lt.100&order=estoque.asc"
            payload="" ;;
        4)  payload_name="insert_pedido"
            method="POST"
            local statuses=("pendente" "confirmado" "enviado")
            local st="${statuses[$((RANDOM % 3))]}"
            local total
            total=$(echo "scale=2; $((RANDOM % 2000 + 50)) + 0.90" | bc)
            url="${BASE}/pedidos"
            payload="{\"status\":\"${st}\",\"total\":${total}}" ;;
        5)  payload_name="get_categorias"
            method="GET"
            url="${BASE}/categorias?select=id,nome,descricao&ativo=eq.true"
            payload="" ;;
    esac

    local ts_req
    ts_req=$(date +%s)

    # Captura body do erro + métricas detalhadas de tempo
    local body_file
    body_file=$(mktemp)

    # curl -w com todos os timings
    local curl_fmt="%{http_code}|%{time_connect}|%{time_starttransfer}|%{time_total}|%{size_download}"
    local curl_out

    if [[ "$method" == "GET" ]]; then
        curl_out=$(curl -s -o "$body_file" -w "$curl_fmt" \
            --max-time 10 -X GET "$url" \
            -H "apikey: $API_KEY" \
            -H "Authorization: Bearer $API_KEY" 2>/dev/null || echo "000|0|0|10|0")
    else
        curl_out=$(curl -s -o "$body_file" -w "$curl_fmt" \
            --max-time 10 -X POST "$url" \
            -H "apikey: $API_KEY" \
            -H "Authorization: Bearer $API_KEY" \
            -H "Content-Type: application/json" \
            -H "Prefer: return=minimal" \
            -d "$payload" 2>/dev/null || echo "000|0|0|10|0")
    fi

    local http_code time_connect ttfb time_total size_bytes
    http_code=$(echo "$curl_out"    | cut -d'|' -f1)
    time_connect=$(echo "$curl_out" | cut -d'|' -f2)
    ttfb=$(echo "$curl_out"         | cut -d'|' -f3)
    time_total=$(echo "$curl_out"   | cut -d'|' -f4)
    size_bytes=$(echo "$curl_out"   | cut -d'|' -f5)

    # Converter segundos (float) → ms (int)
    local elapsed_ms connect_ms ttfb_ms
    elapsed_ms=$(echo "$time_total   * 1000" | bc | cut -d'.' -f1)
    connect_ms=$(echo "$time_connect * 1000" | bc | cut -d'.' -f1)
    ttfb_ms=$(echo    "$ttfb         * 1000" | bc | cut -d'.' -f1)

    local status="OK"
    [[ "$http_code" != "200" && "$http_code" != "201" && "$http_code" != "204" ]] && status="FAIL"

    # Se falhou, salva o body do erro (jsonl) com contexto
    if [[ "$status" == "FAIL" ]]; then
        local body_content
        body_content=$(cat "$body_file" 2>/dev/null | head -c 500 | tr '\n' ' ')
        echo "{\"req\":${req_id},\"ts\":${ts_req},\"code\":\"${http_code}\",\"endpoint\":\"${payload_name}\",\"body\":$(echo "$body_content" | jq -Rs . 2>/dev/null || echo "\"parse_error\"")}" >> "$ERRORS_FILE"
    fi

    rm -f "$body_file"

    echo "${req_id},${ts_req},${http_code},${elapsed_ms},${connect_ms},${ttfb_ms},${size_bytes},${status},${payload_name}" >> "$LOG_FILE"
    printf "%s " "$req_id"
}

export -f fire_request
export BASE API_KEY LOG_FILE ERRORS_FILE

# ── Sparkline ASCII de latência ───────────────────────────────
sparkline() {
    # Divide em 40 buckets, plota barra proporcional
    local data="$1"
    local max_val
    max_val=$(echo "$data" | sort -n | tail -1)
    [[ -z "$max_val" || "$max_val" -eq 0 ]] && { echo "  (sem dados)"; return; }

    local bucket_size=$(( $(echo "$data" | wc -l) / 40 + 1 ))
    local bars=("▁" "▂" "▃" "▄" "▅" "▆" "▇" "█")
    local line=""
    local i=0
    local bucket_sum=0 bucket_cnt=0

    while IFS= read -r val; do
        bucket_sum=$(( bucket_sum + val ))
        bucket_cnt=$(( bucket_cnt + 1 ))
        if [[ $bucket_cnt -ge $bucket_size ]]; then
            local avg=$(( bucket_sum / bucket_cnt ))
            local idx=$(( avg * 7 / max_val ))
            [[ $idx -gt 7 ]] && idx=7
            line+="${bars[$idx]}"
            bucket_sum=0; bucket_cnt=0
        fi
    done <<< "$data"

    echo "  ${line}"
    echo "  0ms $(printf '%*s' 30 '')${max_val}ms"
}

# ── MTBF — tempo médio entre falhas ──────────────────────────
calc_mtbf() {
    local data="$1"
    echo "$data" | awk -F',' '
    $8=="FAIL" {
        if(last_fail > 0) { diff = $2 - last_fail; sum+=diff; cnt++ }
        last_fail = $2
    }
    END { if(cnt>0) printf "%.1fs", sum/cnt; else print "N/A" }'
}

# ── Recovery: detecta colapso e retorno ───────────────────────
detect_recovery() {
    local data="$1"
    echo "$data" | awk -F',' '
    BEGIN { in_collapse=0; collapse_start=0; collapse_req=0 }
    {
        win_buf[NR % 20] = ($8=="OK") ? 1 : 0
        if(NR >= 20) {
            ok_w=0; for(i=0;i<20;i++) ok_w+=win_buf[i]
            err_pct=(20-ok_w)*100/20
            if(!in_collapse && err_pct >= 80) {
                in_collapse=1; collapse_req=$1; collapse_ts=$2
                printf "  ⚠️  Colapso detectado na req #%s (≥80%% erros em janela 20)\n", $1
            }
            if(in_collapse && err_pct < 20) {
                in_collapse=0
                printf "  ✅  Recuperação na req #%s (voltou a <20%% erros)\n", $1
                collapse_req=0
            }
        }
    }
    END { if(in_collapse) printf "  💀  Sem recuperação até o final do teste (último req=%s)\n", $1 }'
}

# ── Análise de erros por body ─────────────────────────────────
analyze_error_bodies() {
    [[ ! -f "$ERRORS_FILE" ]] && { echo "  (nenhum erro capturado)"; return; }
    echo "  Top mensagens de erro (body):"
    jq -r '.body' "$ERRORS_FILE" 2>/dev/null \
        | grep -o '"[^"]*":[^,}]*' \
        | sort | uniq -c | sort -rn | head -8 \
        | awk '{printf "  ├─ (%s×) %s\n", $1, substr($0, index($0,$2))}'

    echo ""
    echo "  Erros por endpoint:"
    jq -r '[.endpoint, .code] | @tsv' "$ERRORS_FILE" 2>/dev/null \
        | sort | uniq -c | sort -rn | head -10 \
        | awk '{printf "  ├─ %-25s HTTP %s  (%s×)\n", $2, $3, $1}'
}

# ── Gargalo: TCP vs App ───────────────────────────────────────
bottleneck_analysis() {
    local data="$1"
    local avg_connect avg_ttfb avg_total
    avg_connect=$(echo "$data" | awk -F',' '{s+=$5;c++} END{if(c>0)printf "%.0f",s/c;else print 0}')
    avg_ttfb=$(echo    "$data" | awk -F',' '{s+=$6;c++} END{if(c>0)printf "%.0f",s/c;else print 0}')
    avg_total=$(echo   "$data" | awk -F',' '{s+=$4;c++} END{if(c>0)printf "%.0f",s/c;else print 0}')

    local app_time=$(( avg_ttfb - avg_connect ))
    local transfer_time=$(( avg_total - avg_ttfb ))

    echo "  ├─ TCP connect   : ${avg_connect}ms"
    echo "  ├─ App/DB (TTFB) : ${app_time}ms   ← onde o banco processa"
    echo "  ├─ Transferência : ${transfer_time}ms"
    echo "  └─ Total médio   : ${avg_total}ms"

    # Diagnóstico automático
    if [[ $app_time -gt 2000 ]]; then
        echo ""
        echo "  ⚠️  DIAGNÓSTICO: gargalo no banco/app (TTFB ${app_time}ms)"
        echo "      → checar: max_connections, pool size, query locks"
    elif [[ $avg_connect -gt 500 ]]; then
        echo ""
        echo "  ⚠️  DIAGNÓSTICO: gargalo na rede/TCP (connect ${avg_connect}ms)"
        echo "      → checar: firewall, keep-alive, proxy"
    else
        echo ""
        echo "  ✅  DIAGNÓSTICO: latência dentro do esperado"
    fi
}

# ── Relatório completo ────────────────────────────────────────
generate_report() {
    local data
    data=$(tail -n +2 "$LOG_FILE")

    local total ok fail
    total=$(echo "$data" | wc -l)
    ok=$(echo "$data"   | awk -F',' '$8=="OK"'   | wc -l)
    fail=$(echo "$data" | awk -F',' '$8=="FAIL"' | wc -l)
    local pct_ok=0 pct_fail=0
    [[ $total -gt 0 ]] && pct_ok=$(echo  "scale=1; $ok   * 100 / $total" | bc)
    [[ $total -gt 0 ]] && pct_fail=$(echo "scale=1; $fail * 100 / $total" | bc)

    local times
    times=$(echo "$data" | awk -F',' '{print $4}')
    local avg_ms min_ms max_ms p95_ms p99_ms
    avg_ms=$(echo "$times" | awk '{s+=$1;c++} END{if(c>0)printf "%.0f",s/c;else print 0}')
    min_ms=$(echo "$times" | sort -n | head -1)
    max_ms=$(echo "$times" | sort -n | tail -1)
    p95_ms=$(echo "$times" | sort -n | awk -v p=0.95 'BEGIN{c=0}{a[c++]=$1}END{if(c>0)print a[int(c*p)];else print 0}')
    p99_ms=$(echo "$times" | sort -n | awk -v p=0.99 'BEGIN{c=0}{a[c++]=$1}END{if(c>0)print a[int(c*p)];else print 0}')

    local duration_s=$(( $(date +%s) - START_TIME ))
    local rps="n/a"
    [[ $duration_s -gt 0 ]] && rps=$(echo "scale=1; $total / $duration_s" | bc)

    # Tamanho médio resposta (só OKs)
    local avg_size
    avg_size=$(echo "$data" | awk -F',' '$8=="OK"{s+=$7;c++} END{if(c>0)printf "%.0f",s/c;else print 0}')

    # Ponto de degradação (janela 50, >20% erro)
    local deg_info
    deg_info=$(echo "$data" | awk -F',' '
        BEGIN{idx=0;found=0}
        {
            buf[idx%50]=($8=="OK")?1:0; idx++
            if(idx>=50){
                ok_w=0; for(i=0;i<50;i++) ok_w+=buf[i]
                if((50-ok_w)*100/50>=20 && !found){
                    found=1
                    printf "req #%s às %s", $1, strftime("%H:%M:%S",$2)
                }
            }
        }
        END{if(!found)print "não detectado"}')

    # Maior sequência de falhas
    local max_streak
    max_streak=$(echo "$data" | awk -F',' 'BEGIN{c=0;m=0}{if($8=="FAIL"){c++;if(c>m)m=c}else c=0}END{print m}')

    # MTBF
    local mtbf
    mtbf=$(calc_mtbf "$data")

    {
    echo "╔══════════════════════════════════════════════════════╗"
    echo "║     RELATÓRIO DE STRESS — $(date '+%d/%m/%Y %H:%M:%S')     ║"
    echo "╚══════════════════════════════════════════════════════╝"
    echo ""
    echo "  Endpoint Base  : $BASE"
    echo "  Início         : $(date -d "@${START_TIME}" '+%H:%M:%S')"
    echo "  Fim            : $(date '+%H:%M:%S')"
    echo "  Duração        : ${duration_s}s"
    echo "  Concorrência   : $CONCURRENCY workers"
    echo "  Total req.     : $total"
    echo "  Throughput     : ${rps} req/s"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  RESULTADO GERAL"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ✅  Sucesso    : $ok  (${pct_ok}%)"
    echo "  ❌  Falhas     : $fail  (${pct_fail}%)"
    echo "  📦  Resp. média: ${avg_size} bytes (reqs OK)"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  LATÊNCIA"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ├─ Mínima : ${min_ms}ms"
    echo "  ├─ Média  : ${avg_ms}ms"
    echo "  ├─ P95    : ${p95_ms}ms"
    echo "  ├─ P99    : ${p99_ms}ms"
    echo "  └─ Máxima : ${max_ms}ms"
    echo ""
    echo "  Distribuição de latência ao longo do tempo:"
    sparkline "$times"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ONDE ESTÁ O GARGALO (TCP vs App vs Transferência)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    bottleneck_analysis "$data"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  HTTP CODES NAS FALHAS"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$data" | awk -F',' '$8=="FAIL"{print $3}' \
        | sort | uniq -c | sort -rn | head -8 \
        | awk '{printf "  ├─ HTTP %-5s : %s ocorrências\n", $2, $1}'
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ANÁLISE DOS ERROS (body das respostas)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    analyze_error_bodies
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  POR ENDPOINT"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$data" | awk -F',' '
    {
        ep=$9; st=$8; ms=$4
        total[ep]++; lat[ep]+= ms
        if(st=="OK") ok[ep]++
        else fail[ep]++
    }
    END{
        for(ep in total){
            ok_n  = (ep in ok)   ? ok[ep]   : 0
            fail_n= (ep in fail) ? fail[ep] : 0
            avg   = (total[ep]>0) ? int(lat[ep]/total[ep]) : 0
            pct   = int(fail_n * 100 / total[ep])
            icon  = (pct >= 50) ? "❌" : (pct >= 20) ? "⚠️ " : "✅"
            printf "  %s  %-28s  ok=%-5d fail=%-5d (%3d%% erro)  avg=%dms\n",
                icon, ep, ok_n, fail_n, pct, avg
        }
    }' | sort -t'=' -k3 -rn
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  EVOLUÇÃO A CADA 100 REQUISIÇÕES"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$data" | awk -F',' '
    BEGIN{win=100;bucket=1;cnt=0;ok_b=0}
    {
        ok_b+=($8=="OK")?1:0; cnt++
        if(cnt==win){
            fail_b=win-ok_b
            pct_ok=int(ok_b*100/win)
            pct_fail=100-pct_ok
            marker=(pct_ok>=50)?"✅":"❌"
            printf "  %s  Reqs %4d–%4d  |  ok=%-3d (%2d%%)  fail=%-3d (%2d%%)\n",
                marker,(bucket-1)*win+1,bucket*win,ok_b,pct_ok,fail_b,pct_fail
            bucket++;cnt=0;ok_b=0
        }
    }'
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ESTABILIDADE E COLAPSOS"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Ponto de degradação (>20% erro): $deg_info"
    echo "  MTBF (tempo médio entre falhas): $mtbf"
    echo "  Maior sequência de falhas consecutivas: ${max_streak} reqs"
    echo ""
    detect_recovery "$data"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ARQUIVOS"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Log CSV    : $LOG_FILE"
    echo "  Erros JSONL: $ERRORS_FILE"
    echo "  Relatório  : $REPORT_FILE"
    echo "══════════════════════════════════════════════════════"
    } | tee "$REPORT_FILE"
}

# ── Main ──────────────────────────────────────────────────────
main() {
    check_deps

    echo -e "\n${BOLD}${CYAN}╔══════════════════════════════════════════╗${RESET}"
    echo -e "${BOLD}${CYAN}║       DB STRESS TEST — CASCATA           ║${RESET}"
    echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════╝${RESET}\n"
    echo -e "  ${YELLOW}Target${RESET}       : $BASE"
    echo -e "  ${YELLOW}Requisições${RESET}  : $TOTAL_REQUESTS"
    echo -e "  ${YELLOW}Concorrência${RESET} : $CONCURRENCY workers"
    echo -e "  ${YELLOW}Relatórios${RESET}   : $REPORT_DIR\n"

    echo -e "${GREEN}[▶]${RESET} Iniciando stress em 3s... (Ctrl+C para abortar)\n"
    sleep 3

    echo "req_id,timestamp,http_code,elapsed_ms,connect_ms,ttfb_ms,size_bytes,status,payload_name" > "$LOG_FILE"
    : > "$ERRORS_FILE"   # limpa/cria o arquivo de erros

    START_TIME=$(date +%s)
    export START_TIME

    echo -e "${CYAN}[disparando]${RESET}"

    seq 1 "$TOTAL_REQUESTS" | \
        parallel -j "$CONCURRENCY" --delay "$RAMP_UP_DELAY" \
        fire_request {}

    echo -e "\n\n${GREEN}[✔]${RESET} Concluído! Gerando relatório...\n"
    generate_report
}

main "$@"
