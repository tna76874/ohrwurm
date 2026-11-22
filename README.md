# 🐛 Ohrwurm

Verteilte, Ende-zu-Ende-verschlüsselte Konferenz-Transkription im Browser.

- **Audio verlässt nie das Gerät.** Whisper läuft im Browser (WebGPU oder WASM). Nur Text wird gesendet.
- **Der Server ist nur Vermittler.** Er sieht ausschließlich Chiffrat, Peer-IDs und öffentliche Schlüssel.
- **Symmetrische Administration.** Jedes Gerät nutzt dieselbe Web-App. Wer eine Sitzung startet, ist Host. Das Host-Gerät hält das vollständige Protokoll.
- **Gesprächsbutton.** Das Mikrofon ist standardmäßig aus. Beim Ausschalten wird der Audio-Track beendet, die Mikrofonanzeige des Browsers erlischt.
- **Protokoll und KI-Zusammenfassung.** Das Protokoll entsteht auf dem Host-Gerät, mit Tagesordnungspunkten und Entfernung von Doppelungen. Die Zusammenfassung erstellt ein LLM auf `localhost` oder im Firmennetz (OpenAI-kompatibel).

```
 Teilnehmer-Browser                        Relay (Go, ~1 Binary)                 Host-Browser
 ┌──────────────────────┐                 ┌──────────────────────┐            ┌─────────────────────────┐
 │ Mikro → VAD (Worklet) │                 │ OIDC-Prüfung         │            │ entschlüsseln           │
 │ → Whisper (Worker)    │  Chiffrat only  │ Sessions / Peer-IDs  │  Chiffrat  │ → IndexedDB             │
 │ → AES-GCM verschlüss. ├────────────────►│ Puffer, wenn offline ├───────────►│ → Merge / TOPs          │
 │ → Outbox (IndexedDB)  │◄────── Acks ────┤ statische Web-App    │◄── Acks ───┤ → LLM (localhost/Netz)  │
 └──────────────────────┘                 └──────────────────────┘            │ → Export (MD/JSON)      │
                                                                               └─────────────────────────┘
```

## Schnellstart

Voraussetzung auf dem Host: **Docker** (inkl. `docker compose`) und `make`. Alles andere läuft in Containern.

```sh
make models     # Whisper-Modelle (base, small) nach ./models laden, einmalig
make run        # bauen und mit Dev-Anmeldung starten → https://localhost:8443
make run-oidc   # stattdessen mit Dex als OIDC-Provider (anna@example.com / password)
make stop
```

Das Dev-Zertifikat ist selbstsigniert und muss im Browser einmal akzeptiert werden. HTTPS ist Pflicht, weil Browser das Mikrofon nur in sicheren Kontexten freigeben.

### Test im lokalen Netz mit Dex und Dummy-Konten

```sh
make run-lan                          # LAN-IP wird automatisch ermittelt
make run-lan LAN_HOST=192.168.1.20    # oder explizit (IP oder Hostname)
make stop-lan
```

Caddy terminiert TLS und stellt Relay und Dex unter **einem** Origin bereit: `https://<LAN_HOST>:8443`, Dex unter `/dex`. Deshalb muss jedes Gerät das selbstsignierte Zertifikat nur einmal akzeptieren. Danach funktionieren Mikrofon, Anmeldung und WebSocket.

| Konto | Passwort |
|---|---|
| `moderation@example.com`, `anna@…`, `ben@…`, `clara@…`, `david@…`, `emma@…`, `tisch1@…`, `tisch2@example.com` | `password` |

Ein typischer Testablauf:
1. Am Laptop als `moderation@example.com` anmelden und eine Sitzung starten.
2. Den QR-Code mit den Handys scannen und dort mit anderen Konten anmelden.
3. Auf den Handys „Antippen zum Sprechen“ nutzen. Der Text erscheint am Laptop.

Hinweise:
- **Firewall:** Port 8443 muss im LAN erreichbar sein.
- **Ollama auf dem Host-Laptop:** Ollama mit `OLLAMA_ORIGINS=https://<LAN_HOST>:8443` starten.
- **Zertifikat:** Ändert sich die LAN-IP, erzeugt `make run-lan` das Zertifikat automatisch neu.

