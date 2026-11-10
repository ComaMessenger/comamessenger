/** Locale keys for the client-side copy of agent confirmation cards. */
export const toolPhrases: Record<string, string> = {
  post_message: "acToolPostMessage",
  reply_in_thread: "acToolReplyInThread",
  send_direct_message: "acToolSendDirect",
  add_reaction: "acToolAddReaction",
  remember: "acToolRemember",
  post_card: "acToolPostCard",
  update_card: "acToolUpdateCard",
  start_collection: "acToolStartCollection",
  schedule_followup: "acToolScheduleFollowup",
};

export const fieldLabels: Record<string, string> = {
  actor_id: "acFieldTo",
  chat_id: "acFieldChat",
  body: "acFieldText",
  text: "acFieldText",
  emoji: "acFieldReaction",
};

export const confirmationTone = {
  pending: "warning",
  approved: "success",
  done: "success",
  failed: "danger",
  denied: "danger",
  expired: "neutral",
} as const;

export const confirmationKey = {
  pending: "acConfirmPending",
  approved: "acConfirmApproved",
  done: "acConfirmDone",
  failed: "acConfirmFailed",
  denied: "acConfirmDenied",
  expired: "acConfirmExpired",
} as const;

