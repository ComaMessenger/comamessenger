import { Image } from "expo-image";
import { StyleSheet } from "react-native";
import { radius } from "@comamessenger/tokens";
import { useSession } from "@/session/SessionProvider";
import { useTheme } from "@/lib/theme";
import { WorkspaceMark } from "@/ui/WorkspaceMark";

/** The workspace logo from branding, or its initial when there is none. */
export function WorkspaceLogo({
  name,
  size = 48,
}: {
  name: string;
  size?: number;
}) {
  const { api, branding } = useSession();
  const theme = useTheme();
  if (!branding?.logo_url || !api)
    return <WorkspaceMark name={name} size={size} />;
  return (
    <Image
      accessibilityIgnoresInvertColors
      source={{ uri: `${api.apiURL}${branding.logo_url}` }}
      style={[
        styles.logo,
        { width: size, height: size, borderColor: theme.border },
      ]}
      contentFit="cover"
    />
  );
}

const styles = StyleSheet.create({
  logo: { borderRadius: radius.md, borderWidth: 1 },
});
