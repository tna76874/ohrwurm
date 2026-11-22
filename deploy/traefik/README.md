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
3. **Netzwerk** (einmalig, falls noch nicht vorhanden):
   ```sh
   docker network create traefik
   ```
4. **Starten.** Beim ersten Start lädt der Dienst `models` die Whisper-Modelle (base und small, ca. 1 GB) nach `./models` und beendet sich. Erst danach startet Ohrwurm. Spätere Starts prüfen nur kurz, ob alles da ist.
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
- **Daten:** Der Server speichert nichts. Der Ordner `./models` enthält nur die Whisper-Modelle, die Protokolle liegen auf den Geräten.
- **Updates:**
  ```sh
  docker compose pull && docker compose up -d
  ```
  Laufende Sitzungen überstehen den Neustart, weil sich die Geräte danach untereinander abgleichen.

## Fehlersuche

**„Die Spracherkennung ist auf dem Server noch nicht eingerichtet“:** Ohrwurm findet keine Modelle in `/models`.

1. Log des Download-Diensts ansehen:
   ```sh
   docker compose logs models
   ```
   Typische Ursachen sind kein Internetzugang oder ein blockiertes `huggingface.co`.
2. Log von Ohrwurm ansehen:
   ```sh
   docker compose logs ohrwurm
   ```
   Beim Start erscheint entweder „Whisper-Modelle gefunden“ oder eine Warnung mit dem erwarteten Pfad.
3. Struktur prüfen:
   ```sh
   ls ./models/onnx-community/*/config.json
   ```
   Erwartet wird `./models/<org>/<modell>/…`, also z. B. `./models/onnx-community/whisper-base/config.json` und `…/onnx/*.onnx`.
4. **Server ohne Internet:** Die Modelle auf einem anderen Rechner mit `make models` laden und den Ordner `models/` nach `./models` kopieren. Der Download-Dienst erkennt die vorhandenen Dateien und überspringt den Download.

Die Dateien in `./models` gehören nach dem Download dem Container-Nutzer. Zum Löschen brauchst du `sudo` oder einen Container.

## Zusätzliche Traefik-Middlewares

Ohrwurm begrenzt selbst schon:
- Nachrichtengröße: 256 KB pro WebSocket-Nachricht,
- Nachrichtenrate pro Verbindung,
- Uploads: Es gibt keine.

Bei eigenen Middlewares bitte beachten:

| Middleware | Empfehlung |
|---|---|
| `ratelimit` | Unkritisch, wenn großzügig gesetzt, z. B. `average=20`, `burst=50`. Der Sync läuft über die WebSocket-Verbindung und zählt nicht als HTTP-Anfrage |
| `inflightreq` | **Vorsicht:** Jede offene WebSocket-Verbindung zählt dauerhaft als laufende Anfrage. Teilen sich viele Geräte eine IP, etwa hinter Firmen-NAT oder im Gäste-WLAN, wird ab dem Limit niemand mehr verbunden. Weglassen oder sehr hoch setzen |
| `buffering` | **Weglassen.** Ohrwurm nimmt keine Uploads an. Die Middleware puffert außerdem Antworten, bei den mehrere hundert MB großen Modelldateien und bei WebSockets ist das kontraproduktiv |
