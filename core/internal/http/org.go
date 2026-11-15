package http

import (
	standardhttp "net/http"

	"github.com/go-chi/chi/v5"
)

// orgRoutes serve the org structure («Оргструктура», phase 6.5 wave 2). The
// contract is in packages/protocol/openapi.yaml; until package S1 lands every
// route answers 501 not_implemented and the server does not announce the
// org_structure feature, so clients keep the feature hidden.
func (h *identityHandlers) orgRoutes(protected chi.Router) {
	protected.Get("/org", h.orgNotImplemented)
	protected.Post("/org/departments", h.orgNotImplemented)
	protected.Patch("/org/departments/{departmentID}", h.orgNotImplemented)
	protected.Delete("/org/departments/{departmentID}", h.orgNotImplemented)
	protected.Post("/org/departments/{departmentID}/move", h.orgNotImplemented)
	protected.Put("/org/departments/{departmentID}/members/{actorID}", h.orgNotImplemented)
	protected.Delete("/org/departments/{departmentID}/members/{actorID}", h.orgNotImplemented)
	protected.Post("/org/departments/{departmentID}/chat", h.orgNotImplemented)
	protected.Put("/org/departments/{departmentID}/chat", h.orgNotImplemented)
	protected.Delete("/org/departments/{departmentID}/chat", h.orgNotImplemented)
	protected.Get("/org/departments/{departmentID}/chat/missing", h.orgNotImplemented)
	protected.Post("/org/departments/{departmentID}/chat/add-missing", h.orgNotImplemented)
	protected.Put("/org/people/{actorID}", h.orgNotImplemented)
	protected.Post("/org/people/assign", h.orgNotImplemented)
	protected.Post("/org/positions", h.orgNotImplemented)
	protected.Post("/org/positions/bulk", h.orgNotImplemented)
	protected.Patch("/org/positions/{positionID}", h.orgNotImplemented)
	protected.Delete("/org/positions/{positionID}", h.orgNotImplemented)
	protected.Get("/org/title-suggestions", h.orgNotImplemented)
}

func (h *identityHandlers) orgNotImplemented(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	h.writeError(w, r, standardhttp.StatusNotImplemented, "not_implemented", "The org structure is not available on this server yet.")
}
