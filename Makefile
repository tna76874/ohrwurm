# Ohrwurm – alles läuft in Containern. Auf dem Host wird nur Docker benötigt.

DOCKER     ?= docker
COMPOSE    ?= $(DOCKER) compose
IMAGE      ?= ohrwurm
VERSION    ?= dev
NODE_IMAGE ?= node:22-alpine
GO_IMAGE   ?= golang:1.25-alpine
TOOL_IMAGE ?= alpine:3.20
PLAYWRIGHT_VERSION ?= 1.49.1
PLAYWRIGHT_IMAGE ?= mcr.microsoft.com/playwright:v$(PLAYWRIGHT_VERSION)-noble
E2E_BASE ?= https://localhost:8443

# Whisper-Modelle (ONNX, Hugging Face onnx-community)
MODELS ?= onnx-community/whisper-base onnx-community/whisper-small
# Hostnamen/IPs für das Dev-Zertifikat, z. B. SAN="DNS:localhost,IP:127.0.0.1,IP:192.168.1.20"
SAN    ?= DNS:localhost,IP:127.0.0.1
# Erlaubte KI-Endpunkte (Ollama, LM Studio), als CSP connect-src erzwungen
OHRWURM_LLM_ORIGINS ?= http://localhost:11434 http://127.0.0.1:11434 http://localhost:1234 http://127.0.0.1:1234
export OHRWURM_LLM_ORIGINS

UID := $(shell id -u)
GID := $(shell id -g)
BUILD := DOCKER_BUILDKIT=1 $(DOCKER) build --build-arg NODE_IMAGE=$(NODE_IMAGE) --build-arg GO_IMAGE=$(GO_IMAGE)

.DEFAULT_GOAL := help
.PHONY: help bootstrap lock tidy check test image build dist models certs run run-oidc stop logs clean e2e run-lan stop-lan logs-lan lan-prep lan-certs e2e-lan docs

