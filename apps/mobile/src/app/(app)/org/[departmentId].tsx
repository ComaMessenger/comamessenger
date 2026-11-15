import { useLocalSearchParams } from "expo-router";
import { DepartmentScreen } from "@/org/DepartmentScreen";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

export default function DepartmentRoute() {
  const { departmentId } = useLocalSearchParams<{ departmentId: string }>();
  return <DepartmentScreen key={departmentId} departmentID={departmentId} />;
}
