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
	Tarpit         *crypto.Tarpit
	mux            *http.ServeMux
}

func NewRouter(manager *keystore.Manager, internalSecret string, tarpit *crypto.Tarpit) *Router {
	r := &Router{
		Manager:        manager,
		InternalSecret: internalSecret,
		Tarpit:         tarpit,
		mux:            http.NewServeMux(),
	}

	r.mux.HandleFunc("/v1/encrypt", r.handleEncrypt)
	r.mux.HandleFunc("/v1/decrypt", r.handleDecrypt)
	r.mux.HandleFunc("/v1/encrypt-batch", r.handleEncryptBatch)
	r.mux.HandleFunc("/v1/decrypt-batch", r.handleDecryptBatch)
	r.mux.HandleFunc("/v1/keys/rotate", r.handleRotateKey)
	r.mux.HandleFunc("/v1/sys/status", r.handleStatus)
	r.mux.HandleFunc("/v1/sys/unseal", r.handleUnseal)
	r.mux.HandleFunc("/v1/sys/rekey", r.handleRekey)
	r.mux.HandleFunc("/v1/health", r.handleHealth)

	return r
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
	// Middleware: Auth (Health check is public para orquestração interna)
	if req.URL.Path != "/v1/health" && req.Header.Get("X-Crypto-Auth") != r.InternalSecret {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	r.mux.ServeHTTP(w, req)
}

func (r *Router) handleEncrypt(w http.ResponseWriter, req *http.Request) {
	var body EncryptRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "Invalid body", http.StatusBadRequest)
		return
	}

	if r.Manager.IsSealed() {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{"error": "engine_sealed"})
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

	final := fmt.Sprintf("cse:v1:%s:%d:%s", keyName, version, base64.StdEncoding.EncodeToString(ciphertext))
	json.NewEncoder(w).Encode(map[string]string{"ciphertext": final})
}

func (r *Router) handleDecrypt(w http.ResponseWriter, req *http.Request) {
	var body DecryptRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "Invalid body", http.StatusBadRequest)
		return
	}

	if r.Manager.IsSealed() {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{"error": "engine_sealed"})
		return
	}

	r.Tarpit.RecordAndDelay()

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

	if r.Manager.IsSealed() {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{"error": "engine_sealed"})
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

	if r.Manager.IsSealed() {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{"error": "engine_sealed"})
		return
	}

	for range body.Items {
		r.Tarpit.RecordAndDelay()
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

	if r.Manager.IsSealed() {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{"error": "engine_sealed"})
		return
	}

	newVersion, err := r.Manager.GenerateKey(body.Key)
	if err != nil {
		http.Error(w, "Key rotation failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(map[string]int{"new_version": newVersion})
}

func (r *Router) handleStatus(w http.ResponseWriter, req *http.Request) {
	json.NewEncoder(w).Encode(map[string]interface{}{
		"sealed":  r.Manager.IsSealed(),
		"version": "1.0.0",
		"engine":  "go-cse-v1-sovereign",
	})
}

type UnsealRequest struct {
	MasterSecret string `json:"master_secret"`
}

func (r *Router) handleUnseal(w http.ResponseWriter, req *http.Request) {
	var body UnsealRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "Invalid body", http.StatusBadRequest)
		return
	}

	err := r.Manager.Unlock(body.MasterSecret)
	if err != nil {
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

type RekeyRequest struct {
	OldMasterSecret string `json:"old_master_secret"`
	NewMasterSecret string `json:"new_master_secret"`
}

func (r *Router) handleRekey(w http.ResponseWriter, req *http.Request) {
	var body RekeyRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "Invalid body", http.StatusBadRequest)
		return
	}

	if body.OldMasterSecret == "" || body.NewMasterSecret == "" {
		http.Error(w, "Old and new secrets are required", http.StatusBadRequest)
		return
	}

	err := r.Manager.Rekey(body.OldMasterSecret, body.NewMasterSecret)
	if err != nil {
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	json.NewEncoder(w).Encode(map[string]string{"success": "true", "message": "Master Secret rotated successfully. Store re-encrypted."})
}
