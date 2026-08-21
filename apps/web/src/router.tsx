import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { App } from "./App";
import { settingsRegistry } from "./settings";

const root = createRootRoute({ component: App });
const marker = () => null;
const settingsRoutes = settingsRegistry.map((entry) =>
  createRoute({
    getParentRoute: () => root,
    path: entry.path,
    component: marker,
  }),
);
const routes = [
  createRoute({ getParentRoute: () => root, path: "/", component: marker }),
  createRoute({
    getParentRoute: () => root,
    path: "/chats",
    component: marker,
    validateSearch: (search: Record<string, unknown>) => ({
      filter:
        search.filter === "direct" ||
        search.filter === "grouped" ||
        search.filter === "channel"
          ? search.filter
          : "all",
      folder: typeof search.folder === "string" ? search.folder : undefined,
    }),
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/chat/$chatId",
    component: marker,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/chat/$chatId/thread/$threadId",
    component: marker,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/threads",
    component: marker,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/important",
    component: marker,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/members",
    component: marker,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/agents",
    component: marker,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/agents/sandbox",
    component: marker,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/agents/runs",
    component: marker,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/agents/connections",
    component: marker,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/more",
    component: marker,
  }),
  ...settingsRoutes,
  createRoute({
    getParentRoute: () => root,
    path: "/m/$messageKey",
    component: marker,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/invite/$token",
    component: marker,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/reset-password",
    component: marker,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/dev/components",
    component: marker,
  }),
];
export const router = createRouter({ routeTree: root.addChildren(routes) });
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
