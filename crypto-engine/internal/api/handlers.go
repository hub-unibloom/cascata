package api

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/hub-unibloom/cascata/crypto-engine/internal/crypto"
	"github.com/hub-unibloom/cascata/crypto-engine/internal/keystore"
)

type Router struct {
	Manager        *keystore.Manager
	InternalSecret string
}

type EncryptRequest struct {
	Key       string   `json:"key"`
	Plaintext string   `json:"plaintext"` // Base64
	Items     []string `json:"items,omitempty"`
}

type DecryptRequest struct {
	Ciphertext string   `json:"ciphertext"`
	Items      []string `json:"items,omitempty"`
}

func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	// Middleware: Auth (Health check is public for internal orchestration)
	if req.URL.Path != "/v1/health" && req.Header.Get("X-Crypto-Auth") != r.InternalSecret {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/encrypt", r.handleEncrypt)
	mux.HandleFunc("/v1/decrypt", r.handleDecrypt)
	mux.HandleFunc("/v1/encrypt-batch", r.handleEncryptBatch)
	mux.HandleFunc("/v1/decrypt-batch", r.handleDecryptBatch)
	mux.HandleFunc("/v1/keys/rotate", r.handleRotateKey)
	mux.HandleFunc("/v1/health", r.handleHealth)
	
	mux.ServeHTTP(w, req)
}

func (r *Router) handleEncrypt(w http.ResponseWriter, req *http.Request) {
	var body EncryptRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "Invalid body", http.StatusBadRequest)
		return
	}

	plaintext, err := base64.StdEncoding.DecodeString(body.Plaintext)
	if err != nil {
		http.Error(w, "Invalid base64 plaintext", http.StatusBadRequest)
		return
	}

	keyName := body.Key
	version := r.Manager.GetLatestVersion(keyName)
	if version == 0 {
		// Auto-generate key if it doesn't exist (Synergy: less manual config)
		version, _ = r.Manager.GenerateKey(keyName)
	}

	key, err := r.Manager.GetKey(keyName, version)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	ciphertext, err := crypto.EncryptAESGCM(plaintext, key)
	if err != nil {
		http.Error(w, "Encryption failed", http.StatusInternalServerError)
		return
	}

	// CSE:V1:KEY:VERSION:BASE64
	final := fmt.Sprintf("cse:v1:%s:%d:%s", keyName, version, base64.StdEncoding.EncodeToString(ciphertext))
	json.NewEncoder(w).Encode(map[string]string{"ciphertext": final})
}

func (r *Router) handleDecrypt(w http.ResponseWriter, req *http.Request) {
	var body DecryptRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "Invalid body", http.StatusBadRequest)
		return
	}

	plaintext, err := r.decryptOne(body.Ciphertext)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(map[string]string{"plaintext": base64.StdEncoding.EncodeToString(plaintext)})
}

func (r *Router) handleEncryptBatch(w http.ResponseWriter, req *http.Request) {
	var body EncryptRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "Invalid body", http.StatusBadRequest)
		return
	}
	
	keyName := body.Key
	version := r.Manager.GetLatestVersion(keyName)
	if version == 0 {
		var err error
		version, err = r.Manager.GenerateKey(keyName)
		if err != nil {
			http.Error(w, "Key generation failed", http.StatusInternalServerError)
			return
		}
	}
	key, err := r.Manager.GetKey(keyName, version)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	results := make([]string, len(body.Items))
	for i, ptBase64 := range body.Items {
		pt, err := base64.StdEncoding.DecodeString(ptBase64)
		if err != nil {
			results[i] = ""
			continue
		}
		ct, err := crypto.EncryptAESGCM(pt, key)
		if err != nil {
			results[i] = ""
			continue
		}
		results[i] = fmt.Sprintf("cse:v1:%s:%d:%s", keyName, version, base64.StdEncoding.EncodeToString(ct))
	}

	json.NewEncoder(w).Encode(map[string][]string{"items": results})
}

func (r *Router) handleDecryptBatch(w http.ResponseWriter, req *http.Request) {
	var body DecryptRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "Invalid body", http.StatusBadRequest)
		return
	}

	results := make([]string, len(body.Items))
	for i, ct := range body.Items {
		pt, err := r.decryptOne(ct)
		if err != nil {
			results[i] = ""
		} else {
			results[i] = base64.StdEncoding.EncodeToString(pt)
		}
	}
	json.NewEncoder(w).Encode(map[string][]string{"items": results})
}

func (r *Router) decryptOne(ctStr string) ([]byte, error) {
	parts := strings.Split(ctStr, ":")
	if len(parts) != 5 || parts[0] != "cse" || parts[1] != "v1" {
		return nil, fmt.Errorf("invalid ciphertext format")
	}

	keyName := parts[2]
	var version int
	fmt.Sscanf(parts[3], "%d", &version)
	
	ctRaw, err := base64.StdEncoding.DecodeString(parts[4])
	if err != nil { return nil, err }

	key, err := r.Manager.GetKey(keyName, version)
	if err != nil { return nil, err }

	return crypto.DecryptAESGCM(ctRaw, key)
}

func (r *Router) handleHealth(w http.ResponseWriter, req *http.Request) {
	// Pro-grade: Verificar se o manager está respondendo
	if r.Manager == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{"status": "error", "message": "Manager not initialized"})
		return
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "ok",
		"version": "1.0.0",
		"engine":  "go-cse-v1",
	})
}

type RotateKeyRequest struct {
	Key string `json:"key"`
}

func (r *Router) handleRotateKey(w http.ResponseWriter, req *http.Request) {
	var body RotateKeyRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "Invalid body", http.StatusBadRequest)
		return
	}

	newVersion, err := r.Manager.GenerateKey(body.Key)
	if err != nil {
		http.Error(w, "Key rotation failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(map[string]int{"new_version": newVersion})
}
