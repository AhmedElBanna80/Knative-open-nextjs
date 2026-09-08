package wake

// singleflight.go — coalesce concurrent 0->1 wakes to the SAME scale-target key
// (issue #1018). Without this, N clients hitting one COLD compute each run their
// own wake: each consumes a wake-budget token (budget.go) AND each fires an
// independent GetScale->UpdateScale (wake.go), so a legitimate cold fan-out wider
// than GW_WAKE_BUDGET gets false 53400 refusals and the apiserver takes N racing
// scale writes -> 409-conflict retry storms. The wake is idempotent (it converges
// replicas to the wake count), so coalescing N concurrent wakes into ONE — one
// token, one scale call — is safe and strictly better: the first caller performs
// the wake, concurrent callers for the SAME key WAIT on that in-flight wake's
// result.

import (
	"context"

	"golang.org/x/sync/singleflight"
)

// WakeCoalescer single-flights concurrent wakes per scale-target key. The zero
// value is NOT usable; construct with NewWakeCoalescer. A nil *WakeCoalescer means
// coalescing is OFF (ConnectWithWake runs the wake inline, per-caller) — the exact
// pre-#1018 behaviour, so every lane that does not opt in is unchanged.
type WakeCoalescer struct {
	group singleflight.Group
}

// NewWakeCoalescer builds a coalescer. One is shared across all connections of a
// gateway so concurrent wakes to the same compute collapse to a single wake.
func NewWakeCoalescer() *WakeCoalescer {
	return &WakeCoalescer{}
}

// Do runs fn for the FIRST (leader) caller of key while a call is in flight, and
// makes concurrent callers for the same key WAIT for and share the leader's result
// (fn is NOT re-run for them). fn runs bound to the LEADER's context; a follower
// that cancels only abandons its own wait — it never cancels the shared wake.
//
// The wait OBSERVES ctx: a follower (or the leader) whose ctx is cancelled while
// the wake is in flight returns ctx.Err() PROMPTLY rather than blocking to
// completion — this is why singleflight.DoChan (a channel) is used instead of the
// plain, uninterruptible singleflight.Do. This preserves the #1017 drain-abort
// guarantee: a drain force-close cancels the caller's ctx and the caller returns at
// once. A wake FAILURE is delivered identically to every waiter (the shared
// result's error), so no waiter hangs on a failed leader.
//
// singleflight.Group forgets a key as soon as its call returns, so a LATER cold
// start (compute scaled back to zero) forms a fresh group and wakes again — the
// coalescer never caches a stale success.
func (c *WakeCoalescer) Do(ctx context.Context, key string, fn func(context.Context) error) error {
	ch := c.group.DoChan(key, func() (any, error) {
		// fn is bound to the LEADER's ctx so a #1017 drain force-close can cancel a
		// coalesced in-flight wake (a graceful-shutdown invariant). The trade: if the
		// leader disconnects mid-wake its ctx cancels and healthy followers get the
		// leader's cancel — a TRANSIENT failure, recovered by retry/re-lead because the
		// key is forgotten on return (next caller re-leads). See
		// TestLeaderDepartureLetsFollowersRecover.
		return nil, fn(ctx)
	})
	select {
	case <-ctx.Done():
		return ctx.Err()
	case res := <-ch:
		return res.Err
	}
}
