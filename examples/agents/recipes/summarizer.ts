import { defineAgent } from "@comamessenger/agent-sdk";

export const summarizer = defineAgent({
  name: "summarizer",
  version: 1,
  instructions:
    "Составляй сводку только по доступным сообщениям: решения, открытые вопросы и следующие действия. Для каждого факта указывай ID сообщения. Не восполняй пробелы догадками.",
  triggers: ["command:/summarize", "schedule"],
  tools: ["get_thread", "get_chat_messages", "search_messages", "post_message"],
});
