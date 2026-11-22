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

func TestRelayFlow(t *testing.T) {
	hub := NewHub(devVerifier{}, time.Hour, slog.New(slog.NewTextHandler(io.Discard, nil)))
	srv := httptest.NewServer(hub)
	defer srv.Close()

	hostPub := strings.Repeat("H", 87)
	host := dial(t, srv, "Moderation")
	host.send(map[string]any{"t": "create", "pub": hostPub})
	sid := host.expect("created")["session"].(string)

	anna := dial(t, srv, "Anna")
	anna.send(map[string]any{"t": "join", "session": sid, "peer": "peerAnna01", "pub": strings.Repeat("A", 87)})
	if j := anna.expect("joined"); j["hostPub"] != hostPub {
		t.Fatalf("hostPub falsch: %v", j)
	}
	if p := host.expect("peer"); p["peer"] != "peerAnna01" || p["user"].(map[string]any)["name"] != "Anna" {
		t.Fatalf("peer-Event falsch: %v", p)
	}

	anna.send(map[string]any{"t": "send", "session": sid, "to": "host", "data": "Y2lwaGVy"})
	if r := host.expect("recv"); r["from"] != "peerAnna01" || r["data"] != "Y2lwaGVy" {
		t.Fatalf("recv beim Host falsch: %v", r)
	}
	host.send(map[string]any{"t": "send", "session": sid, "to": "peerAnna01", "data": "YWNr"})
	if r := anna.expect("recv"); r["from"] != "host" || r["data"] != "YWNr" {
		t.Fatalf("recv beim Peer falsch: %v", r)
	}

	// Teilnehmer dürfen nicht an andere Teilnehmer senden.
	anna.send(map[string]any{"t": "send", "session": sid, "to": "peerOther1", "data": "eA"})
	if e := anna.expect("error"); e["code"] != "forbidden" {
		t.Fatalf("erwartet forbidden: %v", e)
	}
	// Klartext/Nicht-base64 wird abgewiesen.
	anna.send(map[string]any{"t": "send", "session": sid, "to": "host", "data": "Hallo Welt!"})
	if e := anna.expect("error"); e["code"] != "baddata" {
		t.Fatalf("erwartet baddata: %v", e)
	}

	// Fremder Nutzer kann eine Peer-ID nicht übernehmen.
	mallory := dial(t, srv, "Mallory")
	mallory.send(map[string]any{"t": "join", "session": sid, "peer": "peerAnna01", "pub": strings.Repeat("A", 87)})
	if e := mallory.expect("error"); e["code"] != "peertaken" {
		t.Fatalf("erwartet peertaken: %v", e)
	}
	// Fremder Nutzer kann nicht Host werden.
	mallory.send(map[string]any{"t": "host", "session": sid})
	if e := mallory.expect("error"); e["code"] != "forbidden" {
		t.Fatalf("erwartet forbidden: %v", e)
	}

	// Host offline: Nachrichten werden gepuffert und nach Wiederverbindung zugestellt.
	_ = host.c.Close(websocket.StatusNormalClosure, "")
	if s := anna.expect("hoststatus"); s["online"] != false {
		t.Fatalf("hoststatus falsch: %v", s)
	}
	anna.send(map[string]any{"t": "send", "session": sid, "to": "host", "data": "cHVmZmVy"})
	time.Sleep(50 * time.Millisecond)
	host2 := dial(t, srv, "Moderation")
	host2.send(map[string]any{"t": "host", "session": sid})
	host2.expect("hosting")
	if r := host2.expect("recv"); r["data"] != "cHVmZmVy" {
		t.Fatalf("gepufferte Nachricht fehlt: %v", r)
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

	// Session beenden benachrichtigt Teilnehmer.
	bob := dial(t, srv, "Bob")
	bob.send(map[string]any{"t": "join", "session": sid, "peer": "peerBob001", "pub": strings.Repeat("B", 87)})
	bob.expect("joined")
	host2.send(map[string]any{"t": "end", "session": sid})
	host2.expect("ended")
	bob.expect("ended")
}
