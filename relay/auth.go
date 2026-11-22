package main

import (
	"context"
	"crypto"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type Identity struct {
	Sub  string `json:"sub"`
	Name string `json:"name"`
}

type Verifier interface {
	Verify(ctx context.Context, token string) (Identity, error)
}

// devVerifier akzeptiert "dev:<Name>". Nur für lokale Tests.
type devVerifier struct{}

func (devVerifier) Verify(_ context.Context, token string) (Identity, error) {
	name, ok := strings.CutPrefix(token, "dev:")
	name = strings.TrimSpace(name)
	if !ok || name == "" || utf8.RuneCountInString(name) > 64 {
		return Identity{}, errors.New("ungültiger Dev-Name")
	}
	return Identity{Sub: "dev:" + name, Name: name}, nil
}

// oidcVerifier prüft ID-Tokens (RS256, PS256, ES256) gegen das JWKS des IdP.
// Bewusst ohne externe Abhängigkeiten.
type oidcVerifier struct {
	issuer, clientID, discoveryBase string
	client                          *http.Client
	now                             func() time.Time

	mu        sync.Mutex
	jwksURI   string
	keys      map[string]crypto.PublicKey
	lastFetch time.Time
}

func newOIDCVerifier(issuer, clientID, internalURL string) *oidcVerifier {
	base := issuer
	if internalURL != "" {
		base = internalURL
	}
	return &oidcVerifier{
		issuer: strings.TrimRight(issuer, "/"), clientID: clientID, discoveryBase: strings.TrimRight(base, "/"),
		client: &http.Client{Timeout: 10 * time.Second}, now: time.Now, keys: map[string]crypto.PublicKey{},
	}
}

func (v *oidcVerifier) getJSON(ctx context.Context, url string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := v.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out)
}

// refresh lädt Discovery-Dokument (einmalig) und JWKS. Aufruf nur unter v.mu.
func (v *oidcVerifier) refresh(ctx context.Context) error {
	if v.jwksURI == "" {
		var doc struct {
			Issuer  string `json:"issuer"`
			JWKSURI string `json:"jwks_uri"`
		}
		if err := v.getJSON(ctx, v.discoveryBase+"/.well-known/openid-configuration", &doc); err != nil {
			return fmt.Errorf("OIDC-Discovery: %w", err)
		}
		if strings.TrimRight(doc.Issuer, "/") != v.issuer {
			return fmt.Errorf("Issuer im Discovery-Dokument (%q) passt nicht zu %q", doc.Issuer, v.issuer)
		}
		if doc.JWKSURI == "" {
			return errors.New("Discovery-Dokument ohne jwks_uri")
		}
		// Ist der IdP intern unter anderer Adresse erreichbar (z. B. im
		// Docker-Netz), zeigt jwks_uri meist auf die öffentliche Adresse.
		if v.discoveryBase != v.issuer && strings.HasPrefix(doc.JWKSURI, v.issuer) {
			doc.JWKSURI = v.discoveryBase + strings.TrimPrefix(doc.JWKSURI, v.issuer)
		}
		v.jwksURI = doc.JWKSURI
	}
	var set struct {
		Keys []jwk `json:"keys"`
	}
	v.lastFetch = v.now()
	if err := v.getJSON(ctx, v.jwksURI, &set); err != nil {
		return fmt.Errorf("JWKS: %w", err)
	}
	keys := map[string]crypto.PublicKey{}
	for _, k := range set.Keys {
		if k.Use != "" && k.Use != "sig" {
			continue
		}
		if pk, err := k.publicKey(); err == nil {
			keys[k.Kid] = pk
		}
	}
	v.keys = keys
	return nil
}

func (v *oidcVerifier) key(ctx context.Context, kid string) (crypto.PublicKey, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	lookup := func() (crypto.PublicKey, bool) {
		if k, ok := v.keys[kid]; ok {
			return k, true
		}
		if kid == "" && len(v.keys) == 1 {
			for _, k := range v.keys {
				return k, true
			}
		}
		return nil, false
	}
	age := v.now().Sub(v.lastFetch)
	if k, ok := lookup(); ok && age < 24*time.Hour {
		return k, nil
	}
	// Unbekannte kid: höchstens alle 30 s neu laden (Schutz vor Abfrage-Fluten).
	if !v.lastFetch.IsZero() && age < 30*time.Second {
		if k, ok := lookup(); ok {
			return k, nil
		}
		return nil, errors.New("unbekannter Signaturschlüssel")
	}
	if err := v.refresh(ctx); err != nil {
		return nil, err
	}
	if k, ok := lookup(); ok {
		return k, nil
	}
	return nil, errors.New("unbekannter Signaturschlüssel")
}

func b64(s string) ([]byte, error) { return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "=")) }

