import type {
  AgentConfirmationMode,
  AgentConfirmationPolicy,
} from "@comamessenger/core";
import type { ReactNode } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Segmented, Switch, cx } from "../../ui";
import { skills, type Capabilities } from "../shared/capabilities";
import {
  actionLocked,
  actionMode,
  skillActions,
  withActionMode,
  type ConfirmableAction,
} from "../shared/confirmation";
import { BuilderBlock } from "./BuilderBlock";

/**
 * «Сам» or «После подтверждения» for one action. A mode the server always
 * enforces is shown, not offered.
 */
export function ModeChoice({
  label,
  mode,
  locked,
  lockedReason,
  onChange,
}: {
  label: string;
  mode: AgentConfirmationMode;
  locked: boolean;
  lockedReason: string;
  onChange(mode: AgentConfirmationMode): void;
}) {
  const { t } = useTranslation();
  if (locked)
    return (
      <span className={cx("agent-mode", "agent-mode--confirm")} title={lockedReason}>
        <Lock aria-hidden="true" />
        {t("agentMode_confirm")}
      </span>
    );
  return (
    <Segmented<AgentConfirmationMode>
      label={t("agentModeChoice", { action: label })}
      value={mode}
      onChange={onChange}
      items={[
        { id: "auto", label: t("agentMode_self") },
        {
          id: "confirm",
          label: (
            <>
              <ShieldCheck aria-hidden="true" />
              {t("agentMode_confirm")}
            </>
          ),
        },
      ]}
    />
  );
}

/**
 * Block 3: actions in plain language, each with «сам» or «после
 * подтверждения». The choice is part of the draft and takes effect when the
 * agent is published; the server keeps its own floor.
 */
export function SkillsBlock({
  capabilities,
  onChange,
  policy,
  locked,
  onPolicy,
  children,
}: {
  capabilities: Capabilities;
  onChange(value: Capabilities): void;
  policy: AgentConfirmationPolicy | undefined;
  locked: readonly string[] | undefined;
  onPolicy(policy: AgentConfirmationPolicy): void;
  /** External systems the agent may use, below the built-in actions. */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <BuilderBlock
      anchor="skills"
      marker="3"
      title={t("agentBlockSkills")}
      hint={t("agentBlockSkillsHint")}
    >
      {skills.map((skill) => {
        const checked = capabilities.skills.includes(skill);
        return (
          <div key={skill} className="agent-skill">
            <div className="agent-line agent-line--skill">
              <span className="agent-line__text">
                <strong>{t(`agentSkill_${skill}`)}</strong>
                <small>{t(`agentSkillHint_${skill}`)}</small>
              </span>
              <span className="agent-line__control">
                <Switch
                  label={t(`agentSkill_${skill}`)}
                  checked={checked}
                  onChange={(value) =>
                    onChange({
                      ...capabilities,
                      skills: value
                        ? [...capabilities.skills, skill]
                        : capabilities.skills.filter((item) => item !== skill),
                    })
                  }
                />
              </span>
            </div>
            {checked &&
              skillActions[skill].map((action: ConfirmableAction) => {
                const label = t(`agentAction_${action}`);
                const mode = actionLocked(locked, action)
                  ? "confirm"
                  : actionMode(policy, action);
                return (
                  <div key={action} className="agent-line agent-line--action">
                    <span className="agent-line__text">
                      <span>{label}</span>
                      <small>
                        {t(
                          mode === "auto"
                            ? "agentActionAutoHint"
                            : "agentActionConfirmHint",
                        )}
                      </small>
                    </span>
                    <span className="agent-line__control">
                      <ModeChoice
                        label={label}
                        mode={mode}
                        locked={actionLocked(locked, action)}
                        lockedReason={t("agentActionLockedServer")}
                        onChange={(next) =>
                          onPolicy(withActionMode(policy, action, next))
                        }
                      />
                    </span>
                  </div>
                );
              })}
          </div>
        );
      })}
      {children}
      <p className="agent-block__note">
        <ShieldCheck aria-hidden="true" />
        {t("agentSkillsPolicy")}
      </p>
    </BuilderBlock>
  );
}
