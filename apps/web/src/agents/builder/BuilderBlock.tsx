import type { ReactNode } from "react";
import type { BuilderAnchor } from "../routes";

export function blockID(anchor: BuilderAnchor) {
  return `agent-block-${anchor}`;
}

/** One numbered block of the builder page. */
export function BuilderBlock({
  anchor,
  marker,
  title,
  hint,
  children,
}: {
  anchor: BuilderAnchor;
  marker: ReactNode;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  const headingID = `${blockID(anchor)}-title`;
  return (
    <section
      id={blockID(anchor)}
      className="agent-block"
      aria-labelledby={headingID}
    >
      <header className="agent-block__head">
        <span className="agent-block__marker" aria-hidden="true">
          {marker}
        </span>
        <span>
          <h3 id={headingID}>{title}</h3>
          <p>{hint}</p>
        </span>
      </header>
      {children}
    </section>
  );
}

/** A row with text on the left and a control on the right. */
export function BlockLine({
  icon,
  title,
  hint,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="agent-line">
      {icon && (
        <span className="agent-line__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="agent-line__text">
        <strong>{title}</strong>
        {hint && <small>{hint}</small>}
      </span>
      {children && <span className="agent-line__control">{children}</span>}
    </div>
  );
}