func (v *oidcVerifier) Verify(ctx context.Context, token string) (Identity, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return Identity{}, errors.New("kein JWT")
	}
	var hdr struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	hb, err := b64(parts[0])
	if err != nil || json.Unmarshal(hb, &hdr) != nil {
		return Identity{}, errors.New("JWT-Header ungültig")
	}
	sig, err := b64(parts[2])
	if err != nil {
		return Identity{}, errors.New("JWT-Signatur ungültig")
	}
	key, err := v.key(ctx, hdr.Kid)
	if err != nil {
		return Identity{}, err
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	switch hdr.Alg {
	case "RS256", "PS256":
		rk, ok := key.(*rsa.PublicKey)
		if !ok {
			return Identity{}, errors.New("Schlüsseltyp passt nicht zu alg")
		}
		if hdr.Alg == "RS256" {
			err = rsa.VerifyPKCS1v15(rk, crypto.SHA256, digest[:], sig)
		} else {
			err = rsa.VerifyPSS(rk, crypto.SHA256, digest[:], sig, nil)
		}
		if err != nil {
			return Identity{}, errors.New("Signatur ungültig")
		}
	case "ES256":
		ek, ok := key.(*ecdsa.PublicKey)
		if !ok || len(sig) != 64 {
			return Identity{}, errors.New("Schlüsseltyp passt nicht zu alg")
		}
		r, s := new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])
		if !ecdsa.Verify(ek, digest[:], r, s) {
			return Identity{}, errors.New("Signatur ungültig")
		}
	default:
		return Identity{}, fmt.Errorf("nicht unterstützter Algorithmus %q", hdr.Alg)
	}

	pb, err := b64(parts[1])
	if err != nil {
		return Identity{}, errors.New("JWT-Payload ungültig")
	}
	var cl struct {
		Iss               string          `json:"iss"`
		Sub               string          `json:"sub"`
		Aud               json.RawMessage `json:"aud"`
		Exp               float64         `json:"exp"`
		Nbf               float64         `json:"nbf"`
		Name              string          `json:"name"`
		PreferredUsername string          `json:"preferred_username"`
		Email             string          `json:"email"`
	}
	if err := json.Unmarshal(pb, &cl); err != nil {
		return Identity{}, errors.New("JWT-Payload ungültig")
	}
	if strings.TrimRight(cl.Iss, "/") != v.issuer {
		return Identity{}, errors.New("falscher Issuer")
	}
	if !audContains(cl.Aud, v.clientID) {
		return Identity{}, errors.New("falsche Audience")
	}
	now := v.now().Unix()
	if cl.Exp == 0 || now > int64(cl.Exp)+60 {
		return Identity{}, errors.New("Token abgelaufen")
	}
	if cl.Nbf != 0 && now+60 < int64(cl.Nbf) {
		return Identity{}, errors.New("Token noch nicht gültig")
	}
	if cl.Sub == "" {
		return Identity{}, errors.New("Token ohne sub")
	}
	name := cl.Name
	for _, alt := range []string{cl.PreferredUsername, cl.Email, cl.Sub} {
		if name == "" {
			name = alt
		}
	}
	if utf8.RuneCountInString(name) > 64 {
		name = string([]rune(name)[:64])
	}
	return Identity{Sub: cl.Sub, Name: name}, nil
}

func audContains(raw json.RawMessage, want string) bool {
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return one == want
	}
	var many []string
	if json.Unmarshal(raw, &many) == nil {
		for _, a := range many {
			if a == want {
				return true
			}
		}
	}
	return false
}

type jwk struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Use string `json:"use"`
	N   string `json:"n"`
	E   string `json:"e"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

func (k jwk) publicKey() (crypto.PublicKey, error) {
	switch k.Kty {
	case "RSA":
		n, err1 := b64(k.N)
		e, err2 := b64(k.E)
		if err1 != nil || err2 != nil || len(n) < 256 || len(e) == 0 || len(e) > 4 {
			return nil, errors.New("RSA-Schlüssel ungültig")
		}
		return &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}, nil
	case "EC":
		if k.Crv != "P-256" {
			return nil, errors.New("nur P-256")
		}
		x, err1 := b64(k.X)
		y, err2 := b64(k.Y)
		if err1 != nil || err2 != nil || len(x) > 32 || len(y) > 32 {
			return nil, errors.New("EC-Schlüssel ungültig")
		}
		raw := make([]byte, 65)
		raw[0] = 4
		copy(raw[1+32-len(x):33], x)
		copy(raw[33+32-len(y):], y)
		if _, err := ecdh.P256().NewPublicKey(raw); err != nil { // Punkt liegt auf der Kurve?
			return nil, err
		}
		return &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}, nil
	}
	return nil, errors.New("unbekannter Schlüsseltyp")
}
