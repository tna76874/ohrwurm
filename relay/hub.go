package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Der Relay ist im Mesh-Modell nur noch ein Verteiler: Er kennt Sessions und
// Mitglieder (Peer-ID, öffentlicher Signaturschlüssel, OIDC-Identität) und
// leitet undurchsichtige Chiffrate weiter. Er speichert keine Inhalte und puffert
// nichts – fehlende Daten holen sich die Clients gegenseitig.

const (
	maxFrameBytes      = 256 << 10
	maxDataBytes       = 192 << 10
	maxConnQueueMsgs   = 50_000
	maxConnQueueBytes  = 128 << 20
	maxPeersPerSession = 2_000
	maxSessions        = 10_000
	maxSessionsPerConn = 10
	rateLimitPerSec    = 60
	rateLimitBurst     = 600
)

var (
	reID  = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)
	reKey = regexp.MustCompile(`^[A-Za-z0-9_-]{16,200}$`)
	reB64 = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
)

type inMsg struct {
	T       string  `json:"t"`
	Token   string  `json:"token,omitempty"`
	Session string  `json:"session,omitempty"`
	Peer    string  `json:"peer,omitempty"`
	Pub     string  `json:"pub,omitempty"`
	To      string  `json:"to,omitempty"`
	Data    string  `json:"data,omitempty"`
	C       float64 `json:"c,omitempty"`
}

type peerInfo struct {
	Peer   string   `json:"peer"`
	Pub    string   `json:"pub"`
	User   Identity `json:"user"`
	Online bool     `json:"online"`
}

type outMsg struct {
	T       string     `json:"t"`
	Session string     `json:"session,omitempty"`
	Peer    string     `json:"peer,omitempty"`
	Pub     string     `json:"pub,omitempty"`
	From    string     `json:"from,omitempty"`
	Data    string     `json:"data,omitempty"`
	User    *Identity  `json:"user,omitempty"`
	Online  *bool      `json:"online,omitempty"`
	Peers   []peerInfo `json:"peers,omitempty"`
	Code    string     `json:"code,omitempty"`
	Msg     string     `json:"msg,omitempty"`
	C       float64    `json:"c,omitempty"`
	S       int64      `json:"s,omitempty"`
}

func encode(m outMsg) []byte {
	b, _ := json.Marshal(m)
	return b
}

func ptr[T any](v T) *T { return &v }

type session struct {
	id         string
	peers      map[string]*peer
	lastActive time.Time
}

type peer struct {
	id   string
	pub  string
	user Identity
	conn *conn
}

func (s *session) online() int {
	n := 0
	for _, p := range s.peers {
		if p.conn != nil {
			n++
		}
	}
	return n
}

type conn struct {
	ws     *websocket.Conn
	cancel context.CancelFunc
	user   Identity
	authed bool
	peerIn map[string]string // session -> peer, geschützt durch Hub.mu

	qmu    sync.Mutex
	q      [][]byte
	qBytes int
	wake   chan struct{}

	tokens float64
	last   time.Time
}

func (c *conn) push(b []byte) {
	c.qmu.Lock()
	if len(c.q) >= maxConnQueueMsgs || c.qBytes+len(b) > maxConnQueueBytes {
		c.qmu.Unlock()
		c.cancel() // zu langsamer Empfänger
		return
	}
	c.q = append(c.q, b)
	c.qBytes += len(b)
	c.qmu.Unlock()
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

func (c *conn) reply(m outMsg) { c.push(encode(m)) }

func (c *conn) allow() bool {
	now := time.Now()
	c.tokens += now.Sub(c.last).Seconds() * rateLimitPerSec
	if c.tokens > rateLimitBurst {
		c.tokens = rateLimitBurst
	}
	c.last = now
	if c.tokens < 1 {
		return false
	}
	c.tokens--
	return true
}

func (c *conn) writeLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.wake:
		}
		c.qmu.Lock()
		batch := c.q
		c.q, c.qBytes = nil, 0
		c.qmu.Unlock()
		for _, b := range batch {
			wctx, cancel := context.WithTimeout(ctx, 15*time.Second)
			err := c.ws.Write(wctx, websocket.MessageText, b)
			cancel()
			if err != nil {
				c.cancel()
				return
			}
		}
	}
}

