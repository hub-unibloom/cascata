package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/hub-unibloom/cascata/crypto-engine/internal/api"
	"github.com/hub-unibloom/cascata/crypto-engine/internal/crypto"
	"github.com/hub-unibloom/cascata/crypto-engine/internal/kek"
	"github.com/hub-unibloom/cascata/crypto-engine/internal/keystore"
)

func main() {
	// Initialize Structured Logging (JSON)
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	slog.Info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
	slog.Info("  ▸ CASCATA CRYPTO ENGINE v1.0 (Go)")
	slog.Info("  Enterprise Security Node — Production Grade")
	slog.Info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

	masterSecret := os.Getenv("CASCATA_MASTER_SECRET")
	var kekBytes []byte
	var err error

	if masterSecret == "" {
		slog.Warn("CASCATA_MASTER_SECRET not found. Booting in SEALED mode.")
	} else {
		// 1. Derivação de KEK (Argon2id)
		slog.Info("[Boot] Deriving KEK via Argon2id (Memory-hard)...")
		start := time.Now()
		kekBytes, err = kek.DeriveKEK(masterSecret)
		if err != nil {
			slog.Error("KEK derivation failed", "error", err)
			os.Exit(1)
		}
		slog.Info("KEK Derived", "duration", time.Since(start))
	}

	// 2. Inicialização do KeyStore
	dbPath := os.Getenv("CRYPTO_DB_PATH")
	if dbPath == "" {
		dbPath = "/data/crypto/keys.enc"
	}
	
	manager, err := keystore.NewManager(dbPath, kekBytes)
	if err != nil {
		slog.Error("KeyStore initialization failed", "error", err)
		os.Exit(1)
	}
	
	if manager.Sealed {
		slog.Info("KeyStore is SEALED. Awaiting manual unseal.")
	} else {
		slog.Info("KeyStore loaded and READY", "path", dbPath)
	}

	// 3. Setup do Servidor API
	internalSecret := os.Getenv("INTERNAL_CTRL_SECRET")
	if internalSecret == "" {
		slog.Error("INTERNAL_CTRL_SECRET is required.")
		os.Exit(1)
	}

	router := &api.Router{
		Manager:        manager,
		InternalSecret: internalSecret,
		Tarpit:         crypto.NewTarpit(50), // 50 reqs/sec threshold
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000" // Standard port
	}

	server := &http.Server{
		Addr:         ":" + port,
		Handler:      router,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// 4. Graceful Shutdown
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	go func() {
		slog.Info("CCE API listening", "port", port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("HTTP server failed", "error", err)
			os.Exit(1)
		}
	}()

	<-stop
	slog.Info("Shutting down CCE gracefully...")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		slog.Warn("Server shutdown produced an error", "error", err)
	}
	slog.Info("CCE stopped. Safe for container exit.")
}
