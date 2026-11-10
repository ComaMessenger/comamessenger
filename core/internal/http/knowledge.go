package http

import (
	"errors"
	standardhttp "net/http"
	"strings"

	"github.com/comamessenger/comamessenger/core/internal/agentauthz"
	"github.com/comamessenger/comamessenger/core/internal/knowledge"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func (h *identityHandlers) knowledgeRoutes(protected chi.Router) {
	protected.Get("/knowledge/collections", h.listKnowledgeCollections)
	protected.Post("/knowledge/collections", h.createKnowledgeCollection)
	protected.Get("/knowledge/collections/{collectionID}", h.getKnowledgeCollection)
	protected.Patch("/knowledge/collections/{collectionID}", h.updateKnowledgeCollection)
	protected.Delete("/knowledge/collections/{collectionID}", h.deleteKnowledgeCollection)
	protected.Get("/knowledge/collections/{collectionID}/documents", h.listKnowledgeDocuments)
	protected.Post("/knowledge/collections/{collectionID}/documents", h.createKnowledgeDocument)
	protected.Get("/knowledge/documents/{documentID}", h.getKnowledgeDocument)
	protected.Patch("/knowledge/documents/{documentID}", h.updateKnowledgeDocument)
	protected.Delete("/knowledge/documents/{documentID}", h.deleteKnowledgeDocument)
	protected.Post("/knowledge/search", h.searchKnowledge)
	protected.Get("/knowledge/runs/{runID}/fragments", h.listKnowledgeRunFragments)
}

func (h *identityHandlers) listKnowledgeCollections(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.knowledge.ListCollections(r.Context(), authFromContext(r.Context()).User)
	h.writeKnowledge(w, r, standardhttp.StatusOK, result, err)
}

func (h *identityHandlers) createKnowledgeCollection(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input knowledge.CreateCollectionInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.knowledge.CreateCollection(r.Context(), authFromContext(r.Context()).User, input)
	if err == nil {
		w.Header().Set("Location", "/api/v1/knowledge/collections/"+result.ID)
	}
	h.writeKnowledge(w, r, standardhttp.StatusCreated, result, err)
}

func (h *identityHandlers) getKnowledgeCollection(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.knowledge.GetCollection(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "collectionID"))
	h.writeKnowledge(w, r, standardhttp.StatusOK, result, err)
}

func (h *identityHandlers) updateKnowledgeCollection(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input knowledge.UpdateCollectionInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.knowledge.UpdateCollection(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "collectionID"), input)
	h.writeKnowledge(w, r, standardhttp.StatusOK, result, err)
}

func (h *identityHandlers) deleteKnowledgeCollection(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	err := h.knowledge.DeleteCollection(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "collectionID"))
	h.writeKnowledge(w, r, standardhttp.StatusNoContent, nil, err)
}

func (h *identityHandlers) listKnowledgeDocuments(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.knowledge.ListDocuments(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "collectionID"))
	h.writeKnowledge(w, r, standardhttp.StatusOK, result, err)
}

func (h *identityHandlers) createKnowledgeDocument(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input knowledge.CreateDocumentInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.knowledge.CreateDocument(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "collectionID"), input)
	if err == nil {
		w.Header().Set("Location", "/api/v1/knowledge/documents/"+result.ID)
	}
	h.writeKnowledge(w, r, standardhttp.StatusCreated, result, err)
}

func (h *identityHandlers) getKnowledgeDocument(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.knowledge.GetDocument(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "documentID"))
	h.writeKnowledge(w, r, standardhttp.StatusOK, result, err)
}

func (h *identityHandlers) updateKnowledgeDocument(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input knowledge.UpdateDocumentInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.knowledge.UpdateDocument(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "documentID"), input)
	h.writeKnowledge(w, r, standardhttp.StatusOK, result, err)
}

func (h *identityHandlers) deleteKnowledgeDocument(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	err := h.knowledge.DeleteDocument(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "documentID"))
	h.writeKnowledge(w, r, standardhttp.StatusNoContent, nil, err)
}

func (h *identityHandlers) searchKnowledge(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input knowledge.SearchInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.knowledge.Search(r.Context(), authFromContext(r.Context()).User, input)
	h.writeKnowledge(w, r, standardhttp.StatusOK, result, err)
}

// listKnowledgeRunFragments exposes which fragments a run received. It is an
// agent activity view, so it follows the agents.* viewing permissions.
func (h *identityHandlers) listKnowledgeRunFragments(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	current := authFromContext(r.Context()).User
	if !agentauthz.New().CanView(current) {
		h.writeKnowledge(w, r, standardhttp.StatusOK, nil, knowledge.ErrForbidden)
		return
	}
	runID := chi.URLParam(r, "runID")
	if uuid.Validate(runID) != nil {
		h.writeKnowledge(w, r, standardhttp.StatusOK, nil, knowledge.ErrNotFound)
		return
	}
	result, err := h.knowledge.RunFragments(r.Context(), current.OrgID, runID)
	h.writeKnowledge(w, r, standardhttp.StatusOK, map[string]any{"fragments": result}, err)
}

func (h *identityHandlers) writeKnowledge(w standardhttp.ResponseWriter, r *standardhttp.Request, status int, payload any, err error) {
	switch {
	case err == nil && status == standardhttp.StatusNoContent:
		w.WriteHeader(status)
	case err == nil:
		writeJSON(h.logger, w, status, payload)
	case errors.Is(err, knowledge.ErrInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", trimErrorPrefix(err))
	case errors.Is(err, knowledge.ErrForbidden):
		h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "Managing the knowledge base requires the knowledge.manage permission.")
	case errors.Is(err, knowledge.ErrNotFound):
		h.writeError(w, r, standardhttp.StatusNotFound, "knowledge_not_found", "The knowledge collection or document was not found.")
	case errors.Is(err, knowledge.ErrConflict):
		h.writeError(w, r, standardhttp.StatusConflict, "knowledge_conflict", trimErrorPrefix(err))
	default:
		h.internalError(w, r, err)
	}
}

func trimErrorPrefix(err error) string {
	message := err.Error()
	if index := strings.Index(message, ": "); index >= 0 {
		return message[index+2:]
	}
	return message
}
