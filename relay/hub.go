package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	maxFrameBytes      = 256 << 10
	maxDataBytes       = 128 << 10
	maxConnQueueMsgs   = 100_000
	maxConnQueueBytes  = 128 << 20
	maxHostQueueMsgs   = 50_000
	maxHostQueueBytes  = 64 << 20
	maxPeerQueueMsgs   = 2_000
	maxPeersPerSession = 2_000
	maxSessionsPerConn = 10
	rateLimitPerSec    = 50
	rateLimitBurst     = 400
)

var (
	reID  = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
	reKey = regexp.MustCompile(`^[A-Za-z0-9_-]{16,200}$`)
	reB64 = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
)

// inMsg ist die einzige Struktur, die der Relay vom Client annimmt.
// "data" ist immer ein undurchsichtiges base64url-Chiffrat.
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
	HostPub string     `json:"hostPub,omitempty"`
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
	id             string
	hostPub        string
	hostSub        string
	host           *conn
	peers          map[string]*peer
	hostQueue      [][]byte
	hostQueueBytes int
	lastActive     time.Time
}

type peer struct {
	id    string
	pub   string
	user  Identity
	conn  *conn
	queue [][]byte
}

type conn struct {
	ws     *websocket.Conn
	cancel context.CancelFunc
	user   Identity
	authed bool
	hostOf map[string]bool   // geschützt durch Hub.mu
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
		ws: ws, cancel: cancel, hostOf: map[string]bool{}, peerIn: map[string]string{},
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
	case "create":
		h.create(c, m)
	case "host":
		h.rehost(c, m)
	case "join":
		h.join(c, m)
	case "send":
		h.send(c, m)
	case "leave":
		h.leave(c, m)
	case "end":
		h.end(c, m)
	default:
		c.reply(errMsg(m.Session, "badtype", "unbekannter Nachrichtentyp"))
	}
}

func randomID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (h *Hub) create(c *conn, m inMsg) {
	if !reKey.MatchString(m.Pub) {
		c.reply(errMsg("", "badkey", "ungültiger Schlüssel"))
		return
	}
	if len(c.hostOf) >= maxSessionsPerConn {
		c.reply(errMsg("", "limit", "zu viele Sessions"))
		return
	}
	s := &session{id: randomID(), hostPub: m.Pub, hostSub: c.user.Sub, host: c, peers: map[string]*peer{}, lastActive: time.Now()}
	h.sessions[s.id] = s
	c.hostOf[s.id] = true
	h.log.Info("Session erstellt", "session", s.id)
	c.reply(outMsg{T: "created", Session: s.id})
}

func (s *session) peerList() []peerInfo {
	out := make([]peerInfo, 0, len(s.peers))
	for _, p := range s.peers {
		out = append(out, peerInfo{Peer: p.id, Pub: p.pub, User: p.user, Online: p.conn != nil})
	}
	return out
}

func (h *Hub) broadcastHostStatus(s *session, online bool) {
	b := encode(outMsg{T: "hoststatus", Session: s.id, Online: ptr(online)})
	for _, p := range s.peers {
		if p.conn != nil {
			p.conn.push(b)
		}
	}
}

func (h *Hub) rehost(c *conn, m inMsg) {
	s := h.sessions[m.Session]
	if s == nil {
		c.reply(errMsg(m.Session, "nosession", "Session unbekannt oder abgelaufen"))
		return
	}
	if s.hostSub != c.user.Sub {
		c.reply(errMsg(m.Session, "forbidden", "nicht Host dieser Session"))
		return
	}
	if s.host != nil && s.host != c {
		delete(s.host.hostOf, s.id)
		s.host.reply(errMsg(s.id, "replaced", "Host-Rolle wurde von einer anderen Verbindung übernommen"))
	}
	s.host = c
	c.hostOf[s.id] = true
	s.lastActive = time.Now()
	c.reply(outMsg{T: "hosting", Session: s.id, Peers: s.peerList()})
	for _, b := range s.hostQueue {
		c.push(b)
	}
	s.hostQueue, s.hostQueueBytes = nil, 0
	h.broadcastHostStatus(s, true)
}

// toHost stellt zu oder puffert, solange der Host offline ist.
func (s *session) toHost(b []byte) bool {
	if s.host != nil {
		s.host.push(b)
		return true
	}
	if len(s.hostQueue) >= maxHostQueueMsgs || s.hostQueueBytes+len(b) > maxHostQueueBytes {
		return false
	}
	s.hostQueue = append(s.hostQueue, b)
	s.hostQueueBytes += len(b)
	return true
}

func (p *peer) deliver(b []byte) {
	if p.conn != nil {
		p.conn.push(b)
		return
	}
	if len(p.queue) >= maxPeerQueueMsgs {
		p.queue = p.queue[1:]
	}
	p.queue = append(p.queue, b)
}

