package crypto

import (
    "sync/atomic"
    "time"
)

// Tarpit gerencia o atraso exponencial sob carga suspeita
type Tarpit struct {
    requests  int64
    threshold int64
}

func NewTarpit(threshold int64) *Tarpit {
    t := &Tarpit{threshold: threshold}
    // Lógica para resetar o contador a cada segundo
    go func() {
        for {
            time.Sleep(time.Second)
            atomic.StoreInt64(&t.requests, 0)
        }
    }()
    return t
}

func (t *Tarpit) RecordAndDelay() {
    count := atomic.AddInt64(&t.requests, 1)

    if count > t.threshold {
        // Atraso exponencial: 2^(excess_requests) ms
        // Limitado para não travar o servidor eternamente (max 30s)
        excess := count - t.threshold
        delayMs := 1 << uint(excess)
        if delayMs > 30000 {
            delayMs = 30000
        }
        
        time.Sleep(time.Duration(delayMs) * time.Millisecond)
    }
}
