import type { QueryClient } from "@tanstack/react-query";
import { pollKeys, requestKeys, taskKeys } from "@comamessenger/core";

/**
 * Lists that show polls: «Ждут вас» (the wave 3 list and the wave 1 inbox
 * of servers without tasks). The faces and «Кто голосовал» are keyed by the
 * poll's version and follow by themselves.
 */
export function invalidatePollLists(queryClient: QueryClient, userID: string) {
  void queryClient.invalidateQueries({ queryKey: pollKeys.waiting(userID) });
  void queryClient.invalidateQueries({
    queryKey: [...taskKeys.all(userID), "waiting"],
  });
  void queryClient.invalidateQueries({
    queryKey: [...requestKeys.all(userID), "inbox"],
  });
}
