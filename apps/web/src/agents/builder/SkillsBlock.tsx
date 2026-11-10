import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Switch, cx } from "../../ui";
import {
  skillMode,
  skills,
  type Capabilities,
  type SkillMode,
} from "../shared/capabilities";
import { BuilderBlock } from "./BuilderBlock";

function ModeTag({ mode }: { mode: SkillMode }) {
  const { t } = useTranslation();
  return (
    <span className={cx("agent-mode", `agent-mode--${mode}`)}>
      {mode !== "self" && <ShieldCheck aria-hidden="true" />}
      {t(`agentMode_${mode}`)}
    </span>
  );
}

/**
 * Block 3: actions in plain language. Whether an action waits for a person is
 * the workspace policy enforced by the server; the block states it honestly
 * instead of offering a switch the server would ignore.
 */
export function SkillsBlock({
  capabilities,
  onChange,
}: {
  capabilities: Capabilities;
  onChange(value: Capabilities): void;
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
          <div key={skill} className="agent-line agent-line--skill">
            <span className="agent-line__text">
              <strong>{t(`agentSkill_${skill}`)}</strong>
              <small>{t(`agentSkillHint_${skill}`)}</small>
            </span>
            <span className="agent-line__control">
              <ModeTag mode={skillMode[skill]} />
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
        );
      })}
      <p className="agent-block__note">
        <ShieldCheck aria-hidden="true" />
        {t("agentSkillsPolicy")}
      </p>
    </BuilderBlock>
  );
}
