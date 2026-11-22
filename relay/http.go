package main

import (
	"embed"
	"encoding/json"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// web/ wird beim Docker-Build mit dem gebauten Client befüllt.
//
//go:embed all:web
var webFS embed.FS

type publicConfig struct {
	Auth       string   `json:"auth"`
	Issuer     string   `json:"issuer,omitempty"`
	ClientID   string   `json:"clientId,omitempty"`
	Scopes     string   `json:"scopes,omitempty"`
	LLMOrigins []string `json:"llmOrigins"`
	Models     []string `json:"models"`
}

func newRouter(cfg Config, hub *Hub) http.Handler {
	web, err := fs.Sub(webFS, "web")
	if err != nil {
		panic(err)
	}
	mux := http.NewServeMux()
	mux.Handle("GET /ws", hub)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("GET /api/config", func(w http.ResponseWriter, _ *http.Request) {
		pc := publicConfig{Auth: cfg.AuthMode, LLMOrigins: cfg.LLMOrigins, Models: listModels(cfg.ModelsDir)}
		if cfg.AuthMode == "oidc" {
			pc.Issuer, pc.ClientID, pc.Scopes = cfg.Issuer, cfg.ClientID, cfg.Scopes
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(pc)
	})
	mux.Handle("GET /models/", http.StripPrefix("/models/", modelsHandler(cfg.ModelsDir)))
	mux.Handle("GET /", spaHandler(web))
	return securityHeaders(cfg, mux)
}

// listModels findet Modelle in der Struktur <dir>/<org>/<name>/config.json.
func listModels(dir string) []string {
	out := []string{}
	orgs, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, org := range orgs {
		if !org.IsDir() || strings.HasPrefix(org.Name(), ".") {
			continue
		}
		names, _ := os.ReadDir(filepath.Join(dir, org.Name()))
		for _, n := range names {
			if !n.IsDir() {
				continue
			}
			if _, err := os.Stat(filepath.Join(dir, org.Name(), n.Name(), "config.json")); err == nil {
				out = append(out, org.Name()+"/"+n.Name())
			}
		}
	}
	sort.Strings(out)
	return out
}

func modelsHandler(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "" || strings.HasSuffix(r.URL.Path, "/") {
			http.NotFound(w, r) // keine Verzeichnislisten
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=86400")
		files.ServeHTTP(w, r)
	})
}

func spaHandler(web fs.FS) http.Handler {
	files := http.FileServerFS(web)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if p == "" || p == "index.html" {
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeFileFS(w, r, web, "index.html")
			return
		}
		if st, err := fs.Stat(web, p); err != nil || st.IsDir() {
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeFileFS(w, r, web, "index.html")
			return
		}
		if strings.HasPrefix(p, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}

var reHost = regexp.MustCompile(`^[A-Za-z0-9.\-:\[\]]{1,255}$`)

// securityHeaders erzwingt die Datenschutz-Zusage technisch: Der Browser darf
// nur mit diesem Server, dem IdP und den freigegebenen LLM-Endpunkten reden.
func securityHeaders(cfg Config, next http.Handler) http.Handler {
	idp := ""
	if cfg.AuthMode == "oidc" {
		idp, _ = parseOrigin(cfg.Issuer)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connect := []string{"'self'"}
		if reHost.MatchString(r.Host) {
			connect = append(connect, "wss://"+r.Host, "ws://"+r.Host)
		}
		if idp != "" {
			connect = append(connect, idp)
		}
		connect = append(connect, cfg.LLMOrigins...)
		csp := strings.Join([]string{
			"default-src 'self'",
			"script-src 'self' 'wasm-unsafe-eval'",
			"worker-src 'self' blob:",
			"connect-src " + strings.Join(connect, " "),
			"img-src 'self' data: blob:",
			"style-src 'self' 'unsafe-inline'",
			"object-src 'none'",
			"base-uri 'none'",
			"frame-ancestors 'none'",
			"form-action 'none'",
		}, "; ")
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Embedder-Policy", "require-corp")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "microphone=(self), camera=(), geolocation=()")
		next.ServeHTTP(w, r)
	})
}