### Automatischer Browser-Test

```sh
make run && make e2e   # Playwright/Chromium im Container mit synthetischer Sprache als Fake-Mikrofon
```

## Make-Ziele

| Ziel | Zweck |
|---|---|
| `make bootstrap` | Lockfiles (`package-lock.json`, `go.sum`) im Container erzeugen. Nur nach Änderungen an Abhängigkeiten, Ergebnis committen |
| `make check` | TypeScript-Typprüfung, `go vet` und `go test` |
| `make image` | Laufzeit-Image `ohrwurm:dev` (scratch, statisches Binary mit eingebettetem Client) |
| `make build` | `check` und `image` |
| `make dist` | Statisches Binary nach `dist/ohrwurm-relay` |
| `make models` | Modelle laden (`MODELS="onnx-community/whisper-small …"`) |
| `make certs` | Dev-Zertifikat (`SAN=…`) |
| `make run` / `run-oidc` / `stop` / `logs` | Betrieb über `compose.yaml` |
| `make run-lan` / `stop-lan` / `logs-lan` | LAN-Test mit Dex und Caddy (`compose.lan.yaml`) |
| `make e2e` | Browser-Test gegen `https://localhost:8443` |

Die Pipeline ist komplett im [Dockerfile](Dockerfile) definiert: `client-deps → client-check/client-build → relay-deps → relay-test/relay-build → runtime`.

Das Ergebnis ist **ein einziges statisches Binary**: Der gebaute Client wird per `go:embed` eingebettet. Das Image (`FROM scratch`) enthält nur dieses Binary und die CA-Zertifikate. Die Whisper-Modelle sind bewusst nicht enthalten, weil sie mehrere hundert MB groß sind. Sie werden als Volume nach `/models` eingebunden.

### GitHub Actions

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) nutzt dieselben Dockerfile-Stufen wie `make`:

- **Pull Request:** prüfen (`client-check`, `relay-test`) und das Image bauen, ohne es zu veröffentlichen.
- **Push auf `main`:** zusätzlich das Image nach `ghcr.io/<owner>/ohrwurm:main` pushen, für amd64 und arm64.
- **Tag `v1.2.3`:** Image mit den Tags `1.2.3` und `1.2` sowie ein GitHub-Release mit den Binaries `ohrwurm-relay-linux-{amd64,arm64}` und `SHA256SUMS`.

## Konfiguration (Relay)

| Variable | Standard | Bedeutung |
|---|---|---|
| `OHRWURM_ADDR` | `:8443` | Listen-Adresse |
| `OHRWURM_TLS_CERT` / `OHRWURM_TLS_KEY` | – | TLS. Ohne diese Variablen läuft HTTP (dann nur hinter TLS-Proxy oder auf localhost sinnvoll) |
| `OHRWURM_AUTH` | `oidc` | `oidc` oder `dev` (nur Tests: freie Namenswahl) |
| `OHRWURM_OIDC_ISSUER` | – | Issuer-URL, so wie der Browser sie sieht |
| `OHRWURM_OIDC_INTERNAL_URL` | – | optional: Adresse, unter der der Relay den IdP erreicht (z. B. im Docker-Netz) |
| `OHRWURM_OIDC_CLIENT_ID` | – | öffentlicher Client mit PKCE, Redirect-URI `https://<host>/` |
| `OHRWURM_OIDC_SCOPES` | `openid profile email` | bei Dex `offline_access` ergänzen, damit Refresh-Tokens ausgegeben werden |
| `OHRWURM_LLM_ORIGINS` | `http://localhost:11434 http://127.0.0.1:11434` | Origins, die der Browser für LLM-Aufrufe nutzen darf. Wird als CSP `connect-src` erzwungen |
| `OHRWURM_MODELS_DIR` | `/models` | Verzeichnis mit `<org>/<modell>/…` |
| `OHRWURM_SESSION_TTL` | `24h` | Sessions ohne Aktivität werden danach verworfen |

