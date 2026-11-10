import { useTranslation } from "react-i18next";
import type { ChatCommand } from "@comamessenger/core";
import { Avatar, cx } from "../ui";

/** Listbox of agent commands shown above the composer while typing "/". */
export function CommandMenu({
  id,
  commands,
  query,
  activeIndex,
  onHover,
  onPick,
}: {
  id: string;
  commands: ChatCommand[];
  query: string;
  activeIndex: number;
  onHover(index: number): void;
  onPick(command: ChatCommand): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="command-menu">
      <div className="command-menu__label" id={`${id}-label`}>
        {t("acCommandsLabel")}
      </div>
      {commands.length === 0 ? (
        <p className="command-menu__empty">{t("acCommandsEmpty", { query })}</p>
      ) : (
        <ul id={id} role="listbox" aria-labelledby={`${id}-label`} className="command-menu__list">
          {commands.map((command, index) => (
            <li
              key={`${command.agentID}/${command.command}`}
              id={`${id}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={cx("command-menu__item", index === activeIndex && "command-menu__item--active")}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onHover(index)}
              onClick={() => onPick(command)}
            >
              <Avatar
                name={command.agentName}
                seed={command.agentID}
                actorID={command.agentID}
                avatarVersion={command.avatarVersion}
                agent
                size="xs"
              />
              <code className="command-menu__command">/{command.command}</code>
              <span className="command-menu__meta truncate">
                {command.description ? `${command.agentName} · ${command.description}` : command.agentName}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="command-menu__hint" aria-hidden="true">
        {t("acCommandsHint")}
      </div>
    </div>
  );
}
