import type { MessageAgentProvenance } from "@comamessenger/core";
import {
  AtSign,
  BellRing,
  CalendarClock,
  Clock,
  Hand,
  ListChecks,
  MessageSquare,
  MousePointerClick,
  Plug,
  ShieldCheck,
  SquareSlash,
  Tag,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";

const icons: Record<MessageAgentProvenance["trigger"], typeof Clock> = {
  manual: Hand,
  mention: AtSign,
  command: SquareSlash,
  keyword: Tag,
  every_message: MessageSquare,
  schedule: Clock,
  event: Zap,
  webhook: Plug,
  followup: CalendarClock,
  message_action: MousePointerClick,
  collection: ListChecks,
  confirmation: ShieldCheck,
};

/**
 * «Why» under an agent message: what made the agent write it. The server
 * gives only the kind and a short label set by builders.
 */
export function AgentWhy({
  provenance,
}: {
  provenance: MessageAgentProvenance | undefined;
}) {
  const { t } = useTranslation();
  if (!provenance) return null;
  const Icon = icons[provenance.trigger] ?? BellRing;
  const reason = t(`acWhy_${provenance.trigger}`, {
    defaultValue: t("acWhy_manual"),
  });
  return (
    <p className="agent-why" data-testid="agent-why">
      <Icon aria-hidden="true" />
      <span>
        {provenance.trigger_label
          ? t("acWhyWithLabel", { reason, label: provenance.trigger_label })
          : reason}
      </span>
    </p>
  );
}
