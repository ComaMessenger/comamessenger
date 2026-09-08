# Тред

Маршрут `/chat/:chatId/thread/:threadId`.

Desktop: правая панель поверх/рядом с беседой шириной до ~360 px; основная лента и composer получают отступ. Header: «Тред», количество ответов, Follow/Unfollow, Close. Ниже root message, разделитель с числом ответов и последовательность replies. MessageRow сохраняет reply, reactions, меню, delivery и agent streaming, но thread indicator внутри треда скрыт.

Внизу собственный Composer с отдельным draft, mentions, reply и readonly-состоянием канала. Отправка всегда получает `thread_root_id`; follow state видимо меняется сразу.

Mobile: панель становится fixed fullscreen, основная беседа и её composer скрываются. Header учитывает top safe area; Close выполняет роль возврата в чат. Нижняя tab bar приложения остаётся зарезервированной. Нужны loading root/replies, deleted root, empty replies, network error, streaming, failed send.

Визуально root должен явно быть контекстом, а ответы — отдельной группой; при этом не превращать тред в другой тип мессенджера.
