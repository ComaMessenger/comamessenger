import { useTranslation } from "react-i18next";
import { InlineError, SkeletonRow } from "../ui";
import { useMessenger } from "../shell/MessengerContext";
import { DirectoryDetailHead } from "./DirectoryPage";
import { DepartmentProfile } from "./DepartmentProfile";
import { useActorMap, useAllActors, useOrgStructure } from "../org/useOrg";

/** Phone route `/members/departments/:id` — the department card as a screen. */
export function DepartmentProfilePage({ departmentID }: { departmentID: string }) {
  const { t } = useTranslation();
  const { api, navigate } = useMessenger();
  const org = useOrgStructure(api);
  const everyone = useAllActors(api);
  const actors = useActorMap(everyone.data);
  const back = () => navigate("/members");
  if (org.isError || everyone.isError)
    return (
      <div className="member-profile member-profile--page">
        <DirectoryDetailHead onBack={back} title={t("orgDepartment")} />
        <InlineError
          center
          title={t("threadsLoadFailed")}
          retryLabel={t("retry")}
          onRetry={() => {
            void org.refetch();
            void everyone.refetch();
          }}
        />
      </div>
    );
  if (!org.data || !everyone.data)
    return (
      <div className="member-profile member-profile--page">
        <DirectoryDetailHead onBack={back} title={t("orgDepartment")} />
        <div className="member-profile__scroll">
          <SkeletonRow avatar={64} lines={["40%", "60%"]} />
        </div>
      </div>
    );
  return (
    <DepartmentProfile
      departmentID={departmentID}
      structure={org.data}
      actors={actors}
      onBack={back}
      standalone
    />
  );
}
