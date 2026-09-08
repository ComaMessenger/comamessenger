import { defineCatalog } from "../i18n/catalog";

export const chatsCatalog = defineCatalog(
  {
    chatListTitle: "Чаты",
    chatContextMenu: "Действия с чатом",
    pinSlots: "{used} / {limit}",
    chatListEmptyFilterTitle: "Ничего не найдено",
    chatListEmptyFilterHint:
      "В {scope} нет «{query}». Попробуйте фильтр «Все» или поиск по сообщениям.",
    chatListEmptyFilterHintNoQuery:
      "В этом разделе пока пусто. Попробуйте фильтр «Все».",
    chatListEmptyTitle: "Пока нет чатов",
    chatListEmptyHint: "Создайте группу или напишите коллеге напрямую.",
    searchInMessages: "Искать в сообщениях",
    chatListRefreshFailed: "Не удалось обновить список",
    chatListRefreshFailedHint: "Показаны сохранённые чаты. Проверьте соединение.",
    scopeAll: "чатах",
    scopeDirect: "личных чатах",
    scopeGrouped: "группах",
    scopeChannel: "каналах",
    scopeFolder: "папке «{name}»",
    previewYou: "Вы",
    previewDeleted: "Сообщение удалено",
    previewAttachment: "Вложение",
    leaveGroupTitle: "Покинуть «{name}»?",
    leaveGroupHint:
      "Вы перестанете получать сообщения. Вернуться сможете только по приглашению участника.",
    leaveChannelHint:
      "Вы перестанете получать публикации. Подписаться снова можно через поиск.",
    leaveGroupAction: "Покинуть группу…",
    leaveChannelAction: "Покинуть канал…",
    leaveGroupConfirm: "Покинуть группу",
    leaveChannelConfirm: "Покинуть канал",
    muted: "Уведомления отключены",
    pinnedChat: "Закреплённый чат",
    chatFilters: "Фильтры чатов",
  },
  {
    chatListTitle: "Chats",
    chatContextMenu: "Chat actions",
    pinSlots: "{used} / {limit}",
    chatListEmptyFilterTitle: "Nothing found",
    chatListEmptyFilterHint:
      "No “{query}” in {scope}. Try the “All” filter or search in messages.",
    chatListEmptyFilterHintNoQuery:
      "Nothing here yet. Try the “All” filter.",
    chatListEmptyTitle: "No chats yet",
    chatListEmptyHint: "Create a group or message a colleague directly.",
    searchInMessages: "Search in messages",
    chatListRefreshFailed: "Could not refresh the list",
    chatListRefreshFailedHint: "Showing saved chats. Check your connection.",
    scopeAll: "chats",
    scopeDirect: "direct chats",
    scopeGrouped: "groups",
    scopeChannel: "channels",
    scopeFolder: "the “{name}” folder",
    previewYou: "You",
    previewDeleted: "Message deleted",
    previewAttachment: "Attachment",
    leaveGroupTitle: "Leave “{name}”?",
    leaveGroupHint:
      "You will stop receiving messages. You can only come back with an invitation from a member.",
    leaveChannelHint:
      "You will stop receiving posts. You can subscribe again through search.",
    leaveGroupAction: "Leave group…",
    leaveChannelAction: "Leave channel…",
    leaveGroupConfirm: "Leave group",
    leaveChannelConfirm: "Leave channel",
    muted: "Notifications muted",
    pinnedChat: "Pinned chat",
    chatFilters: "Chat filters",
  },
);
