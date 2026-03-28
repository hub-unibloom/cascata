package kek

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"golang.org/x/crypto/argon2"
	"os"
)

// Parâmetros Argon2id (OWASP & RFC 9106)
const (
	Memory      = 256 * 1024 // 256MB
	Iterations  = 3
	Parallelism = 4
	KeyLength   = 32
)

// DeriveKEK recebe a Master Secret em Hex e retorna a Key Encryption Key (KEK)
func DeriveKEK(masterSecretHex string) ([]byte, error) {
	if len(masterSecretHex) < 64 {
		return nil, errors.New("MASTER_SECRET must be at least 64 hex characters (32 bytes entropy)")
	}

	masterSecret, err := hex.DecodeString(masterSecretHex)
	if err != nil {
		return nil, fmt.Errorf("failed to decode master secret: %w", err)
	}

	// Usamos o machine-id ou hostname como salt estático para este servidor específico
	// Isso garante que a mesma MASTER_SECRET em VPSs diferentes resulte em KEKs diferentes
	salt := getStaticSalt()

	// Argon2id: Memory-hard derivation
	kek := argon2.IDKey(masterSecret, salt, Iterations, Memory, Parallelism, KeyLength)

	// Segurança: Limpar o masterSecret da memória após o uso
	for i := range masterSecret {
		masterSecret[i] = 0
	}

	return kek, nil
}

func getStaticSalt() []byte {
	// Tenta ler o machine-id do Linux
	mid, err := os.ReadFile("/etc/machine-id")
	if err != nil {
		// Fallback para o hostname se machine-id não estiver disponível
		host, _ := os.Hostname()
		mid = []byte(host)
	}
	
	hash := sha256.Sum256(mid)
	return hash[:]
}
