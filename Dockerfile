# syntax=docker/dockerfile:1
# Gesamte Build-Pipeline von Ohrwurm. Auf dem Host wird nur Docker benötigt.
# Build-Stufen laufen nativ (BUILDPLATFORM), Go cross-kompiliert für TARGETPLATFORM.
# Das Ergebnis ist ein einziges statisches Binary mit eingebettetem Frontend (go:embed).

ARG NODE_IMAGE=node:22-alpine
ARG GO_IMAGE=golang:1.25-alpine

# ---------- Client (TypeScript / Vite) ----------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS client-deps
WORKDIR /src/client
COPY client/package.json client/package-lock.json ./
# --ignore-scripts: keine Install-Skripte von Abhängigkeiten (u. a. lädt onnxruntime-node sonst CUDA-Binaries)
RUN npm ci --no-audit --no-fund --ignore-scripts

FROM client-deps AS client-check
COPY client/ ./
RUN npm run check && npm test

FROM client-deps AS client-build
COPY client/ ./
RUN npm run build

# ---------- Relay (Go) ----------
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS relay-deps
WORKDIR /src/relay
COPY relay/go.mod relay/go.sum ./
RUN go mod download && go mod verify

FROM relay-deps AS relay-test
COPY relay/ ./
RUN go vet ./... && go test -count=1 ./...

FROM relay-deps AS relay-build
COPY relay/ ./
COPY --from=client-build /src/client/dist/ ./web/
ARG VERSION=dev
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath \
      -ldflags="-s -w -X main.version=${VERSION}" -o /out/ohrwurm-relay .

# ---------- Artefakte ----------
FROM scratch AS export
COPY --from=relay-build /out/ohrwurm-relay /

FROM scratch AS runtime
COPY --from=relay-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=relay-build /out/ohrwurm-relay /ohrwurm-relay
USER 65532:65532
EXPOSE 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["/ohrwurm-relay", "healthcheck"]
ENTRYPOINT ["/ohrwurm-relay"]
