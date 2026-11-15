import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  departmentPath,
  orgIndex,
  type MessengerAPI,
  type OrgStructure,
} from "@comamessenger/core";
import { Button, CheckMark, Dialog, FormError, SelectField } from "../ui";
import { orgErrorText, useOrgRefresh } from "./useOrg";

/** Most additional departments a person may have (409 org_limit_reached). */
const maxAdditional = 10;

/**
 * A person's whole assignment at once (setPersonOrg): the primary
 * department, additional ones ("also") and the position. Used in the
 * person card ("Department and position") and in Members of the
 * workspace settings.
 */
export function PersonOrgForm({
  api,
  actorID,
  structure,
  onSaved,
  onCancel,
}: {
  api: MessengerAPI;
  actorID: string;
  structure: OrgStructure;
  onSaved(): void;
  onCancel?(): void;
}) {
  const { t } = useTranslation();
  const refresh = useOrgRefresh();
  const index = orgIndex(structure);
  const current = index.people.get(actorID);
  const [primary, setPrimary] = useState(current?.primary_department_id ?? "");
  const [additional, setAdditional] = useState<string[]>(
    current?.additional_department_ids ?? [],
  );
  const [position, setPosition] = useState(current?.position_id ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const extra = additional.filter((id) => id !== primary);

  function toggleAdditional(id: string) {
    setAdditional((list) =>
      list.includes(id) ? list.filter((item) => item !== id) : [...list, id],
    );
  }

  async function save() {
    setPending(true);
    setError("");
    try {
      await api.setPersonOrg(actorID, {
        primary_department_id: primary || null,
        additional_department_ids: primary ? extra : [],
        position_id: position || null,
        expected_org_version: structure.version,
      });
      await refresh();
      onSaved();
    } catch (cause) {
      setError(orgErrorText(cause));
      void refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="org-person-form">
      <SelectField
        label={t("orgPrimaryDepartment")}
        name="org-primary"
        value={primary}
        onChange={(event) => setPrimary(event.target.value)}
      >
        <option value="">{t("orgNoDepartment")}</option>
        {index.order.map((department) => (
          <option key={department.id} value={department.id}>
            {departmentPath(structure, department.id)}
          </option>
        ))}
      </SelectField>
      <fieldset className="org-person-form__additional">
        <legend>{t("orgAdditionalDepartments")}</legend>
        {!primary ? (
          <p className="org-hint">{t("orgAdditionalNeedsPrimary")}</p>
        ) : (
          <div className="org-check-list">
            {index.order
              .filter((department) => department.id !== primary)
              .map((department) => {
                const checked = extra.includes(department.id);
                return (
                  <label key={department.id} className="org-check">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && extra.length >= maxAdditional}
                      onChange={() => toggleAdditional(department.id)}
                    />
                    <CheckMark checked={checked} />
                    <span className="truncate">
                      {departmentPath(structure, department.id)}
                    </span>
                  </label>
                );
              })}
          </div>
        )}
      </fieldset>
      <SelectField
        label={t("orgPosition")}
        name="org-position"
        value={position}
        onChange={(event) => setPosition(event.target.value)}
      >
        <option value="">{t("orgNoPosition")}</option>
        {index.positionOrder.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </SelectField>
      {error && <FormError message={error} />}
      <div className="org-person-form__actions">
        {onCancel && <Button onClick={onCancel}>{t("cancel")}</Button>}
        <Button variant="primary" pending={pending} onClick={() => void save()}>
          {t("save")}
        </Button>
      </div>
    </div>
  );
}

export function PersonOrgDialog({
  api,
  actorID,
  name,
  structure,
  onClose,
}: {
  api: MessengerAPI;
  actorID: string;
  name: string;
  structure: OrgStructure;
  onClose(): void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      title={t("orgEditPersonTitle", { name })}
      onClose={onClose}
      sheet
    >
      <PersonOrgForm
        api={api}
        actorID={actorID}
        structure={structure}
        onSaved={onClose}
        onCancel={onClose}
      />
    </Dialog>
  );
}
