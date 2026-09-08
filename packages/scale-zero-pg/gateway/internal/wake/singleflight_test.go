package wake

import (
	"context"
	"errors"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// coldWakeDriver models a set of computes that start ASLEEP (no listener -> a dial
// is refused) and become WARM when Wake opens a listener on the target's port. It
// counts Wake calls per key and blocks briefly inside Wake so concurrent callers
// pile up on the same in-flight wake (forcing the single-flight overlap under test).
type coldWakeDriver struct {
	mu        sync.Mutex
	listeners map[string]net.Listener
	block     time.Duration
	wakes     int32 // total Wake invocations across all keys (atomic)

	perKeyMu sync.Mutex
	perKey   map[string]int
}

func newColdWakeDriver(block time.Duration) *coldWakeDriver {
	return &coldWakeDriver{
		listeners: map[string]net.Listener{},
		block:     block,
		perKey:    map[string]int{},
	}
}

func (d *coldWakeDriver) Mode() string { return "cold-fake" }

func (d *coldWakeDriver) Resolve(string) Target { return Target{} }

func (d *coldWakeDriver) Wake(_ context.Context, t Target) error {
	atomic.AddInt32(&d.wakes, 1)
	d.perKeyMu.Lock()
	d.perKey[t.Key]++
	d.perKeyMu.Unlock()
	if d.block > 0 {
		time.Sleep(d.block) // hold the wake in flight so followers coalesce onto it
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, up := d.listeners[t.Key]; up {
		return nil
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(t.Host, strconv.Itoa(t.Port)))
	if err != nil {
		return err
	}
	// Accept-and-close: a live compute answers TryConnect; the gateway then pipes.
	go func() {
		for {
			c, e := ln.Accept()
			if e != nil {
				return
			}
			_ = c.Close()
		}
	}()
	d.listeners[t.Key] = ln
	return nil
}

func (*coldWakeDriver) Sleep(context.Context, Target) error { return nil }
func (*coldWakeDriver) CanSleep() bool                      { return true }

func (d *coldWakeDriver) closeAll() {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, ln := range d.listeners {
		_ = ln.Close()
	}
}

func (d *coldWakeDriver) wakesFor(key string) int {
	d.perKeyMu.Lock()
	defer d.perKeyMu.Unlock()
	return d.perKey[key]
}

// reserveColdTarget grabs a free localhost port and returns a Target for it while
// leaving that port CLOSED — so an initial TryConnect is refused (compute asleep)
// until coldWakeDriver.Wake binds a listener on it.
func reserveColdTarget(t *testing.T, key string) Target {
	t.Helper()
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	host, portStr, _ := net.SplitHostPort(probe.Addr().String())
	port, _ := strconv.Atoi(portStr)
	_ = probe.Close() // release the port; Wake will rebind it (no TIME_WAIT: never accepted)
	return Target{Host: host, Port: port, Key: key}
}

// TestConcurrentColdWakeIsSingleFlighted: N goroutines wake the SAME cold key
// concurrently -> exactly ONE scale write (Wake) and ONE wake-budget token
// consumed; all N callers connect successfully. Without coalescing every caller
// runs its own wake (N scale writes / N tokens) — this is the #1018 thundering herd.
func TestConcurrentColdWakeIsSingleFlighted(t *testing.T) {
	const n = 20
	drv := newColdWakeDriver(50 * time.Millisecond)
	defer drv.closeAll()
	tgt := reserveColdTarget(t, "orders")

	// A generous budget: the point is that ONE token is consumed for the whole
	// group, not that the budget is hit. guardCalls counts token consumption.
	lim := NewWakeLimiter(100, time.Minute)
	var guardCalls int32
	opts := Opts{
		ConnectTimeoutMs: 200,
		WakeTimeoutMs:    5000,
		RetryMs:          10,
		WakeGuard: func(key string) error {
			atomic.AddInt32(&guardCalls, 1)
			if lim.Allow(key) {
				return nil
			}
			return ErrWakeBudgetExceeded
		},
		Coalescer: NewWakeCoalescer(),
	}

	var wg sync.WaitGroup
	errs := make([]error, n)
	conns := make([]net.Conn, n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			c, _, _, err := ConnectWithWake(context.Background(), drv, tgt, opts, nil)
			conns[i] = c
			errs[i] = err
		}(i)
	}
	close(start)
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("caller %d failed: %v", i, err)
		}
		if conns[i] == nil {
			t.Fatalf("caller %d got a nil conn", i)
		}
		_ = conns[i].Close()
	}
	if got := atomic.LoadInt32(&drv.wakes); got != 1 {
		t.Fatalf("scale writes (Wake calls) = %d, want exactly 1 (coalesced)", got)
	}
	if got := atomic.LoadInt32(&guardCalls); got != 1 {
		t.Fatalf("wake-budget tokens consumed = %d, want exactly 1 (coalesced)", got)
	}
}

