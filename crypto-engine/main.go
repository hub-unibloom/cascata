package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/hub-unibloom/cascata/crypto-engine/internal/api"
	"github.com/hub-unibloom/cascata/crypto-engine/internal/kek"
	"github.com/hub-unibloom/cascata/crypto-engine/internal/keystore"
)

func main() {
	fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
	fmt.Println("  ▸ CASCATA CRYPTO ENGINE v1.0 (Go)")
	fmt.Println("  Enterprise Security Node — Production Grade")
	fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

	masterSecret := os.Getenv("CASCATA_MASTER_SECRET")
	if masterSecret == "" {
		log.Fatal("[FATAL] CASCATA_MASTER_SECRET is required but not set.")
	}

	// 1. Derivação de KEK (Argon2id)
	fmt.Print("[Boot] Deriving KEK via Argon2id (Memory-hard)... ")
	start := time.Now()
	kekBytes, err := kek.DeriveKEK(masterSecret)
	if err != nil {
		log.Fatalf("\n[FATAL] KEK derivation failed: %v", err)
	}
	fmt.Printf("Done (%v)\n", time.Since(start))

	// 2. Inicialização do KeyStore
	dbPath := os.Getenv("CRYPTO_DB_PATH")
	if dbPath == "" { dbPath = "/data/crypto/keys.enc" }
	
	manager, err := keystore.NewManager(dbPath, kekBytes)
	if err != nil {
		log.Fatalf("[FATAL] KeyStore initialization failed: %v", err)
	}
	fmt.Printf("[Boot] KeyStore loaded from %s\n", dbPath)

	// 3. Setup do Servidor API
	internalSecret := os.Getenv("INTERNAL_CTRL_SECRET")
	if internalSecret == "" {
		log.Fatal("[FATAL] INTERNAL_CTRL_SECRET is required.")
	}

	router := &api.Router{
		Manager:        manager,
		InternalSecret: internalSecret,
	}

	port := os.Getenv("PORT")
	if port == "" { port = "50051" }

	fmt.Printf("[Boot] Listening for internal requests on port %s\n", port)
	server := &http.Server{
		Addr:         ":" + port,
		Handler:      router,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("[FATAL] HTTP server failed: %v", err)
	}
}
