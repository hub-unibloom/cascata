package keystore

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"

	"github.com/hub-unibloom/cascata/crypto-engine/internal/crypto"
	"github.com/hub-unibloom/cascata/crypto-engine/internal/kek"
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
	Sealed    bool
}

func (m *Manager) IsSealed() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.Sealed
}

func NewManager(path string, kek []byte) (*Manager, error) {
	m := &Manager{
		storePath: path,
		kek:       kek,
		store:     &Store{Keys: make(map[string][]KeyEntry)},
		Sealed:    len(kek) == 0,
	}

	// Se estiver selado (sem KEK no boot), paramos aqui.
	if m.Sealed {
		return m, nil
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

// Unlock abre o cofre fornecendo a Master Secret
func (m *Manager) Unlock(masterSecret string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.Sealed {
		return fmt.Errorf("keyStore is already unsealed")
	}

	kekBytes, err := kek.DeriveKEK(masterSecret)
	if err != nil {
		return fmt.Errorf("failed to derive KEK from provided secret: %w", err)
	}

	// Tentativa de carregar a store com a nova chave
	oldKek := m.kek
	m.kek = kekBytes
	
	err = m.load()
	if err != nil {
		// Só revertemos a KEK se o erro NÃO for de arquivo inexistente.
		// Precisamos da KEK para o initDefaults() caso o arquivo não exista no primeiro boot.
		if !os.IsNotExist(err) {
			m.kek = oldKek
		}

		if os.IsNotExist(err) {
			// Se não existir, inicializamos agora que temos a KEK
			err = m.initDefaults()
			if err == nil {
				m.Sealed = false
			}
			return err
		}
		return fmt.Errorf("falha ao abrir KeyStore (Chave Mestra incorreta?): %w", err)
	}

	m.Sealed = false
	return nil
}

func (m *Manager) initDefaults() error {
	_, err := m.generateKeyNoLock("system")
	if err != nil {
		return err
	}
	_, err = m.generateKeyNoLock("backup")
	return err
}

func (m *Manager) GetKey(name string, version int) ([]byte, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.Sealed {
		return nil, fmt.Errorf("operation forbidden: KeyStore is currently SEALED")
	}

	entries, ok := m.store.Keys[name]
	if !ok || len(entries) == 0 {
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

	if m.Sealed {
		return 0
	}

	entries, ok := m.store.Keys[name]
	if !ok || len(entries) == 0 {
		return 0
	}
	return entries[len(entries)-1].Version
}

func (m *Manager) GenerateKey(name string) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.Sealed {
		return 0, fmt.Errorf("operation forbidden: KeyStore is currently SEALED")
	}

	return m.generateKeyNoLock(name)
}

func (m *Manager) generateKeyNoLock(name string) (int, error) {
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
