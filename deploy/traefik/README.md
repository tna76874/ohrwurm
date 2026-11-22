# Ohrwurm hinter Traefik mit externem Identity Provider

Dieses Beispiel betreibt Ohrwurm produktiv hinter [Traefik v3](https://doc.traefik.io/traefik/). Die Anmeldung läuft über einen vorhandenen OIDC-Provider wie Authentik, Keycloak oder Entra ID.

```
Browser ──HTTPS──► Traefik ──HTTP──► ohrwurm:8080 (scratch, read-only)
   │                                     │
   └──── OIDC-Login (PKCE) ────► IdP ◄───┘ ID-Token-Prüfung (Discovery/JWKS)
```

## Einrichtung

1. **Client beim IdP anlegen.**
   - Typ: öffentlich (public), mit PKCE (S256) und *ohne* Client-Secret.
   - Redirect-URI und Logout-Redirect: `https://<OHRWURM_HOST>/`
   - Web-Origin / CORS: `https://<OHRWURM_HOST>`. Die App holt das Token direkt im Browser.
   - Scopes: `openid profile email offline_access`. Mit `offline_access` gibt es Refresh-Tokens, sodass Sitzungen lange laufen können.
2. **Konfiguration.**
   ```sh
   cp .env.example .env
   $EDITOR .env          # OHRWURM_HOST, OIDC_ISSUER, OIDC_CLIENT_ID, LLM_ORIGINS …
   ```
3. **Netzwerk und Modelle** (einmalig):
   ```sh
   docker network create traefik                     # falls noch nicht vorhanden
   docker compose --profile setup run --rm models    # lädt Whisper base und small (~1 GB) ins Volume
   ```
4. **Starten.**
   ```sh
   docker compose up -d                       # mit bereits laufendem Traefik
   docker compose --profile traefik up -d     # oder mit dem mitgelieferten Traefik inkl. Let's Encrypt
   ```

## Was die Labels tun

| Label-Gruppe | Zweck |
|---|---|
| `routers.ohrwurm` | HTTPS-Router für `OHRWURM_HOST`, Zertifikat über `TRAEFIK_CERTRESOLVER` |
| `routers.ohrwurm-http` und `middlewares.ohrwurm-redirect` | Leitet HTTP dauerhaft auf HTTPS um |
| `middlewares.ohrwurm-hsts` | HSTS. CSP, COOP/COEP und weitere Sicherheits-Header setzt Ohrwurm selbst, weil sie vom IdP und den KI-Endpunkten abhängen. Bitte **nicht** in Traefik überschreiben |
| `middlewares.ohrwurm-compress` | Kompression für App und Texte |
| `services.ohrwurm.loadbalancer.*` | Backend-Port 8080, Host-Header durchreichen (nötig für die Origin-Prüfung der WebSockets), Healthcheck auf `/healthz` |

WebSockets (`/ws`) leitet Traefik automatisch weiter. Ohrwurm sendet alle 30 Sekunden einen Ping, das passt zum Idle-Timeout von Traefik.

## Hinweise

- **IdP intern unter anderer Adresse:** Erreicht der Ohrwurm-Container den IdP intern anders als die Browser, z. B. `http://authentik-server:9000/...`, setzt du `OIDC_INTERNAL_URL`. Die erwartete Issuer-URL bleibt `OIDC_ISSUER`.
- **KI-Helfer:** Erlaubt sind nur Adressen aus `LLM_ORIGINS`. Der Server setzt das als CSP durch.
  - `localhost`-Adressen bedeuten „KI-Programm auf dem eigenen Rechner“.
  - Firmen-Endpunkte brauchen HTTPS und müssen CORS für `https://<OHRWURM_HOST>` erlauben.
- **Daten:** Der Server speichert nichts. Das Volume `models` enthält nur die Whisper-Modelle, die Protokolle liegen auf den Geräten.
- **Updates:**
  ```sh
  docker compose pull && docker compose up -d
  ```
  Laufende Sitzungen überstehen den Neustart, weil sich die Geräte danach untereinander abgleichen.
