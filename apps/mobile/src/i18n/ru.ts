export const ru = {
  // Server
  serverTitle: "Подключение",
  serverLead:
    "Укажите адрес пространства Coma — его выдаёт администратор. Можно вставить ссылку-приглашение целиком.",
  serverAddress: "Адрес сервера",
  serverPlaceholder: "chat.company.ru",
  serverInvalid: "Проверьте адрес: нужен вид chat.company.ru или https://…",
  serverUnreachable:
    "Сервер не отвечает. Проверьте адрес и подключение к интернету.",
  continue: "Продолжить",
  changeServer: "Сменить сервер",
  offlineTitle: "Нет соединения с сервером",
  offlineText:
    "Не получилось связаться с {server}. Проверьте интернет и попробуйте ещё раз.",

  // Sign in
  signIn: "Вход",
  workspaceLead: "{workspace} · рабочее пространство Coma",
  loginLead: "Введите данные рабочего аккаунта",
  email: "Email",
  password: "Пароль",
  showPassword: "Показать пароль",
  hidePassword: "Скрыть пароль",
  forgotPassword: "Забыли пароль?",
  loginFailedTitle: "Неверный email или пароль",
  loginFailedHint: "Проверьте раскладку и попробуйте ещё раз.",
  noServerConnection: "Нет соединения с сервером",
  retry: "Повторить",

  // Recovery
  recoveryLead: "Отправим ссылку для смены пароля на рабочий email.",
  sendRecoveryLink: "Отправить ссылку",
  sending: "Отправляем…",
  recoverySentTitle: "Если адрес зарегистрирован, письмо уже в пути",
  recoverySentHint: "Ссылка действует 60 минут. Проверьте папку «Спам».",
  recoverySendAgain: "Отправить ещё раз",
  backToLoginShort: "Назад ко входу",
  recoveryUnavailableTitle: "Обратитесь к администратору",
  recoveryUnavailableText:
    "В этом пространстве восстановление по email отключено. Администратор сбросит пароль вручную и передаст вам новый.",

  // Invitation
  joinTitle: "Присоединиться",
  displayName: "Отображаемое имя",
  handle: "Handle",
  joinHandleHint: "Так вас будут упоминать: @{handle}",
  joinHandleTaken: "Handle уже занят",
  passwordMinimumHint: "Минимум {minimum} символов",
  accept: "Принять приглашение",
  invitationInvalidTitle: "Приглашение недействительно",
  invitationInvalidText:
    "Срок действия истёк или ссылку отозвал администратор. Попросите пригласившего отправить новое.",
  goToLogin: "Перейти ко входу",

  // Errors
  error: "Что-то пошло не так",
  errorNetwork: "Не удалось связаться с сервером",
  errorUnauthorized: "Сессия истекла — войдите снова",
  errorForbidden: "Недостаточно прав для этого действия",
  errorConflict: "Данные уже изменились. Обновите экран и повторите",
  errorValidation: "Проверьте заполненные поля",

  // Shell
  tabChats: "Чаты",
  tabMore: "Ещё",
  realtimeConnecting: "Подключение…",
  realtimeReconnecting: "Нет сети, переподключаемся…",

  // Chats
  searchChats: "Поиск чатов",
  filterAll: "Все",
  filterDirect: "Личные",
  filterGroups: "Групповые",
  filterChannels: "Каналы",
  directChat: "Личный чат",
  previewYou: "Вы",
  previewDeleted: "Сообщение удалено",
  previewAttachment: "Вложение",
  yesterday: "вчера",
  muted: "Уведомления выключены",
  unreadCount:
    "{count, plural, one {# непрочитанное} few {# непрочитанных} many {# непрочитанных} other {# непрочитанного}}",
  noChats: "Здесь пока пусто",
  noChatsHint: "Когда вас добавят в чат или напишут лично, он появится здесь.",
  noChatsFound: "Ничего не нашлось",
  chatsLoadFailed: "Не удалось загрузить чаты",

  // Conversation
  back: "Назад",
  noMessages: "Сообщений пока нет",
  conversationPreviewNote:
    "Отправка сообщений появится в следующей версии приложения.",

  // More
  passwordChangeTitle: "Смените пароль",
  passwordChangeText:
    "Администратор попросил сменить пароль. Сделайте это в веб-версии, затем вернитесь в приложение.",
  checkAgain: "Проверить ещё раз",
  openWeb: "Открыть веб-версию",
  openWebHint: "Настройки пространства, агенты и администрирование",
  signOut: "Выйти",
  signOutConfirm: "Выйти из аккаунта на этом устройстве?",
  cancel: "Отмена",
  appVersion: "Coma {version}",
} as const;