**Authentik (Produktion):** Lege einen OAuth2/OpenID-Provider mit dem Client-Typ *public* an, Redirect-URI `https://<host>/`. Dann setzt du:
- `OHRWURM_OIDC_ISSUER=https://auth.example.org/application/o/<slug>/`
- `OHRWURM_OIDC_CLIENT_ID=<client-id>`
- `OHRWURM_OIDC_SCOPES="openid profile email offline_access"`

**Ollama als LLM:** Damit der Browser Ollama aufrufen darf, startest du es mit `OLLAMA_ORIGINS=https://<ohrwurm-host>`. Im Host-Gerät trägst du als Endpunkt `http://localhost:11434/v1` ein.

## Sicherheitsmodell

1. **Schlüssel.** Der Host erzeugt beim Start ein ECDH-P-256-Schlüsselpaar. Der private Schlüssel ist nicht exportierbar und liegt in IndexedDB.
2. **Einladung.** Der Einladungslink bzw. QR-Code enthält die Session-ID und den **Fingerprint** des Host-Schlüssels im URL-Fragment. Das Fragment wird nie an den Server gesendet. Teilnehmer prüfen den Schlüssel, den der Relay liefert, gegen diesen Fingerprint. So kann der Relay keinen eigenen Schlüssel unterschieben.
3. **Verschlüsselung.** Teilnehmer und Host berechnen per ECDH und HKDF-SHA-256 einen gemeinsamen AES-256-GCM-Schlüssel. Die AAD bindet Session, Peer und Richtung.
4. **Identität.** Der Relay prüft das OIDC-ID-Token. Zusätzlich schickt der Teilnehmer sein Token verschlüsselt an den Host, der es selbst gegen das JWKS des IdP prüft. In der Geräteliste erscheint das als „IdP-geprüft“.
5. **Relay-Härtung.**
   - Es werden nur Text-Frames angenommen. Binärframes, also z. B. Audio, führen zum Verbindungsabbruch.
   - `data` muss base64url sein.
   - Rate-Limit und Größenlimits greifen.
   - Teilnehmer können nur an den Host senden.
   - Die CSP erlaubt Verbindungen nur zum eigenen Server, zum IdP und zu den freigegebenen LLM-Origins.
6. **Ausfallsicherheit.** Teilnehmer halten Beiträge in einer Outbox, bis der Host den Empfang bestätigt. Ist der Host offline, puffert der Relay das Chiffrat im RAM.

**Was der Relay sieht:**
- wer wann einer Session beitritt,
- Zeitpunkt und Größe verschlüsselter Nachrichten.

Inhalte sieht er nicht.

## Grenzen (Stand MVP)

- Qualität der Spracherkennung: Whisper base und small sind auf Deutsch brauchbar, aber nicht perfekt. Mit WebGPU ist `small` auf Laptops gut nutzbar, Handys schaffen eher `base`.
- Überlappende Sprache wird nicht getrennt. Bei Tischgeräten wählt man die sprechende Person per Namensfeld.
- Die Sessions auf dem Relay liegen nur im RAM. Ein Neustart des Relays beendet laufende Sessions, die Daten bleiben auf den Geräten.
- Es gibt noch keinen Co-Host, keine Abstimmungen und keine Live-Ansicht des Gesamtprotokolls für Teilnehmer.

## Projektstruktur

```
relay/    Go: OIDC-Prüfung, WebSocket-Relay, statische Auslieferung (eine Abhängigkeit: coder/websocket)
client/   TypeScript/Vite, ohne UI-Framework
  src/asr.worker.ts   Whisper über transformers.js
  public/worklet.js   Resampling und Sprachsegmentierung (AudioWorklet)
  src/crypto.ts       ECDH/HKDF/AES-GCM
  src/host.ts         Host: Empfang, Merge, TOPs, LLM, Export
  src/participant.ts  Teilnehmer: Outbox, Acks, Zurückziehen
dev/dex/  Test-IdP-Konfiguration
scripts/  Modell-Download
```
