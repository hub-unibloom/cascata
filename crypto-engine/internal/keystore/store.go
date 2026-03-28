package keystore

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"

	"github.com/hub-unibloom/cascata/crypto-engine/internal/crypto"
)

type KeyEntry struct {
	Version int    `json:"version"`
	Key     []byte `json:"key"` // 32 bytes (AES-256)
}

type Store struct {
	Keys map[string][]KeyEntry `json:"keys"`
}

type Manager struct {
	storePath string
	kek       []byte
	store     *Store
	mu        sync.RWMutex
}

func NewManager(path string, kek []byte) (*Manager, error) {
	m := &Manager{
		storePath: path,
		kek:       kek,
		store:     &Store{Keys: make(map[string][]KeyEntry)},
	}

	err := m.load()
	if err != nil {
		if os.IsNotExist(err) {
			// Se não existir, inicializamos chaves padrão
			fmt.Println("[KeyStore] Database not found. Creating fresh keys...")
			return m, m.initDefaults()
		}
		return nil, err
	}

	return m, nil
}

func (m *Manager) initDefaults() error {
	_, err := m.GenerateKey("system")
	if err != nil {
		return err
	}
	_, err = m.GenerateKey("backup")
	return err
}

func (m *Manager) GetKey(name string, version int) ([]byte, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	entries, ok := m.store.Keys[name]
	if !ok {
		return nil, fmt.Errorf("key '%s' not found", name)
	}

	// Se version for 0, retorna a mais recente
	if version <= 0 {
		return entries[len(entries)-1].Key, nil
	}

	for _, e := range entries {
		if e.Version == version {
			return e.Key, nil
		}
	}

	return nil, fmt.Errorf("version %d for key '%s' not found", version, name)
}

func (m *Manager) GetLatestVersion(name string) int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	entries, ok := m.store.Keys[name]
	if !ok {
		return 0
	}
	return entries[len(entries)-1].Version
}

func (m *Manager) GenerateKey(name string) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	newKey := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, newKey); err != nil {
		return 0, err
	}

	entries := m.store.Keys[name]
	newVersion := 1
	if len(entries) > 0 {
		newVersion = entries[len(entries)-1].Version + 1
	}

	m.store.Keys[name] = append(entries, KeyEntry{
		Version: newVersion,
		Key:     newKey,
	})

	err := m.save()
	if err != nil {
		return 0, err
	}

	return newVersion, nil
}

func (m *Manager) load() error {
	data, err := os.ReadFile(m.storePath)
	if err != nil {
		return err
	}

	// Decifra a store com a KEK
	plaintext, err := crypto.DecryptAESGCM(data, m.kek)
	if err != nil {
		return fmt.Errorf("failed to decrypt keystore (WRONG MASTER SECRET?): %w", err)
	}

	return json.Unmarshal(plaintext, &m.store)
}

func (m *Manager) save() error {
	plaintext, err := json.Marshal(m.store)
	if err != nil {
		return err
	}

	// Cifra a store com a KEK antes de salvar
	ciphertext, err := crypto.EncryptAESGCM(plaintext, m.kek)
	if err != nil {
		return err
	}

	// Escrita atômica (salva em .tmp e renomeia) para evitar corrupção em caso de queda de energia
	tmpPath := m.storePath + ".tmp"
	err = os.WriteFile(tmpPath, ciphertext, 0600)
	if err != nil {
		return err
	}

	return os.Rename(tmpPath, m.storePath)
}
