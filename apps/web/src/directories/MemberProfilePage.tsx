import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { EmptyState, InlineError, SkeletonRow } from "../ui";
import { useMessenger } from "../shell/MessengerContext";
import { DirectoryDetailHead } from "./DirectoryPage";
import { MemberProfile } from "./MemberProfile";

/** Mobile route `/members/:actorId` — the profile as a full screen. */
export function MemberProfilePage({ actorID }: { actorID: string }) {
  const { t } = useTranslation();
  const { api, navigate } = useMessenger();
  const back = () => navigate("/members");
  // The directory endpoint has no single-actor lookup; page through until the actor shows up.
  const query = useQuery({
    queryKey: ["actor", actorID],
    queryFn: async () => {
      let after = "";
      for (let page = 0; page < 20; page += 1) {
        const result = await api.actors("", after);
        const found = result.actors.find((actor) => actor.actor_id === actorID);
        if (found) return found;
        if (!result.next_after_id) break;
        after = result.next_after_id;
      }
      return null;
    },
    staleTime: 5 * 60_000,
  });
  if (query.isLoading) {
    return (
      <div className="member-profile member-profile--page">
        <DirectoryDetailHead onBack={back} title={t("memberProfileTitle")} />
        <div className="member-profile__scroll">
          <SkeletonRow avatar={64} lines={["40%", "60%"]} />
        </div>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="member-profile member-profile--page">
        <DirectoryDetailHead onBack={back} title={t("memberProfileTitle")} />
        <InlineError center title={t("threadsLoadFailed")} retryLabel={t("retry")} onRetry={() => void query.refetch()} />
      </div>
    );
  }
  if (!query.data) {
    return (
      <div className="member-profile member-profile--page">
        <DirectoryDetailHead onBack={back} title={t("memberProfileTitle")} />
        <EmptyState title={t("memberNotFound")} />
      </div>
    );
  }
  return <MemberProfile actor={query.data} onBack={back} standalone />;
}
