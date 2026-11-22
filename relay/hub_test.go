package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type client struct {
	t *testing.T
	c *websocket.Conn
}

func dial(t *testing.T, srv *httptest.Server, name string) *client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	cl := &client{t: t, c: c}
	cl.send(map[string]any{"t": "auth", "token": "dev:" + name})
	cl.expect("authok")
	return cl
}

func (cl *client) send(m map[string]any) {
	cl.t.Helper()
	b, _ := json.Marshal(m)
	if err := cl.c.Write(context.Background(), websocket.MessageText, b); err != nil {
		cl.t.Fatal(err)
	}
}

func (cl *client) expect(typ string) map[string]any {
	cl.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		_, b, err := cl.c.Read(ctx)
		if err != nil {
			cl.t.Fatalf("erwartet %q: %v", typ, err)
		}
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		if m["t"] == typ {
			return m
		}
	}
}

// nothing stellt sicher, dass vor der Antwort auf einen Ping keine Nachricht des
// Typs ankommt. (Ein Read-Timeout würde die Verbindung schließen.)
func (cl *client) nothing(typ string) {
	cl.t.Helper()
	time.Sleep(100 * time.Millisecond)
	cl.send(map[string]any{"t": "ping", "c": 1})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		_, b, err := cl.c.Read(ctx)
		if err != nil {
			cl.t.Fatalf("kein pong: %v", err)
		}
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		switch m["t"] {
		case typ:
			cl.t.Fatalf("unerwartete Nachricht %v", m)
		case "pong":
			return
		}
	}
}

const sid = "sessionAAAAAAAAAAAAAAA"

func join(cl *client, peer string) map[string]any {
	cl.send(map[string]any{"t": "join", "session": sid, "peer": peer, "pub": strings.Repeat(peer[:1], 87)})
	return cl.expect("joined")
}

func TestMeshRelay(t *testing.T) {
	hub := NewHub(devVerifier{}, time.Hour, slog.New(slog.NewTextHandler(io.Discard, nil)))
	srv := httptest.NewServer(hub)
	defer srv.Close()

	anna := dial(t, srv, "Anna")
	join(anna, "AnnaPeer00000000")
	ben := dial(t, srv, "Ben")
	if j := join(ben, "BenPeer000000000"); len(j["peers"].([]any)) != 2 {
		t.Fatalf("Mitgliederliste falsch: %v", j)
	}
	if p := anna.expect("presence"); p["peer"] != "BenPeer000000000" || p["online"] != true {
		t.Fatalf("presence falsch: %v", p)
	}
	clara := dial(t, srv, "Clara")
	join(clara, "ClaraPeer0000000")
	anna.expect("presence")
	ben.expect("presence")

	// Broadcast erreicht alle außer dem Absender.
	anna.send(map[string]any{"t": "send", "session": sid, "to": "*", "data": "b3Bz"})
	for _, c := range []*client{ben, clara} {
		if r := c.expect("recv"); r["from"] != "AnnaPeer00000000" || r["data"] != "b3Bz" {
			t.Fatalf("broadcast falsch: %v", r)
		}
	}
	anna.nothing("recv")

	// Direktnachricht nur an den Empfänger.
	ben.send(map[string]any{"t": "send", "session": sid, "to": "ClaraPeer0000000", "data": "ZGlyZWt0"})
	if r := clara.expect("recv"); r["from"] != "BenPeer000000000" {
		t.Fatalf("direkt falsch: %v", r)
	}
	anna.nothing("recv")

	// Klartext wird abgewiesen, Nicht-Mitglieder dürfen nicht senden.
	anna.send(map[string]any{"t": "send", "session": sid, "to": "*", "data": "Hallo Welt!"})
	if e := anna.expect("error"); e["code"] != "baddata" {
		t.Fatalf("erwartet baddata: %v", e)
	}
	mallory := dial(t, srv, "Mallory")
	mallory.send(map[string]any{"t": "send", "session": sid, "to": "*", "data": "eA"})
	if e := mallory.expect("error"); e["code"] != "notmember" {
		t.Fatalf("erwartet notmember: %v", e)
	}
	// Peer-ID einer anderen Person kann nicht übernommen werden.
	mallory.send(map[string]any{"t": "join", "session": sid, "peer": "AnnaPeer00000000", "pub": strings.Repeat("A", 87)})
	if e := mallory.expect("error"); e["code"] != "peertaken" {
		t.Fatalf("erwartet peertaken: %v", e)
	}

	// Offline-Meldung bei Verbindungsende.
	_ = clara.c.Close(websocket.StatusNormalClosure, "")
	if p := anna.expect("presence"); p["peer"] != "ClaraPeer0000000" || p["online"] != false {
		t.Fatalf("offline-presence falsch: %v", p)
	}
	ben.send(map[string]any{"t": "send", "session": sid, "to": "ClaraPeer0000000", "data": "eA"})
	if e := ben.expect("error"); e["code"] != "offline" {
		t.Fatalf("erwartet offline: %v", e)
	}

	// Binärframes (z. B. Audio) werden hart abgelehnt.
	_ = anna.c.Write(context.Background(), websocket.MessageBinary, []byte{1, 2, 3})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		_, _, err := anna.c.Read(ctx)
		if err == nil {
			continue
		}
		var ce websocket.CloseError
		if !errors.As(err, &ce) || ce.Code != websocket.StatusUnsupportedData {
			t.Fatalf("erwartet Close 1003, bekam %v", err)
		}
		break
	}
}

func TestRelayRestartRecreatesSession(t *testing.T) {
	// Ein frischer Relay kennt die Session nicht – der erste Join legt sie an.
	hub := NewHub(devVerifier{}, time.Hour, slog.New(slog.NewTextHandler(io.Discard, nil)))
	srv := httptest.NewServer(hub)
	defer srv.Close()
	ben := dial(t, srv, "Ben")
	if j := join(ben, "BenPeer000000000"); j["session"] != sid {
		t.Fatalf("Session nicht angelegt: %v", j)
	}
}