func (h *Hub) join(c *conn, m inMsg) {
	s := h.sessions[m.Session]
	if s == nil {
		c.reply(errMsg(m.Session, "nosession", "Session unbekannt oder abgelaufen"))
		return
	}
	if !reID.MatchString(m.Peer) || !reKey.MatchString(m.Pub) {
		c.reply(errMsg(s.id, "badkey", "ungültige Peer-ID oder Schlüssel"))
		return
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
		c.reply(errMsg(s.id, "peertaken", "Peer-ID ist bereits vergeben"))
		return
	}
	if p.conn != nil && p.conn != c {
		delete(p.conn.peerIn, s.id)
		p.conn.reply(errMsg(s.id, "replaced", "Teilnahme wurde von einer anderen Verbindung übernommen"))
	}
	p.conn = c
	c.peerIn[s.id] = p.id
	s.lastActive = time.Now()
	c.reply(outMsg{T: "joined", Session: s.id, Peer: p.id, HostPub: s.hostPub, Online: ptr(s.host != nil)})
	for _, b := range p.queue {
		c.push(b)
	}
	p.queue = nil
	s.toHost(encode(outMsg{T: "peer", Session: s.id, Peer: p.id, Pub: p.pub, User: &p.user, Online: ptr(true)}))
}

func (h *Hub) send(c *conn, m inMsg) {
	s := h.sessions[m.Session]
	if s == nil {
		c.reply(errMsg(m.Session, "nosession", "Session unbekannt oder abgelaufen"))
		return
	}
	if len(m.Data) == 0 || len(m.Data) > maxDataBytes || !reB64.MatchString(m.Data) {
		c.reply(errMsg(s.id, "baddata", "Daten müssen base64url-Chiffrat sein"))
		return
	}
	s.lastActive = time.Now()
	if s.host == c {
		b := encode(outMsg{T: "recv", Session: s.id, From: "host", Data: m.Data})
		if m.To == "*" {
			for _, p := range s.peers {
				p.deliver(b)
			}
			return
		}
		p := s.peers[m.To]
		if p == nil {
			c.reply(errMsg(s.id, "nopeer", "Empfänger unbekannt"))
			return
		}
		p.deliver(b)
		return
	}
	pid, ok := c.peerIn[s.id]
	if !ok {
		c.reply(errMsg(s.id, "notmember", "nicht Teil dieser Session"))
		return
	}
	if m.To != "host" {
		c.reply(errMsg(s.id, "forbidden", "Teilnehmer dürfen nur an den Host senden"))
		return
	}
	if !s.toHost(encode(outMsg{T: "recv", Session: s.id, From: pid, Data: m.Data})) {
		c.reply(errMsg(s.id, "full", "Puffer für den Host ist voll"))
	}
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
		if s.host != nil {
			s.host.reply(outMsg{T: "peer", Session: s.id, Peer: p.id, Pub: p.pub, User: &p.user, Online: ptr(false)})
		}
	}
}

func (h *Hub) end(c *conn, m inMsg) {
	s := h.sessions[m.Session]
	if s == nil || s.host != c {
		c.reply(errMsg(m.Session, "forbidden", "nur der verbundene Host kann die Session beenden"))
		return
	}
	h.drop(s)
	c.reply(outMsg{T: "ended", Session: s.id})
}

// drop entfernt eine Session vollständig. Aufruf nur unter h.mu.
func (h *Hub) drop(s *session) {
	b := encode(outMsg{T: "ended", Session: s.id})
	for _, p := range s.peers {
		if p.conn != nil {
			delete(p.conn.peerIn, s.id)
			p.conn.push(b)
		}
	}
	if s.host != nil {
		delete(s.host.hostOf, s.id)
	}
	delete(h.sessions, s.id)
	h.log.Info("Session entfernt", "session", s.id)
}

func (h *Hub) disconnect(c *conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for sid := range c.hostOf {
		if s := h.sessions[sid]; s != nil && s.host == c {
			s.host = nil
			h.broadcastHostStatus(s, false)
		}
	}
	for sid, pid := range c.peerIn {
		s := h.sessions[sid]
		if s == nil {
			continue
		}
		if p := s.peers[pid]; p != nil && p.conn == c {
			p.conn = nil
			if s.host != nil {
				s.host.reply(outMsg{T: "peer", Session: s.id, Peer: p.id, Pub: p.pub, User: &p.user, Online: ptr(false)})
			}
		}
	}
}

// Janitor entfernt Sessions, die länger als die TTL inaktiv waren.
func (h *Hub) Janitor(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			h.mu.Lock()
			for _, s := range h.sessions {
				if time.Since(s.lastActive) > h.ttl {
					h.drop(s)
				}
			}
			h.mu.Unlock()
		}
	}
}