// TestDistinctKeysNotCoalesced: two DIFFERENT cold computes must wake
// independently — coalescing is per-key, never a global lock.
func TestDistinctKeysNotCoalesced(t *testing.T) {
	drv := newColdWakeDriver(30 * time.Millisecond)
	defer drv.closeAll()
	a := reserveColdTarget(t, "orders")
	b := reserveColdTarget(t, "billing")

	coalescer := NewWakeCoalescer()
	opts := Opts{
		ConnectTimeoutMs: 200,
		WakeTimeoutMs:    5000,
		RetryMs:          10,
		Coalescer:        coalescer,
	}

	var wg sync.WaitGroup
	dial := func(tgt Target) {
		defer wg.Done()
		c, _, _, err := ConnectWithWake(context.Background(), drv, tgt, opts, nil)
		if err != nil {
			t.Errorf("wake %s: %v", tgt.Key, err)
			return
		}
		_ = c.Close()
	}
	// Several callers per key, both keys concurrent.
	for i := 0; i < 5; i++ {
		wg.Add(2)
		go dial(a)
		go dial(b)
	}
	wg.Wait()

	if got := drv.wakesFor("orders"); got != 1 {
		t.Fatalf("orders wakes = %d, want 1 (its own coalesced group)", got)
	}
	if got := drv.wakesFor("billing"); got != 1 {
		t.Fatalf("billing wakes = %d, want 1 (its own coalesced group)", got)
	}
	if got := atomic.LoadInt32(&drv.wakes); got != 2 {
		t.Fatalf("total wakes = %d, want 2 (distinct keys not coalesced)", got)
	}
}

// blockingWakeDriver holds Wake until release is closed, so a leader wake can be
// pinned in flight while a follower's ctx is cancelled underneath it. On release it
// binds a listener on tgt so the leader's post-wake TryConnect succeeds promptly
// (rather than polling to WakeTimeoutMs).
type blockingWakeDriver struct {
	tgt     Target
	entered chan struct{}
	release chan struct{}
	once    sync.Once

	mu sync.Mutex
	ln net.Listener
}

func (*blockingWakeDriver) Mode() string            { return "blocking-fake" }
func (d *blockingWakeDriver) Resolve(string) Target { return d.tgt }
func (d *blockingWakeDriver) Wake(ctx context.Context, t Target) error {
	d.once.Do(func() { close(d.entered) })
	select {
	case <-d.release:
	case <-ctx.Done():
		return ctx.Err()
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.ln != nil {
		return nil
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(t.Host, strconv.Itoa(t.Port)))
	if err != nil {
		return err
	}
	go func() {
		for {
			c, e := ln.Accept()
			if e != nil {
				return
			}
			_ = c.Close()
		}
	}()
	d.ln = ln
	return nil
}
func (*blockingWakeDriver) Sleep(context.Context, Target) error { return nil }
func (*blockingWakeDriver) CanSleep() bool                      { return true }
func (d *blockingWakeDriver) closeAll() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.ln != nil {
		_ = d.ln.Close()
	}
}

// TestWaitingWakerAbortsOnCtxCancel: a follower whose ctx is cancelled while the
// LEADER's wake is still in flight returns the ctx error PROMPTLY (no hang) — the
// #1017 drain-abort regression guard. The leader is NOT disturbed by the follower's
// cancellation (singleflight shares the leader's call).
func TestWaitingWakerAbortsOnCtxCancel(t *testing.T) {
	tgt := reserveColdTarget(t, "k")
	drv := &blockingWakeDriver{tgt: tgt, entered: make(chan struct{}), release: make(chan struct{})}
	defer drv.closeAll()
	coalescer := NewWakeCoalescer()
	opts := Opts{
		ConnectTimeoutMs: 50,
		WakeTimeoutMs:    60000, // long, so only ctx-cancel can end the follower's wait
		RetryMs:          10,
		Coalescer:        coalescer,
	}

	// Leader: a long-lived ctx, pinned inside Wake.
	leaderDone := make(chan struct{})
	go func() {
		defer close(leaderDone)
		_, _, _, _ = ConnectWithWake(context.Background(), drv, tgt, opts, nil)
	}()
	select {
	case <-drv.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("leader never entered Wake")
	}

	// Follower: cancel its ctx while the leader's wake is in flight; it must return
	// the ctx error within a tight bound rather than blocking to WakeTimeoutMs.
	fctx, cancel := context.WithCancel(context.Background())
	got := make(chan error, 1)
	go func() {
		_, _, _, err := ConnectWithWake(fctx, drv, tgt, opts, nil)
		got <- err
	}()
	cancel()
	select {
	case err := <-got:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("follower err = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("follower hung past its cancelled ctx (drain-abort regression)")
	}

	// Release the leader so the test does not leak the goroutine.
	close(drv.release)
	<-leaderDone
}
