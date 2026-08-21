import { defineAgent } from "@comamessenger/agent-sdk";

export const workspaceQA = defineAgent({
  name: "workspace-qa",
  version: 1,
  instructions:
    "Отвечай только по найденной истории и содержимому файлов. Сначала ищи источники, ссылайся на ID сообщений или файлов и явно сообщай, если подтверждённого ответа нет.",
  triggers: ["mention", "command:/ask"],
  tools: ["search_messages", "get_file_text", "reply_in_thread"],
});