help: ## Diese Hilfe
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  \033[1m%-10s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

bootstrap: lock tidy ## Lockfiles erzeugen (einmalig bzw. nach Abhängigkeitsänderung, Ergebnis committen)

lock: ## client/package-lock.json im Container erzeugen
	$(DOCKER) run --rm -v "$(CURDIR)/client:/w" -w /w $(NODE_IMAGE) \
	  sh -c 'npm install --package-lock-only --no-audit --no-fund --ignore-scripts && chown $(UID):$(GID) package-lock.json'

tidy: ## relay/go.sum im Container erzeugen
	$(DOCKER) run --rm -v "$(CURDIR)/relay:/w" -w /w $(GO_IMAGE) \
	  sh -c 'go mod tidy && chown $(UID):$(GID) go.mod go.sum'

check: ## Typprüfung Client + go vet/test Relay
	$(BUILD) --target client-check .
	$(BUILD) --target relay-test .

test: check ## Alias für check

image: ## Laufzeit-Image bauen (scratch + statisches Go-Binary mit eingebettetem Client)
	$(BUILD) --build-arg VERSION=$(VERSION) --target runtime -t $(IMAGE):$(VERSION) .

build: check image ## Prüfen und Image bauen

dist: ## Statisches Relay-Binary nach dist/ exportieren
	$(BUILD) --target export --output type=local,dest=dist .

models: ## Whisper-Modelle nach models/ laden
	mkdir -p models
	$(DOCKER) run --rm -v "$(CURDIR)/models:/models" -v "$(CURDIR)/scripts:/scripts:ro" $(TOOL_IMAGE) \
	  sh -c 'apk add --no-cache curl >/dev/null && sh /scripts/fetch-models.sh $(MODELS); s=$$?; chown -R $(UID):$(GID) /models; exit $$s'

certs: certs/ohrwurm.crt ## Selbstsigniertes Dev-Zertifikat erzeugen

certs/ohrwurm.crt:
	mkdir -p certs
	$(DOCKER) run --rm -v "$(CURDIR)/certs:/certs" $(TOOL_IMAGE) \
	  sh -c 'apk add --no-cache openssl >/dev/null && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 365 \
	    -subj "/CN=ohrwurm-dev" -addext "subjectAltName=$(SAN)" -keyout /certs/ohrwurm.key -out /certs/ohrwurm.crt \
	    && chmod 0644 /certs/ohrwurm.key && chown $(UID):$(GID) /certs/ohrwurm.key /certs/ohrwurm.crt'

run: image certs ## Starten mit Dev-Anmeldung → https://localhost:8443
	IMAGE=$(IMAGE) VERSION=$(VERSION) $(COMPOSE) up -d ohrwurm
	@echo "→ https://localhost:8443  (Dev-Anmeldung, Zertifikat im Browser akzeptieren)"

run-oidc: image certs ## Starten mit Dex als OIDC-Provider → https://localhost:8443
	IMAGE=$(IMAGE) VERSION=$(VERSION) OHRWURM_AUTH=oidc \
	  OHRWURM_OIDC_ISSUER=http://localhost:5556/dex \
	  OHRWURM_OIDC_INTERNAL_URL=http://dex:5556/dex \
	  OHRWURM_OIDC_CLIENT_ID=ohrwurm \
	  OHRWURM_OIDC_SCOPES="openid profile email offline_access" \
	  $(COMPOSE) --profile oidc up -d --force-recreate
	@echo "→ https://localhost:8443  (Login: anna@example.com / password)"

e2e: e2e/sample.wav ## Browser-Test (Playwright) gegen laufenden Server (make run)
	$(DOCKER) run --rm --network host --ipc host -v "$(CURDIR)/e2e:/e2e" -e BASE=$(E2E_BASE) $(PLAYWRIGHT_IMAGE) \
	  sh -c 'mkdir -p /tmp/pw && cd /tmp/pw && npm init -y >/dev/null && npm i --no-audit --no-fund --silent playwright@$(PLAYWRIGHT_VERSION) && cp /e2e/smoke.mjs . && node smoke.mjs; s=$$?; chown -R $(UID):$(GID) /e2e/out; exit $$s'

e2e/sample.wav: ## Synthetische deutsche Sprachprobe für den E2E-Test
	$(DOCKER) run --rm -v "$(CURDIR)/e2e:/e2e" $(TOOL_IMAGE) \
	  sh -c 'apk add --no-cache espeak-ng >/dev/null && espeak-ng -v de -s 140 -w /e2e/sample.wav \
	    "Guten Morgen zusammen. Wir beginnen jetzt mit der Sitzung. Der erste Punkt ist der Haushalt für das nächste Jahr." \
	    && chown $(UID):$(GID) /e2e/sample.wav'

stop: ## Alle Container stoppen
	$(COMPOSE) --profile oidc down

logs: ## Logs anzeigen
	$(COMPOSE) --profile oidc logs -f

clean: stop ## Image und Build-Artefakte entfernen (Modelle/Zertifikate bleiben)
	-$(DOCKER) image rm $(IMAGE):$(VERSION)
	rm -rf dist

# ---------- Test im lokalen Netz (Dex + Caddy, ein Origin) ----------
LAN_HOST ?= $(shell hostname -I 2>/dev/null | awk '{print $$1}')
LAN_SAN   = $(if $(shell echo "$(LAN_HOST)" | grep -E '^[0-9.]+$$'),IP:$(LAN_HOST),DNS:$(LAN_HOST))
LAN_ENV   = LAN_HOST=$(LAN_HOST) IMAGE=$(IMAGE) VERSION=$(VERSION)

run-lan: image lan-prep ## Test im LAN mit Dex → https://<LAN_HOST>:8443 (LAN_HOST=… überschreibbar)
	$(LAN_ENV) $(COMPOSE) -f compose.lan.yaml up -d --force-recreate
	@echo ""
	@echo "→ https://$(LAN_HOST):8443   (auf jedem Gerät einmal das Zertifikat akzeptieren)"
	@echo "  Konten: moderation@, anna@, ben@, clara@, david@, emma@, tisch1@, tisch2@example.com"
	@echo "  Passwort jeweils: password"

stop-lan: ## LAN-Testbetrieb stoppen
	$(LAN_ENV) $(COMPOSE) -f compose.lan.yaml down

logs-lan: ## Logs des LAN-Testbetriebs
	$(LAN_ENV) $(COMPOSE) -f compose.lan.yaml logs -f

lan-prep:
	@test -n "$(LAN_HOST)" || { echo "LAN_HOST nicht ermittelbar – bitte angeben: make run-lan LAN_HOST=192.168.x.y"; exit 1; }
	@if [ "$$(cat certs/lan.host 2>/dev/null)" != "$(LAN_HOST)" ]; then $(MAKE) --no-print-directory lan-certs; fi
	sed "s/__LAN_HOST__/$(LAN_HOST)/g" dev/dex/config.lan.yaml.tmpl > dev/dex/config.lan.yaml

lan-certs:
	mkdir -p certs
	$(DOCKER) run --rm -v "$(CURDIR)/certs:/certs" $(TOOL_IMAGE) \
	  sh -c 'apk add --no-cache openssl >/dev/null && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 365 \
	    -subj "/CN=ohrwurm-lan" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,$(LAN_SAN)" -keyout /certs/lan.key -out /certs/lan.crt \
	    && chmod 0644 /certs/lan.key && echo "$(LAN_HOST)" > /certs/lan.host && chown $(UID):$(GID) /certs/lan.*'

e2e-lan: e2e/sample.wav ## Browser-Test inkl. Dex-Login gegen den LAN-Testbetrieb (make run-lan)
	$(MAKE) --no-print-directory e2e E2E_BASE=https://$(LAN_HOST):8443

docs: ## Screenshots + Beispiel-PDF aus dem letzten E2E-Lauf nach docs/ übernehmen
	@test -d e2e/out/docs || { echo "Erst 'make e2e' oder 'make e2e-lan' ausführen"; exit 1; }
	mkdir -p docs/screenshots
	cp e2e/out/docs/*.png docs/screenshots/
	cp e2e/out/docs/beispiel-protokoll.pdf docs/
