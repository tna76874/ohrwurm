package main

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func enc64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func pad32(b []byte) []byte {
	out := make([]byte, 32)
	copy(out[32-len(b):], b)
	return out
}

func TestOIDCVerify(t *testing.T) {
	rk, _ := rsa.GenerateKey(rand.Reader, 2048)
	ek, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)

	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(w).Encode(map[string]string{"issuer": srv.URL, "jwks_uri": srv.URL + "/jwks"})
		case "/jwks":
			_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{
				{"kty": "RSA", "kid": "r1", "use": "sig", "n": enc64(rk.N.Bytes()), "e": enc64(big.NewInt(int64(rk.E)).Bytes())},
				{"kty": "EC", "kid": "e1", "crv": "P-256", "x": enc64(pad32(ek.X.Bytes())), "y": enc64(pad32(ek.Y.Bytes()))},
			}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	sign := func(alg, kid string, claims map[string]any) string {
		hb, _ := json.Marshal(map[string]string{"alg": alg, "kid": kid, "typ": "JWT"})
		pb, _ := json.Marshal(claims)
		in := enc64(hb) + "." + enc64(pb)
		d := sha256.Sum256([]byte(in))
		var sig []byte
		if alg == "RS256" {
			sig, _ = rsa.SignPKCS1v15(rand.Reader, rk, crypto.SHA256, d[:])
		} else {
			r, s, _ := ecdsa.Sign(rand.Reader, ek, d[:])
			sig = append(pad32(r.Bytes()), pad32(s.Bytes())...)
		}
		return in + "." + enc64(sig)
	}
	now := time.Now().Unix()
	good := map[string]any{"iss": srv.URL, "aud": "ohrwurm", "sub": "u1", "name": "Anna", "exp": now + 300}
	with := func(k string, v any) map[string]any {
		c := map[string]any{}
		for kk, vv := range good {
			c[kk] = vv
		}
		c[k] = v
		return c
	}

	v := newOIDCVerifier(srv.URL, "ohrwurm", "")
	ctx := context.Background()

	for _, alg := range []struct{ alg, kid string }{{"RS256", "r1"}, {"ES256", "e1"}} {
		id, err := v.Verify(ctx, sign(alg.alg, alg.kid, good))
		if err != nil || id.Sub != "u1" || id.Name != "Anna" {
			t.Fatalf("%s: gültiges Token abgelehnt: %v %+v", alg.alg, err, id)
		}
	}
	if _, err := v.Verify(ctx, sign("RS256", "r1", with("aud", []string{"x", "ohrwurm"}))); err != nil {
		t.Fatalf("aud-Liste abgelehnt: %v", err)
	}

	bad := map[string]string{
		"falsche aud":   sign("RS256", "r1", with("aud", "andere")),
		"abgelaufen":    sign("RS256", "r1", with("exp", now-3600)),
		"falscher iss":  sign("RS256", "r1", with("iss", "https://evil.example")),
		"ohne sub":      sign("RS256", "r1", with("sub", "")),
		"unbekannte kid": sign("RS256", "nope", good),
	}
	tampered := sign("RS256", "r1", good)
	parts := strings.Split(tampered, ".")
	pb, _ := json.Marshal(with("sub", "admin"))
	bad["manipuliert"] = parts[0] + "." + enc64(pb) + "." + parts[2]
	bad["alg none"] = enc64([]byte(`{"alg":"none","kid":"r1"}`)) + "." + parts[1] + "."

	for name, tok := range bad {
		if _, err := v.Verify(ctx, tok); err == nil {
			t.Errorf("%s: Token fälschlich akzeptiert", name)
		}
	}
}

func TestDevVerifier(t *testing.T) {
	if id, err := (devVerifier{}).Verify(context.Background(), "dev: Anna "); err != nil || id.Name != "Anna" {
		t.Fatalf("dev-Name abgelehnt: %v", err)
	}
	for _, tok := range []string{"", "Anna", "dev:", "dev:" + strings.Repeat("x", 65)} {
		if _, err := (devVerifier{}).Verify(context.Background(), tok); err == nil {
			t.Errorf("%q fälschlich akzeptiert", tok)
		}
	}
}
