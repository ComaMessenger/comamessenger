import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ActorSummary } from "@comamessenger/core";
import { Avatar, FloatingPopover, SkeletonRow, cx } from "../ui";
import { useMessenger } from "../shell/MessengerContext";

/** Token input with a workspace-wide actor suggestion popover. */
export function ActorPicker({
  label,
  placeholder,
  selected,
  exclude = [],
  onChange,
}: {
  label: string;
  placeholder: string;
  selected: ActorSummary[];
  exclude?: string[];
  onChange(next: ActorSummary[]): void;
}) {
  const { t } = useTranslation();
  const { api, user } = useMessenger();
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<ActorSummary[] | null>(null);
  const [active, setActive] = useState(0);
  const control = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focused) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      void api
        .actors(query.trim())
        .then((page) => {
          if (alive) setSuggestions(page.actors);
        })
        .catch(() => {
          if (alive) setSuggestions([]);
        });
    }, 150);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [api, focused, query]);
  const hidden = new Set([user.id, ...exclude, ...selected.map((actor) => actor.actor_id)]);
  const visible = (suggestions ?? []).filter((actor) => !hidden.has(actor.actor_id)).slice(0, 6);
  function add(actor: ActorSummary) {
    onChange([...selected, actor]);
    setQuery("");
    setActive(0);
    input.current?.focus();
  }
  return (
    <div className="actor-picker">
      <span className="ui-field__label">
        <span>{label}</span>
      </span>
      <div
        ref={control}
        className={cx("actor-picker__control", focused && "actor-picker__control--focused")}
        onClick={() => input.current?.focus()}
      >
        {selected.map((actor) => (
          <span
            key={actor.actor_id}
            className={cx("actor-picker__chip", actor.type === "agent" && "actor-picker__chip--agent")}
          >
            <Avatar name={actor.display_name} seed={actor.actor_id} actorID={actor.actor_id} avatarVersion={actor.avatar_version} size="xs" square={actor.type === "agent"} />
            <span className="truncate">{actor.display_name}</span>
            <button
              type="button"
              className="actor-picker__remove"
              aria-label={t("removeMember", { name: actor.display_name })}
              onClick={(event) => {
                event.stopPropagation();
                onChange(selected.filter((item) => item.actor_id !== actor.actor_id));
              }}
            >
              <X aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          ref={input}
          value={query}
          placeholder={selected.length ? "" : placeholder}
          aria-label={label}
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => Math.min(index + 1, Math.max(0, visible.length - 1)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter" && visible[active]) {
              event.preventDefault();
              add(visible[active]!);
            } else if (event.key === "Backspace" && !query && selected.length) {
              onChange(selected.slice(0, -1));
            }
          }}
        />
      </div>
      {focused && (
        <FloatingPopover anchorRef={control} matchAnchorWidth gap={4} className="actor-picker__popover" onDismiss={() => setFocused(false)}>
          <div className="actor-picker__menu" role="listbox" aria-label={label}>
            {suggestions === null ? (
              <SkeletonRow avatar={24} />
            ) : visible.length === 0 ? (
              <span className="actor-picker__empty">{t("searchNoPeople")}</span>
            ) : (
              visible.map((actor, index) => (
                <button
                  key={actor.actor_id}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className={cx("actor-picker__option", index === active && "actor-picker__option--active")}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => add(actor)}
                >
                  <Avatar name={actor.display_name} seed={actor.actor_id} actorID={actor.actor_id} avatarVersion={actor.avatar_version} size="xs" square={actor.type === "agent"} />
                  <strong className="truncate">
                    <Highlight text={actor.display_name} query={query} />
                  </strong>
                  <small>@{actor.handle}</small>
                </button>
              ))
            )}
          </div>
        </FloatingPopover>
      )}
    </div>
  );
}

/** Wraps the matched prefix/substring of `text` in a primary-colored <b>. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return <>{text}</>;
  const index = text.toLocaleLowerCase().indexOf(needle);
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <b className="text-highlight">{text.slice(index, index + needle.length)}</b>
      {text.slice(index + needle.length)}
    </>
  );
}
