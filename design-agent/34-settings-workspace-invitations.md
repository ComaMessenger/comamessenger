# Настройки пространства: приглашения

Маршрут `/settings/workspace/invitations`; доступ по `invitations.manage` либо legacy `can_create_invitations`.

Для управляющего политикой: Default role, invitation TTL, Allow member invitations switch. Далее Create invitation: Email, Role, primary CTA. После успеха result card содержит одноразовую invitation link, пояснение и Copy.

Active invitations: строки с email/ролью, creator, expiry, Rotate и Revoke. Rotate может одновременно отправить письмо; результат различается. Empty state «Активных приглашений нет».

Пользователь только с правом создавать приглашения не должен видеть policy controls, которые не может менять. Состояния: invalid email, pending create/rotate/revoke, copied, expired, SMTP unavailable, error. На mobile формы и result складываются в одну колонку, link можно выделить/скопировать без горизонтального разрыва.