func (c *conn) pingLoop(ctx context.Context) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pctx, cancel := context.WithTimeout(ctx, 15*time.Second)
			err := c.ws.Ping(pctx)
			cancel()
			if err != nil {
				c.cancel()
				return
			}
		}
	}
}

type Hub struct {
	verifier Verifier
	ttl      time.Duration
	log      *slog.Logger

	mu       sync.Mutex
	sessions map[string]*session
}

func NewHub(v Verifier, ttl time.Duration, log *slog.Logger) *Hub {
	return &Hub{verifier: v, ttl: ttl, log: log, sessions: map[string]*session{}}
}

func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, nil) // prüft Origin == Host
	if err != nil {
		return
	}
	ws.SetReadLimit(maxFrameBytes)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	c := &conn{
		ws: ws, cancel: cancel, peerIn: map[string]string{},
		wake: make(chan struct{}, 1), tokens: rateLimitBurst, last: time.Now(),
	}
	go c.writeLoop(ctx)
	go c.pingLoop(ctx)
	h.readLoop(ctx, c)
	h.disconnect(c)
	_ = ws.CloseNow()
}

func (h *Hub) readLoop(ctx context.Context, c *conn) {
	for {
		typ, b, err := c.ws.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			_ = c.ws.Close(websocket.StatusUnsupportedData, "nur Text-Nachrichten erlaubt")
			return
		}
		if !c.allow() {
			_ = c.ws.Close(websocket.StatusPolicyViolation, "zu viele Nachrichten")
			return
		}
		var m inMsg
		if err := json.Unmarshal(b, &m); err != nil {
			c.reply(outMsg{T: "error", Msg: "ungültiges JSON"})
			continue
		}
		switch {
		case m.T == "auth":
			h.auth(ctx, c, m)
		case !c.authed:
			_ = c.ws.Close(websocket.StatusPolicyViolation, "nicht angemeldet")
			return
		case m.T == "ping":
			c.reply(outMsg{T: "pong", C: m.C, S: time.Now().UnixMilli()})
		default:
			h.handle(c, m)
		}
	}
}

func (h *Hub) auth(ctx context.Context, c *conn, m inMsg) {
	if c.authed {
		c.reply(outMsg{T: "error", Msg: "bereits angemeldet"})
		return
	}
	vctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	id, err := h.verifier.Verify(vctx, m.Token)
	if err != nil {
		h.log.Info("Anmeldung abgelehnt", "err", err)
		c.reply(outMsg{T: "autherror", Msg: "Anmeldung fehlgeschlagen"})
		return
	}
	c.user, c.authed = id, true
	c.reply(outMsg{T: "authok", User: &id})
}

func errMsg(sid, code, msg string) outMsg {
	return outMsg{T: "error", Session: sid, Code: code, Msg: msg}
}

func (h *Hub) handle(c *conn, m inMsg) {
	h.mu.Lock()
	defer h.mu.Unlock()
	switch m.T {
	case "join":
		h.join(c, m)
	case "send":
		h.send(c, m)
	case "leave":
		h.leave(c, m)
	default:
		c.reply(errMsg(m.Session, "badtype", "unbekannter Nachrichtentyp"))
	}
}

func (s *session) peerList() []peerInfo {
	out := make([]peerInfo, 0, len(s.peers))
	for _, p := range s.peers {
		out = append(out, peerInfo{Peer: p.id, Pub: p.pub, User: p.user, Online: p.conn != nil})
	}
	return out
}

func (s *session) broadcast(except *peer, b []byte) {
	for _, p := range s.peers {
		if p != except && p.conn != nil {
			p.conn.push(b)
		}
	}
}

