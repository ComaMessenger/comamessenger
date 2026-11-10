// Package mcptest provides an in-process MCP server for tests. It mirrors
// the tool contract of examples/agents/accounting-mcp: a fictional
// accounting system that knows slots and instructors.
package mcptest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
)

// Slot is one fictional schedule slot.
type Slot struct {
	ID           string `json:"id"`
	Date         string `json:"date"`
	Start        string `json:"start"`
	End          string `json:"end"`
	Room         string `json:"room"`
	InstructorID string `json:"instructor_id,omitempty"`
	Instructor   string `json:"instructor,omitempty"`
	Status       string `json:"status"`
}

// Server is a streamable-HTTP MCP server with three tools.
type Server struct {
	*httptest.Server
	mu         sync.Mutex
	slots      []Slot
	calls      map[string]int
	headers    []http.Header
	RequireKey string
}

var instructors = map[string]string{"i-1": "Иванова", "i-2": "Петров", "i-3": "Смирнова"}

// NewSlotsServer starts the server; RequireKey, when set, is checked in the
// Authorization header.
func NewSlotsServer() *Server {
	server := &Server{calls: map[string]int{}, slots: []Slot{
		{ID: "s-1", Date: "2026-11-12", Start: "09:00", End: "10:00", Room: "Зал 1", InstructorID: "i-1", Instructor: "Иванова", Status: "занят"},
		{ID: "s-2", Date: "2026-11-12", Start: "10:00", End: "11:00", Room: "Зал 1", Status: "свободен"},
		{ID: "s-3", Date: "2026-11-12", Start: "11:00", End: "12:00", Room: "Зал 2", InstructorID: "i-2", Instructor: "Петров", Status: "занят"},
		{ID: "s-4", Date: "2026-11-13", Start: "09:00", End: "10:00", Room: "Зал 1", Status: "свободен"},
	}}
	server.Server = httptest.NewServer(http.HandlerFunc(server.handle))
	return server
}

// Calls returns how many times a tool was called.
func (server *Server) Calls(tool string) int {
	server.mu.Lock()
	defer server.mu.Unlock()
	return server.calls[tool]
}

// LastHeaders returns the headers of the last request.
func (server *Server) LastHeaders() http.Header {
	server.mu.Lock()
	defer server.mu.Unlock()
	if len(server.headers) == 0 {
		return nil
	}
	return server.headers[len(server.headers)-1]
}

// Slots returns a copy of the schedule.
func (server *Server) Slots() []Slot {
	server.mu.Lock()
	defer server.mu.Unlock()
	return append([]Slot(nil), server.slots...)
}

// Tools is the advertised catalog.
var Tools = []map[string]any{
	{"name": "get_slots", "description": "Слоты расписания на дату.", "annotations": map[string]any{"readOnlyHint": true},
		"inputSchema": map[string]any{"type": "object", "required": []string{"date"}, "properties": map[string]any{"date": map[string]any{"type": "string"}}}},
	{"name": "find_free_instructors", "description": "Инструкторы без слота в это время.", "annotations": map[string]any{"readOnlyHint": true},
		"inputSchema": map[string]any{"type": "object", "required": []string{"date", "start"}, "properties": map[string]any{"date": map[string]any{"type": "string"}, "start": map[string]any{"type": "string"}}}},
	{"name": "assign_instructor", "description": "Назначить инструктора на слот.", "annotations": map[string]any{"readOnlyHint": false, "destructiveHint": false},
		"inputSchema": map[string]any{"type": "object", "required": []string{"slot_id", "instructor_id"}, "properties": map[string]any{"slot_id": map[string]any{"type": "string"}, "instructor_id": map[string]any{"type": "string"}}}},
}

func (server *Server) handle(w http.ResponseWriter, r *http.Request) {
	server.mu.Lock()
	server.headers = append(server.headers, r.Header.Clone())
	server.mu.Unlock()
	if server.RequireKey != "" && r.Header.Get("Authorization") != "Bearer "+server.RequireKey {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var request struct {
		ID     *int            `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&request); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if request.ID == nil {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	var result any
	switch request.Method {
	case "initialize":
		w.Header().Set("Mcp-Session-Id", "test-session")
		result = map[string]any{"protocolVersion": "2025-03-26", "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "accounting-test", "version": "1"}}
	case "tools/list":
		result = map[string]any{"tools": Tools}
	case "tools/call":
		var call struct {
			Name      string            `json:"name"`
			Arguments map[string]string `json:"arguments"`
		}
		_ = json.Unmarshal(request.Params, &call)
		server.mu.Lock()
		server.calls[call.Name]++
		payload, ok := server.call(call.Name, call.Arguments)
		server.mu.Unlock()
		if !ok {
			writeRPC(w, *request.ID, nil, map[string]any{"code": -32602, "message": "unknown tool"})
			return
		}
		encoded, _ := json.Marshal(payload)
		result = map[string]any{"content": []map[string]any{{"type": "text", "text": string(encoded)}}, "structuredContent": payload}
	default:
		writeRPC(w, *request.ID, nil, map[string]any{"code": -32601, "message": "method not found"})
		return
	}
	writeRPC(w, *request.ID, result, nil)
}

func (server *Server) call(name string, arguments map[string]string) (any, bool) {
	switch name {
	case "get_slots":
		result := make([]Slot, 0)
		for _, slot := range server.slots {
			if slot.Date == arguments["date"] {
				result = append(result, slot)
			}
		}
		return map[string]any{"slots": result}, true
	case "find_free_instructors":
		busy := map[string]bool{}
		for _, slot := range server.slots {
			if slot.Date == arguments["date"] && slot.Start == arguments["start"] && slot.InstructorID != "" {
				busy[slot.InstructorID] = true
			}
		}
		free := make([]map[string]string, 0)
		for id, name := range instructors {
			if !busy[id] {
				free = append(free, map[string]string{"id": id, "name": name})
			}
		}
		sort.Slice(free, func(left, right int) bool { return free[left]["id"] < free[right]["id"] })
		return map[string]any{"instructors": free}, true
	case "assign_instructor":
		for index, slot := range server.slots {
			if slot.ID == arguments["slot_id"] {
				name, known := instructors[arguments["instructor_id"]]
				if !known || slot.InstructorID != "" {
					return map[string]any{"assigned": false, "reason": "slot_taken_or_unknown_instructor"}, true
				}
				server.slots[index].InstructorID, server.slots[index].Instructor, server.slots[index].Status = arguments["instructor_id"], name, "занят"
				return map[string]any{"assigned": true, "slot": server.slots[index]}, true
			}
		}
		return map[string]any{"assigned": false, "reason": "slot_not_found"}, true
	default:
		return nil, false
	}
}

func writeRPC(w http.ResponseWriter, id int, result any, rpcError any) {
	w.Header().Set("Content-Type", "application/json")
	response := map[string]any{"jsonrpc": "2.0", "id": id}
	if rpcError != nil {
		response["error"] = rpcError
	} else {
		response["result"] = result
	}
	_ = json.NewEncoder(w).Encode(response)
}
