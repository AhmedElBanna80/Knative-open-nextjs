package gateway

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/proto"
	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// newDrainGateway stands up a gateway in static mode in front of an always-on
// fakeCompute and returns the gateway plus its listen address. Static mode never
// sleeps, so no idle timers interfere with the drain assertions.
func newDrainGateway(t *testing.T) (*Gateway, string, *fakeCompute) {
	t.Helper()
	fc := &fakeCompute{port: freePort(t)}
	if err := fc.start(); err != nil {
		t.Fatalf("start fake compute: %v", err)
	}
	t.Cleanup(fc.stop)

	env := wake.Env{
		"GW_COMPUTE_MODE":       "static",
		"GW_TARGET":             fmt.Sprintf("127.0.0.1:%d", fc.port),
		"GW_WAKE_TIMEOUT_MS":    "5000",
		"GW_CONNECT_TIMEOUT_MS": "500",
		"GW_RETRY_MS":           "50",
	}
	gw, err := New(env, func(string) {})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go gw.Serve(ln)
	return gw, ln.Addr().String(), fc
}

// establishLive opens a client, completes the handshake, and returns once the
// gateway reports the connection as active — i.e. the two proxy pipe goroutines
// are running and the connection is genuinely in-flight.
func establishLive(t *testing.T, gw *Gateway, addr string) *pgConn {
	t.Helper()
	c := dialGateway(t, addr)
	c.c.Write(proto.BuildSSLRequest())
	c.waitFor(t, func(b []byte) bool { return len(b) >= 1 }, 5*time.Second)
	c.c.Write(proto.BuildStartup(map[string]string{"user": "app", "database": "testdb"}))
	c.waitFor(t, func(b []byte) bool { return bytes.IndexByte(b, 0x5a) >= 0 }, 5*time.Second)
	// Wait until the gateway counts it live (pipes started, wg registered).
	deadline := time.Now().Add(2 * time.Second)
	for gw.Metrics().Active() < 1 {
		if time.Now().After(deadline) {
			t.Fatalf("connection never became active")
		}
		time.Sleep(10 * time.Millisecond)
	}
	return c
}

// AC1: Drain blocks until an in-flight proxied connection closes — it must not
// return instantly (which is what the old non-draining Close() did).
func TestDrainWaitsForInflightConnection(t *testing.T) {
	gw, addr, _ := newDrainGateway(t)
	c := establishLive(t, gw, addr)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- gw.Drain(ctx) }()

	// Drain must still be blocking while the connection is live.
	select {
	case <-done:
		t.Fatal("Drain returned while an in-flight connection was still open — it drained nothing")
	case <-time.After(300 * time.Millisecond):
	}

	// Client goes away -> the pipe cleanup fires -> Drain unblocks.
	c.c.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Drain returned error after clean drain: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Drain did not complete after the in-flight connection closed")
	}
}

// AC2: Drain is bounded — a connection that never closes is force-closed after
// the context deadline, and Drain returns (does not hang forever).
func TestDrainForceClosesAfterDeadline(t *testing.T) {
	gw, addr, _ := newDrainGateway(t)
	_ = establishLive(t, gw, addr) // never closed by the test

	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	start := time.Now()
	go func() { done <- gw.Drain(ctx) }()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("Drain returned nil for a stuck connection; expected a deadline error")
		}
		if elapsed := time.Since(start); elapsed > 3*time.Second {
			t.Fatalf("Drain took %v — deadline not honored", elapsed)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Drain hung past the deadline — force-close of the stuck connection is missing")
	}
}

// Drain with nothing in flight returns promptly and cleanly.
func TestDrainNoInflightReturnsImmediately(t *testing.T) {
	gw, _, _ := newDrainGateway(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	if err := gw.Drain(ctx); err != nil {
		t.Fatalf("Drain with no in-flight conns returned error: %v", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("Drain with no in-flight conns took %v", elapsed)
	}
}
