package realtime

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/comamessenger/comamessenger/core/internal/message"
)

// TestRealtimeLoadProfile is an opt-in, reproducible capacity probe. It is not
// part of ordinary CI because it opens 2,000 real loopback WebSockets and fans
// out 200 durable messages per second through PostgreSQL hydration.
func TestRealtimeLoadProfile(t *testing.T) {
	if os.Getenv("COMA_RUN_LOAD_TEST") != "1" {
		t.Skip("COMA_RUN_LOAD_TEST is not set")
	}
	const (
		connectionTarget = 2000
		messageRate      = 200
		drainTimeout     = 20 * time.Second
	)

	cfg := realtimeTestConfig()
	cfg.MaxConnectionsPerActor = connectionTarget + 1
	cfg.MaxPendingConnections = 512
	cfg.MaxConcurrentWrites = 8
	cfg.AckTimeout = 30 * time.Second
	cfg.PongTimeout = 10 * time.Second
	harness := newRealtimeHarness(t, cfg)

	connections := make([]*websocket.Conn, 0, connectionTarget)
	connectStarted := time.Now()
	for range connectionTarget {
		connection, _ := harness.connect(t, 0)
		connections = append(connections, connection)
	}
	connectDuration := time.Since(connectStarted)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	metricsCtx, stopMetrics := context.WithCancel(context.Background())
	var maxPoolAcquired atomic.Int64
	var maxLockWaiters atomic.Int64
	var maxHeapBytes atomic.Uint64
	metricsDone := make(chan struct{})
	go func() {
		defer close(metricsDone)
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-metricsCtx.Done():
				return
			case <-ticker.C:
				acquired := int64(harness.pool.Stat().AcquiredConns())
				for acquired > maxPoolAcquired.Load() && !maxPoolAcquired.CompareAndSwap(maxPoolAcquired.Load(), acquired) {
				}
				var memory runtime.MemStats
				runtime.ReadMemStats(&memory)
				for memory.HeapAlloc > maxHeapBytes.Load() && !maxHeapBytes.CompareAndSwap(maxHeapBytes.Load(), memory.HeapAlloc) {
				}
				queryCtx, queryCancel := context.WithTimeout(metricsCtx, 50*time.Millisecond)
				var waiters int64
				if err := harness.pool.QueryRow(queryCtx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`).Scan(&waiters); err == nil {
					for waiters > maxLockWaiters.Load() && !maxLockWaiters.CompareAndSwap(maxLockWaiters.Load(), waiters) {
					}
				}
				queryCancel()
			}
		}
	}()
	latencies := make(chan time.Duration, 65536)
	var delivered atomic.Uint64
	var disconnects atomic.Uint64
	disconnectReasons := make(chan websocket.StatusCode, connectionTarget)
	var readers sync.WaitGroup
	for _, connection := range connections {
		readers.Add(1)
		go func(connection *websocket.Conn) {
			defer readers.Done()
			receivedSinceAck := 0
			for {
				var frame struct {
					Op         string    `json:"op"`
					Seq        int64     `json:"seq"`
					OccurredAt time.Time `json:"occurred_at"`
				}
				if err := wsjson.Read(ctx, connection, &frame); err != nil {
					if ctx.Err() == nil {
						disconnects.Add(1)
						disconnectReasons <- websocket.CloseStatus(err)
					}
					return
				}
				if frame.Op != "event" {
					continue
				}
				delivered.Add(1)
				receivedSinceAck++
				select {
				case latencies <- time.Since(frame.OccurredAt):
				case <-ctx.Done():
					return
				}
				if receivedSinceAck < 50 {
					continue
				}
				receivedSinceAck = 0
				if err := wsjson.Write(ctx, connection, ackFrame{Op: "ack", Seq: frame.Seq}); err != nil {
					if ctx.Err() == nil {
						disconnects.Add(1)
						disconnectReasons <- websocket.CloseStatus(err)
					}
					return
				}
			}
		}(connection)
	}

	var observed []time.Duration
	collectorDone := make(chan struct{})
	go func() {
		defer close(collectorDone)
		for latency := range latencies {
			observed = append(observed, latency)
		}
	}()

	ticker := time.NewTicker(time.Second / messageRate)
	type commandResult struct {
		latency time.Duration
		err     error
		created bool
	}
	commandResults := make(chan commandResult, messageRate)
	var producers sync.WaitGroup
	for range messageRate {
		<-ticker.C
		producers.Add(1)
		go func(clientMessageID string) {
			defer producers.Done()
			commandCtx, commandCancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer commandCancel()
			started := time.Now()
			_, created, err := harness.messages.Create(commandCtx, harness.user, harness.chatID, message.CreateInput{
				ClientMsgID: clientMessageID, Body: "load", BodyFormat: "plain",
			})
			commandResults <- commandResult{latency: time.Since(started), err: err, created: created}
		}(fmt.Sprintf("019c0000-0000-7000-8000-%012d", time.Now().UnixNano()%1_000_000_000_000))
	}
	ticker.Stop()
	producers.Wait()
	close(commandResults)
	accepted := 0
	failed := 0
	commandLatencies := make([]time.Duration, 0, messageRate)
	for result := range commandResults {
		if result.err != nil || !result.created {
			failed++
			continue
		}
		accepted++
		commandLatencies = append(commandLatencies, result.latency)
	}

	wantDeliveries := uint64(accepted * len(connections))
	drainDeadline := time.Now().Add(drainTimeout)
	for delivered.Load() < wantDeliveries && time.Now().Before(drainDeadline) {
		time.Sleep(20 * time.Millisecond)
	}
	loadServerDisconnects := harness.server.DisconnectStats()
	loadServerLastError := harness.server.LastDisconnectError()
	stopMetrics()
	<-metricsDone
	cancel()
	for _, connection := range connections {
		_ = connection.Close(websocket.StatusNormalClosure, "load complete")
	}
	readers.Wait()
	close(disconnectReasons)
	close(latencies)
	<-collectorDone

	sort.Slice(observed, func(i, j int) bool { return observed[i] < observed[j] })
	sort.Slice(commandLatencies, func(i, j int) bool { return commandLatencies[i] < commandLatencies[j] })
	percentile := func(values []time.Duration, p float64) time.Duration {
		if len(values) == 0 {
			return 0
		}
		index := int(float64(len(values)-1) * p)
		return values[index]
	}
	poolStats := harness.pool.Stat()
	reasons := make(map[websocket.StatusCode]int)
	for status := range disconnectReasons {
		reasons[status]++
	}
	t.Logf("LOAD_RESULT connections=%d connect_duration=%s attempted_messages=%d accepted_messages=%d failed_messages=%d command_p50=%s command_p95=%s command_p99=%s target_deliveries=%d delivered=%d delivery_ratio=%.4f queue_remaining=%d delivery_p50=%s delivery_p95=%s delivery_p99=%s disconnects=%d pool_total=%d pool_acquired=%d max_pool_acquired=%d max_db_lock_waiters=%d max_heap_bytes=%d goroutines=%d dispatcher=%+v",
		len(connections), connectDuration, messageRate, accepted, failed, percentile(commandLatencies, .50), percentile(commandLatencies, .95), percentile(commandLatencies, .99), wantDeliveries,
		delivered.Load(), float64(delivered.Load())/float64(max(wantDeliveries, 1)), wantDeliveries-delivered.Load(), percentile(observed, .50), percentile(observed, .95), percentile(observed, .99),
		disconnects.Load(), poolStats.TotalConns(), poolStats.AcquiredConns(), maxPoolAcquired.Load(), maxLockWaiters.Load(), maxHeapBytes.Load(), runtime.NumGoroutine(), harness.dispatcher.Stats(),
	)
	t.Logf("LOAD_DISCONNECT_REASONS client=%+v server=%+v last_internal_error=%q", reasons, loadServerDisconnects, loadServerLastError)
	if len(connections) != connectionTarget {
		t.Fatalf("connected %d sockets, want %d", len(connections), connectionTarget)
	}
	if accepted == 0 || delivered.Load() == 0 {
		t.Fatal(fmt.Errorf("no WebSocket deliveries were observed"))
	}
}
