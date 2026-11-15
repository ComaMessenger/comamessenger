import { defineCatalog } from "../i18n/catalog";

/** «Оргструктура» (phase 6.5 wave 2): people, cards, tree, settings, @отдел. */
export const orgCatalog = defineCatalog(
  {
    orgStructure: "Оргструктура",
    orgSettingsHint:
      "Отделы, руководители, должности и кто где работает",
    orgSection: "Оргструктура",
    orgDepartment: "Отдел",
    orgPosition: "Должность",
    orgNoPosition: "Без должности",
    orgNoDepartment: "Без отдела",
    orgTopLevel: "верхний уровень",
    orgLead: "Руководитель",
    orgNoLead: "Руководитель не назначен",
    orgPartOf: "входит в",
    orgPartOfField: "Входит в",
    orgMarkLead: "рук.",
    orgMarkAdditional: "совм.",
    orgPeopleCount:
      "{count, plural, one {# сотрудник} few {# сотрудника} many {# сотрудников} other {# сотрудника}}",
    orgPeopleShort: "{count} чел.",
    orgMembers: "Сотрудники · {count}",
    orgMembersEmpty: "В отделе пока никого нет",
    orgSubdepartments: "Подотделы · {count}",
    orgSubordinates: "Подчинённые · {count}",
    orgShowAll: "Все",
    orgShowLess: "Свернуть",
    orgDepartmentCaption: "отдел",
    orgAdditionalCaption: "совместительство",
    orgManagerCaption: "руководитель",
    orgEdit: "Изменить",
    orgEditPerson: "Отдел и должность",
    orgEditPersonTitle: "Отдел и должность: {name}",
    orgDepartmentMenu: "Действия с отделом",
    orgDepartmentGone: "Отдела больше нет",
    orgDepartmentGoneHint: "Его удалили или перенесли. Вернитесь к списку.",
    orgOpenDepartment: "Открыть отдел «{name}»",
    orgFold: "Свернуть «{name}»",
    orgUnfold: "Развернуть «{name}»",

    orgViewLabel: "Вид списка",
    orgViewList: "Список",
    orgViewGroups: "По отделам",
    orgViewTree: "Структура",
    orgMembersLead:
      "{humans, plural, one {# человек} few {# человека} many {# человек} other {# человека}} · {departments, plural, one {# отдел} few {# отдела} many {# отделов} other {# отдела}}",
    orgMembersSearch: "Имя, должность или отдел",
    orgTreeSearch: "Найти отдел или человека",
    orgTreeLabel: "Оргструктура «{name}»",
    orgTreeItemLabel: "{name}, {count} чел.",
    orgTreeNothingFound: "Ничего не нашлось",
    orgGroupsEmpty: "Здесь никого нет",
    orgGroupsEmptyHint: "Выберите другой отдел или «Все».",
    orgAgentsGroup: "Агенты",
    orgAgentsGroupHint: "Не входят в отделы",

    orgChatOpen: "Чат отдела",
    orgChatCreate: "Создать чат отдела",
    orgChatNotMember:
      "У отдела есть чат, но вас в нём нет. Попросите руководителя отдела добавить вас.",
    orgChatArchived: "Чат отдела в архиве",
    orgChatMissing:
      "В чате нет {count, plural, one {# сотрудника} few {# сотрудников} many {# сотрудников} other {# сотрудника}} отдела",
    orgChatAddMissing: "Добавить",
    orgChatAdded:
      "{count, plural, =0 {Все уже в чате} one {Добавлен # человек} few {Добавлены # человека} many {Добавлены # человек} other {Добавлены # человека}}",
    orgChatLink: "Привязать чат",
    orgChatUnlink: "Отвязать чат",
    orgChatLinked: "Чат привязан к отделу",
    orgChatUnlinked: "Чат отвязан. Он остался, участники тоже",
    orgChatLinkTitle: "Чат для отдела «{name}»",
    orgChatLinkHint:
      "Подойдёт группа, где вы владелец или администратор. Состав чата не изменится.",
    orgChatLinkSearch: "Найти группу",
    orgChatLinkAction: "Привязать",
    orgChatLinkEmpty: "Нет подходящих групп",

    orgPrimaryDepartment: "Основной отдел",
    orgAdditionalDepartments: "Совместительство",
    orgAdditionalNeedsPrimary:
      "Сначала выберите основной отдел, потом дополнительные.",
    orgAdditionalFootnote:
      "Совместители: дополнительный отдел добавляется в карточке человека или в составе отдела.",

    orgTabDepartments: "Отделы",
    orgTabPositions: "Должности",
    orgTabUnassigned: "Без отдела · {count}",
    orgEmptyTitle: "Создайте первый отдел",
    orgEmptyHint:
      "Отделы появятся в «Участниках», в карточках людей и в подсказке @.",
    orgAddDepartment: "Отдел",
    orgNewDepartment: "Новый отдел",
    orgCreateDepartment: "Создать отдел",
    orgDepartmentName: "Название",
    orgNameRequired: "Введите название",
    orgDepartmentCreated: "Отдел «{name}» создан",
    orgPickDepartment: "Выберите отдел",
    orgPickDepartmentHint: "Слева — отделы пространства. Или создайте новый.",
    orgMembersField: "Сотрудники",
    orgFindPerson: "Найти человека",
    orgPrimaryToggle: "Основной отдел",
    orgPrimaryToggleOn:
      "Отдел станет основным: из прежнего основного люди уйдут",
    orgPrimaryToggleOff: "Отдел добавится дополнительным, основной не изменится",
    orgLeadNeedsMembers: "Сначала выберите сотрудников",
    orgLeadOutside: "{name} · не в отделе",
    orgLeadJoins: "Руководитель войдёт в отдел дополнительным сотрудником.",
    orgAddMembers: "Добавить",
    orgAddMembersTitle: "Сотрудники в «{name}»",
    orgAddSelected:
      "{count, plural, =0 {Добавить} other {Добавить · #}}",
    orgMakePrimary: "Сделать основным",
    orgRemoveMember: "Убрать",
    orgMemberRemoved: "{name} больше не в отделе",
    orgMoveUp: "Выше",
    orgMoveDown: "Ниже",
    orgDeleteDepartment: "Удалить отдел",
    orgDelete: "Удалить",
    orgDeleteTitle: "Удалить отдел «{name}»?",
    orgDeleteConfirm: "Удалить отдел",
    orgDeleteMoveTo:
      "Куда перевести {count, plural, one {# сотрудника} few {# сотрудников} many {# сотрудников} other {# сотрудника}}",
    orgDeleteChildrenTo:
      "{count, plural, one {Подотдел перейдёт} few {# подотдела перейдут} many {# подотделов перейдут} other {# подотдела перейдут}} в «{name}».",
    orgDeleteChildrenTop:
      "{count, plural, one {Подотдел станет} few {# подотдела станут} many {# подотделов станут} other {# подотдела станут}} отделами верхнего уровня.",
    orgDeleteNoneHint:
      "Основным станет самый старый дополнительный отдел человека, а без него человек останется без отдела.",
    orgDeleteAdditional: "Совместительство в этом отделе снимется.",
    orgDeleteChat: "Чат отдела останется, связь с отделом снимется.",
    orgDepartmentDeleted: "Отдел «{name}» удалён",

    orgMassTitle: "Действия с выбранными",
    orgSelected: "Выбрано: {count}",
    orgSelectAll: "Выбрать всех · {count}",
    orgAssignDepartment: "Назначить отдел",
    orgAssignPosition: "Назначить должность",
    orgChooseDepartment: "Отдел…",
    orgChoosePosition: "Должность…",
    orgAssigned:
      "{count, plural, one {Назначено # человеку} other {Назначено # людям}}",
    orgUnassignedEmpty: "Все распределены по отделам",
    orgUnassignedEmptyHint: "Новые люди без отдела появятся здесь.",

    orgNewPosition: "Новая должность",
    orgNewPositionPlaceholder: "Например, инструктор ЛФК",
    orgAddPosition: "Добавить",
    orgPositionCreated: "Должность добавлена",
    orgPositionsEmpty: "Должностей пока нет",
    orgRenamePosition: "Переименовать",
    orgDeletePositionTitle: "Удалить должность «{name}»?",
    orgDeletePositionHint:
      "{count, plural, =0 {Должность ни у кого не стоит.} one {У # человека должность снимется.} other {У # человек должность снимется.}}",
    orgPositionDeleted: "Должность удалена",
    orgSuggestionsTitle: "Должности из подписей профилей",
    orgSuggestionsHint:
      "Люди сами пишут подпись в профиле. Отметьте те, что стоит сделать должностями.",
    orgSuggestionsAssign: "Назначить должность людям с этой подписью",
    orgSuggestionsCreate:
      "{count, plural, =0 {Создать должности} other {Создать должности · #}}",
    orgPositionsCreated:
      "{count, plural, one {Создана # должность} few {Созданы # должности} many {Созданы # должностей} other {Созданы # должности}}",

    requestAudienceDepartment: "Отдел",
    requestAudiencePosition: "Должность",
    requestDepartmentMeta: "со всеми вложенными · {count} чел.",
    requestInChat: "в этом чате: {count}",

    orgMentionDepartments: "Отделы",
    orgMentionPeople: "Люди",
    orgMentionInChat:
      "{count, plural, one {# человек} few {# человека} many {# человек} other {# человека}} из отдела в этом чате",
    orgMentionNote: "{text} · видно только вам",

    memberPermissionsTitle: "Права участника",
    memberPermissionNeedsOwn:
      "Выдать или снять это право может владелец или администратор, у которого оно есть.",
    permissionOrgManageHint:
      "Ведёт отделы, должности и состав. Роли и права людей не меняет.",
    permissionRequestsAddressGroupsHint:
      "Отправляет запрос целому отделу или всем с одной должностью.",

    orgErrorNameTaken: "Такое название уже есть",
    orgErrorCycle: "Отдел нельзя вложить в его же подотдел",
    orgErrorDepth: "Больше 8 уровней вложенности нельзя",
    orgErrorLimit: "Достигнут предел оргструктуры",
    orgErrorConflict:
      "Оргструктуру только что изменили. Проверьте и повторите",
    orgErrorDepartmentGone: "Отдела больше нет",
    orgErrorPositionGone: "Должности больше нет",
    orgErrorChatExists: "У отдела уже есть чат или этот чат занят другим отделом",
    orgErrorChatInvalid:
      "Подойдёт только группа не в архиве, где вы владелец или администратор",
    orgErrorInvalid: "Проверьте поля",
    orgErrorForbidden: "Недостаточно прав",
    orgErrorUnavailable: "Сервер пока не поддерживает оргструктуру",
  },
  {
    orgStructure: "Org structure",
    orgSettingsHint: "Departments, leads, positions and who works where",
    orgSection: "Org structure",
    orgDepartment: "Department",
    orgPosition: "Position",
    orgNoPosition: "No position",
    orgNoDepartment: "No department",
    orgTopLevel: "top level",
    orgLead: "Lead",
    orgNoLead: "No lead",
    orgPartOf: "part of",
    orgPartOfField: "Part of",
    orgMarkLead: "lead",
    orgMarkAdditional: "also",
    orgPeopleCount: "{count, plural, one {# person} other {# people}}",
    orgPeopleShort: "{count} ppl",
    orgMembers: "People · {count}",
    orgMembersEmpty: "No one in the department yet",
    orgSubdepartments: "Subdepartments · {count}",
    orgSubordinates: "Reports · {count}",
    orgShowAll: "All",
    orgShowLess: "Show less",
    orgDepartmentCaption: "department",
    orgAdditionalCaption: "also works here",
    orgManagerCaption: "manager",
    orgEdit: "Edit",
    orgEditPerson: "Department and position",
    orgEditPersonTitle: "Department and position: {name}",
    orgDepartmentMenu: "Department actions",
    orgDepartmentGone: "The department is gone",
    orgDepartmentGoneHint: "It was deleted or moved. Go back to the list.",
    orgOpenDepartment: "Open {name}",
    orgFold: "Collapse {name}",
    orgUnfold: "Expand {name}",

    orgViewLabel: "List view",
    orgViewList: "List",
    orgViewGroups: "By department",
    orgViewTree: "Structure",
    orgMembersLead:
      "{humans, plural, one {# person} other {# people}} · {departments, plural, one {# department} other {# departments}}",
    orgMembersSearch: "Name, position or department",
    orgTreeSearch: "Find a department or a person",
    orgTreeLabel: "{name} org structure",
    orgTreeItemLabel: "{name}, {count} people",
    orgTreeNothingFound: "Nothing found",
    orgGroupsEmpty: "No one here",
    orgGroupsEmptyHint: "Pick another department or All.",
    orgAgentsGroup: "Agents",
    orgAgentsGroupHint: "Not part of departments",

    orgChatOpen: "Department chat",
    orgChatCreate: "Create department chat",
    orgChatNotMember:
      "The department has a chat, but you are not in it. Ask the department lead to add you.",
    orgChatArchived: "The department chat is archived",
    orgChatMissing:
      "{count, plural, one {# person} other {# people}} of the department not in the chat",
    orgChatAddMissing: "Add",
    orgChatAdded:
      "{count, plural, =0 {Everyone is already in the chat} one {# person added} other {# people added}}",
    orgChatLink: "Link a chat",
    orgChatUnlink: "Unlink the chat",
    orgChatLinked: "Chat linked to the department",
    orgChatUnlinked: "Chat unlinked. The chat and its members stay",
    orgChatLinkTitle: "Chat for {name}",
    orgChatLinkHint:
      "Any group you own or administer. Its members stay as they are.",
    orgChatLinkSearch: "Find a group",
    orgChatLinkAction: "Link",
    orgChatLinkEmpty: "No suitable groups",

    orgPrimaryDepartment: "Primary department",
    orgAdditionalDepartments: "Also works in",
    orgAdditionalNeedsPrimary:
      "Choose the primary department first, then additional ones.",
    orgAdditionalFootnote:
      "People in several departments: add an additional department in the person's card or in the department's people.",

    orgTabDepartments: "Departments",
    orgTabPositions: "Positions",
    orgTabUnassigned: "No department · {count}",
    orgEmptyTitle: "Create the first department",
    orgEmptyHint:
      "Departments show up in Members, in people's cards and in @ suggestions.",
    orgAddDepartment: "Department",
    orgNewDepartment: "New department",
    orgCreateDepartment: "Create department",
    orgDepartmentName: "Name",
    orgNameRequired: "Enter a name",
    orgDepartmentCreated: "{name} created",
    orgPickDepartment: "Pick a department",
    orgPickDepartmentHint: "Departments of the workspace are on the left. Or create one.",
    orgMembersField: "People",
    orgFindPerson: "Find a person",
    orgPrimaryToggle: "Primary department",
    orgPrimaryToggleOn:
      "It becomes their primary department: they leave the previous one",
    orgPrimaryToggleOff:
      "It is added as an additional department; the primary one stays",
    orgLeadNeedsMembers: "Choose people first",
    orgLeadOutside: "{name} · not in the department",
    orgLeadJoins: "The lead joins the department as an additional member.",
    orgAddMembers: "Add",
    orgAddMembersTitle: "People in {name}",
    orgAddSelected: "{count, plural, =0 {Add} other {Add · #}}",
    orgMakePrimary: "Make primary",
    orgRemoveMember: "Remove",
    orgMemberRemoved: "{name} left the department",
    orgMoveUp: "Move up",
    orgMoveDown: "Move down",
    orgDeleteDepartment: "Delete department",
    orgDelete: "Delete",
    orgDeleteTitle: "Delete {name}?",
    orgDeleteConfirm: "Delete department",
    orgDeleteMoveTo:
      "Where {count, plural, one {# person goes} other {# people go}}",
    orgDeleteChildrenTo:
      "{count, plural, one {The subdepartment moves} other {# subdepartments move}} to {name}.",
    orgDeleteChildrenTop:
      "{count, plural, one {The subdepartment becomes} other {# subdepartments become}} top level.",
    orgDeleteNoneHint:
      "A person's oldest additional department becomes primary; without one they stay without a department.",
    orgDeleteAdditional: "Additional memberships in this department end.",
    orgDeleteChat: "The department chat stays; it is no longer linked.",
    orgDepartmentDeleted: "{name} deleted",

    orgMassTitle: "Actions with the selected people",
    orgSelected: "Selected: {count}",
    orgSelectAll: "Select all · {count}",
    orgAssignDepartment: "Set department",
    orgAssignPosition: "Set position",
    orgChooseDepartment: "Department…",
    orgChoosePosition: "Position…",
    orgAssigned: "{count, plural, one {Set for # person} other {Set for # people}}",
    orgUnassignedEmpty: "Everyone has a department",
    orgUnassignedEmptyHint: "New people without a department show up here.",

    orgNewPosition: "New position",
    orgNewPositionPlaceholder: "For example, physical therapist",
    orgAddPosition: "Add",
    orgPositionCreated: "Position added",
    orgPositionsEmpty: "No positions yet",
    orgRenamePosition: "Rename",
    orgDeletePositionTitle: "Delete {name}?",
    orgDeletePositionHint:
      "{count, plural, =0 {Nobody has this position.} one {# person loses the position.} other {# people lose the position.}}",
    orgPositionDeleted: "Position deleted",
    orgSuggestionsTitle: "Positions from profile captions",
    orgSuggestionsHint:
      "People write their own caption in the profile. Check the ones that should become positions.",
    orgSuggestionsAssign: "Give the position to people with this caption",
    orgSuggestionsCreate:
      "{count, plural, =0 {Create positions} other {Create positions · #}}",
    orgPositionsCreated:
      "{count, plural, one {# position created} other {# positions created}}",

    requestAudienceDepartment: "Department",
    requestAudiencePosition: "Position",
    requestDepartmentMeta: "with subdepartments · {count} ppl",
    requestInChat: "in this chat: {count}",

    orgMentionDepartments: "Departments",
    orgMentionPeople: "People",
    orgMentionInChat:
      "{count, plural, one {# person} other {# people}} of the department in this chat",
    orgMentionNote: "{text} · only you see this",

    memberPermissionsTitle: "Member permissions",
    memberPermissionNeedsOwn:
      "Only the owner or an administrator who holds this permission can change it.",
    permissionOrgManageHint:
      "Manages departments, positions and people in them. Does not change roles or permissions.",
    permissionRequestsAddressGroupsHint:
      "Sends a request to a whole department or everyone with a position.",

    orgErrorNameTaken: "This name is already taken",
    orgErrorCycle: "A department cannot go under its own subdepartment",
    orgErrorDepth: "No more than 8 levels of nesting",
    orgErrorLimit: "The org structure limit is reached",
    orgErrorConflict: "The structure just changed. Check and try again",
    orgErrorDepartmentGone: "The department is gone",
    orgErrorPositionGone: "The position is gone",
    orgErrorChatExists:
      "The department already has a chat, or this chat belongs to another department",
    orgErrorChatInvalid:
      "Only a group that is not archived and that you own or administer",
    orgErrorInvalid: "Check the fields",
    orgErrorForbidden: "Not enough permissions",
    orgErrorUnavailable: "The server does not support the org structure yet",
  },
);
