import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { App } from "./App";

const root = createRootRoute({ component: App });
const marker = () => null;
const routes = [
  createRoute({ getParentRoute: () => root, path: "/", component: marker }),
  createRoute({
    getParentRoute: () => root,
    path: "/chats",
    component: marker,
    validateSearch: (search: Record<string, unknown>) => ({
      filter:
        search.filter === "direct" || search.filter === "grouped"
          ? search.filter
          : "all",
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
