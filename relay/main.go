// Ohrwurm-Relay: vermittelt verschlüsselte Nachrichten zwischen Clients.
//
// Der Relay sieht niemals Klartext. Er kennt nur Sessions, Peer-IDs,
// öffentliche Schlüssel und undurchsichtige Chiffrat-Strings. Audio und
// Transkripte bleiben auf den Clients.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// version wird beim Build per -ldflags gesetzt.
var version = "dev"

type Config struct {
	Addr        string
	TLSCert     string
	TLSKey      string
	AuthMode    string // "oidc" | "dev"
	Issuer      string // erwarteter iss-Claim, auch vom Browser genutzt
	InternalURL string // optional: Basis-URL, unter der der Relay den IdP erreicht
	ClientID    string
	Scopes      string
	LLMOrigins  []string
	ModelsDir   string
	SessionTTL  time.Duration
}

func env(k, def string) string {
	if v, ok := os.LookupEnv(k); ok && v != "" {
		return v
	}
	return def
}

func loadConfig() (Config, error) {
	c := Config{
		Addr:        env("OHRWURM_ADDR", ":8443"),
		TLSCert:     os.Getenv("OHRWURM_TLS_CERT"),
		TLSKey:      os.Getenv("OHRWURM_TLS_KEY"),
		AuthMode:    env("OHRWURM_AUTH", "oidc"),
		Issuer:      strings.TrimRight(os.Getenv("OHRWURM_OIDC_ISSUER"), "/"),
		InternalURL: strings.TrimRight(os.Getenv("OHRWURM_OIDC_INTERNAL_URL"), "/"),
		ClientID:    os.Getenv("OHRWURM_OIDC_CLIENT_ID"),
		Scopes:      env("OHRWURM_OIDC_SCOPES", "openid profile email"),
		ModelsDir:   env("OHRWURM_MODELS_DIR", "/models"),
	}
	ttl, err := time.ParseDuration(env("OHRWURM_SESSION_TTL", "24h"))
	if err != nil {
		return c, fmt.Errorf("OHRWURM_SESSION_TTL: %w", err)
	}
	c.SessionTTL = ttl

	for _, o := range strings.Fields(env("OHRWURM_LLM_ORIGINS", "http://localhost:11434 http://127.0.0.1:11434 http://localhost:1234 http://127.0.0.1:1234")) {
		origin, err := parseOrigin(o)
		if err != nil {
			return c, fmt.Errorf("OHRWURM_LLM_ORIGINS: %w", err)
		}
		c.LLMOrigins = append(c.LLMOrigins, origin)
	}

	switch c.AuthMode {
	case "oidc":
		if c.Issuer == "" || c.ClientID == "" {
			return c, errors.New("OHRWURM_OIDC_ISSUER und OHRWURM_OIDC_CLIENT_ID sind im OIDC-Modus Pflicht")
		}
		if _, err := parseOrigin(c.Issuer); err != nil {
			return c, fmt.Errorf("OHRWURM_OIDC_ISSUER: %w", err)
		}
	case "dev":
	default:
		return c, fmt.Errorf("OHRWURM_AUTH muss 'oidc' oder 'dev' sein, nicht %q", c.AuthMode)
	}
	if (c.TLSCert == "") != (c.TLSKey == "") {
		return c, errors.New("OHRWURM_TLS_CERT und OHRWURM_TLS_KEY nur gemeinsam setzen")
	}
	return c, nil
}

// parseOrigin liefert scheme://host[:port] und lehnt alles ab, was in einer
// CSP-Direktive Schaden anrichten könnte.
func parseOrigin(s string) (string, error) {
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || strings.ContainsAny(u.Host, " ;,'\"") {
		return "", fmt.Errorf("ungültiger Origin %q", s)
	}
	return u.Scheme + "://" + u.Host, nil
}

// healthcheck prüft den laufenden Server (für Docker-HEALTHCHECK im scratch-Image,
// das weder Shell noch curl enthält): `ohrwurm-relay healthcheck`.
func healthcheck() int {
	addr := env("OHRWURM_ADDR", ":8443")
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	scheme := "http"
	client := &http.Client{Timeout: 3 * time.Second}
	if os.Getenv("OHRWURM_TLS_CERT") != "" {
		scheme = "https"
		// Nur lokale Erreichbarkeit prüfen; das Zertifikat lautet auf den öffentlichen Namen.
		client.Transport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}} //nolint:gosec
	}
	resp, err := client.Get(scheme + "://" + addr + "/healthz")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	cfg, err := loadConfig()
	if err != nil {
		log.Error("Konfiguration ungültig", "err", err)
		os.Exit(1)
	}

	var v Verifier
	if cfg.AuthMode == "dev" {
		log.Warn("DEV-ANMELDUNG AKTIV: Jeder kann sich mit beliebigem Namen anmelden. Nur für Tests!")
		v = devVerifier{}
	} else {
		v = newOIDCVerifier(cfg.Issuer, cfg.ClientID, cfg.InternalURL)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	hub := NewHub(v, cfg.SessionTTL, log)
	go hub.Janitor(ctx)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           newRouter(cfg, hub),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()

	log.Info("Ohrwurm-Relay startet", "version", version, "addr", cfg.Addr, "tls", cfg.TLSCert != "", "auth", cfg.AuthMode, "llmOrigins", cfg.LLMOrigins)
	if m := listModels(cfg.ModelsDir); len(m) == 0 {
		log.Warn("Keine Whisper-Modelle gefunden – die Spracherkennung ist nicht nutzbar", "dir", cfg.ModelsDir,
			"erwartet", cfg.ModelsDir+"/<org>/<modell>/config.json, z. B. onnx-community/whisper-base")
	} else {
		log.Info("Whisper-Modelle gefunden", "models", m)
	}
	if cfg.TLSCert != "" {
		err = srv.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey)
	} else {
		err = srv.ListenAndServe()
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("Server beendet", "err", err)
		os.Exit(1)
	}
}
