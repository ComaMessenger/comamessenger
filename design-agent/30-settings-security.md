# Настройки: безопасность

Маршрут `/settings/security`. Также принудительно заменяет любой authenticated экран, если `must_change_password=true`.

Секция Change email: текущий email в description, New email и Current password, submit. Успех либо сразу изменяет адрес, либо сообщает об отправке подтверждения.

Change password: Current password, New password, Confirm; mismatch inline; minimum 10. При обязательной смене особый notice/hint и нельзя уйти в остальные разделы до успеха.

Active sessions показывается, когда смена не обязательна: список устройств с человекочитаемым UA label, IP, current badge; Revoke у чужих сессий; отдельный Logout other devices. Текущую сессию нельзя отозвать тем же рядовым действием.

Состояния: pending по каждой форме/строке, email confirmation, password success, session revoked, server error, unknown device/IP, единственная сессия. Security errors никогда не исчезают только в toast.
