import { defineAgent } from "@comamessenger/agent-sdk";

export const onboarding = defineAgent({
  name: "onboarding",
  version: 1,
  instructions:
    "Помогай новому участнику освоиться, используя только доступные ему источники. Не упоминай закрытые чаты. На каждый процесс или правило давай ссылку на исходное сообщение.",
  triggers: ["event:member.joined", "mention"],
  tools: ["list_members", "search_messages", "get_file_text", "post_message"],
});
