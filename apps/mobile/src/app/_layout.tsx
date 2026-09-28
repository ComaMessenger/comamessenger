import "@/lib/polyfills";
import "@/i18n";
import { useEffect } from "react";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import {
  Onest_400Regular,
  Onest_500Medium,
  Onest_600SemiBold,
  Onest_700Bold,
  useFonts,
} from "@expo-google-fonts/onest";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider, useSession } from "@/session/SessionProvider";
import { useTheme } from "@/lib/theme";

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Onest_400Regular,
    Onest_500Medium,
    Onest_600SemiBold,
    Onest_700Bold,
  });
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <SessionProvider>
          <RootNavigator ready={fontsLoaded} />
        </SessionProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/** Each session phase unlocks its own screens; the router moves between them. */
function RootNavigator({ ready }: { ready: boolean }) {
  const { phase } = useSession();
  const theme = useTheme();
  const loading = !ready || phase.kind === "loading";

  useEffect(() => {
    if (!loading) void SplashScreen.hideAsync();
  }, [loading]);

  if (loading) return null;
  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.canvas },
        }}
      >
        <Stack.Protected guard={phase.kind === "signed-in"}>
          <Stack.Screen name="(app)" />
        </Stack.Protected>
        <Stack.Protected guard={phase.kind === "signed-out"}>
          <Stack.Screen name="login" />
          <Stack.Screen name="forgot-password" />
          <Stack.Screen name="invite" />
        </Stack.Protected>
        <Stack.Protected guard={phase.kind === "offline"}>
          <Stack.Screen name="offline" />
        </Stack.Protected>
        <Stack.Protected guard={phase.kind === "server"}>
          <Stack.Screen name="server" />
        </Stack.Protected>
      </Stack>
    </>
  );
}