// join tritt einer Session bei und legt sie bei Bedarf an. Die Session-ID wird
// vom Client gewählt (128 Bit Zufall), so übersteht das Netz auch einen
// Neustart des Relays: Wer zuerst wieder da ist, legt sie neu an.
func (h *Hub) join(c *conn, m inMsg) {
	if !reID.MatchString(m.Session) || !reID.MatchString(m.Peer) || !reKey.MatchString(m.Pub) {
		c.reply(errMsg(m.Session, "badkey", "ungültige Session-, Peer-ID oder Schlüssel"))
		return
	}
	s := h.sessions[m.Session]
	if s == nil {
		if len(h.sessions) >= maxSessions || len(c.peerIn) >= maxSessionsPerConn {
			c.reply(errMsg(m.Session, "limit", "zu viele Sessions"))
			return
		}
		s = &session{id: m.Session, peers: map[string]*peer{}}
		h.sessions[s.id] = s
		h.log.Info("Session angelegt", "session", s.id)
	}
	p := s.peers[m.Peer]
	if p == nil {
		if len(s.peers) >= maxPeersPerSession {
			c.reply(errMsg(s.id, "limit", "Session ist voll"))
			return
		}
		p = &peer{id: m.Peer, pub: m.Pub, user: c.user}
		s.peers[p.id] = p
	} else if p.pub != m.Pub || p.user.Sub != c.user.Sub {
		c.reply(errMsg(s.id, "peertaken", "Peer-ID ist bereits einer anderen Person zugeordnet"))
		return
	}
	if p.conn != nil && p.conn != c {
		delete(p.conn.peerIn, s.id)
		p.conn.reply(errMsg(s.id, "replaced", "Diese Sitzung wurde in einem anderen Fenster geöffnet"))
	}
	p.conn = c
	c.peerIn[s.id] = p.id
	s.lastActive = time.Now()
	c.reply(outMsg{T: "joined", Session: s.id, Peer: p.id, Peers: s.peerList()})
	s.broadcast(p, encode(outMsg{T: "presence", Session: s.id, Peer: p.id, Pub: p.pub, User: &p.user, Online: ptr(true)}))
}

func (h *Hub) send(c *conn, m inMsg) {
	s := h.sessions[m.Session]
	pid, ok := c.peerIn[m.Session]
	if s == nil || !ok {
		c.reply(errMsg(m.Session, "notmember", "nicht Teil dieser Session"))
		return
	}
	if len(m.Data) == 0 || len(m.Data) > maxDataBytes || !reB64.MatchString(m.Data) {
		c.reply(errMsg(s.id, "baddata", "Daten müssen base64url-Chiffrat sein"))
		return
	}
	s.lastActive = time.Now()
	from := s.peers[pid]
	b := encode(outMsg{T: "recv", Session: s.id, From: pid, Data: m.Data})
	if m.To == "*" {
		s.broadcast(from, b)
		return
	}
	to := s.peers[m.To]
	if to == nil || to.conn == nil {
		c.reply(errMsg(s.id, "offline", "Empfänger nicht verbunden"))
		return
	}
	to.conn.push(b)
}

func (h *Hub) leave(c *conn, m inMsg) {
	s := h.sessions[m.Session]
	pid, ok := c.peerIn[m.Session]
	if s == nil || !ok {
		return
	}
	delete(c.peerIn, s.id)
	if p := s.peers[pid]; p != nil && p.conn == c {
		p.conn = nil
		s.broadcast(p, encode(outMsg{T: "presence", Session: s.id, Peer: p.id, Pub: p.pub, User: &p.user, Online: ptr(false)}))
	}
}

func (h *Hub) disconnect(c *conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for sid, pid := range c.peerIn {
		s := h.sessions[sid]
		if s == nil {
			continue
		}
		if p := s.peers[pid]; p != nil && p.conn == c {
			p.conn = nil
			s.lastActive = time.Now()
			s.broadcast(p, encode(outMsg{T: "presence", Session: s.id, Peer: p.id, Pub: p.pub, User: &p.user, Online: ptr(false)}))
		}
	}
}

// Janitor entfernt Sessions, in denen seit der TTL niemand mehr verbunden war.
func (h *Hub) Janitor(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			h.mu.Lock()
			for id, s := range h.sessions {
				if s.online() == 0 && time.Since(s.lastActive) > h.ttl {
					delete(h.sessions, id)
					h.log.Info("Session entfernt", "session", id)
				}
			}
			h.mu.Unlock()
		}
	}
}
