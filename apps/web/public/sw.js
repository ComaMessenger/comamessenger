// Addresses a notification may open: chats, a message in a chat (with the
// reminder to close), «Важные», the scheduled list, settings and a person
// («Вы замещаете …»: /people/{id} is the person's card, /members/{id} on
// the web). Anything else falls back to the chat or the chat list.
const allowedPath =
  /^\/(chats|chat\/[0-9a-f-]+(\/thread\/[0-9a-f-]+)?|important|scheduled|threads|members\/[0-9a-f-]+|settings(\/[a-z-]+)*)(\?[A-Za-z0-9=&%._-]*)?$/;
const personPath = /^\/people\/([0-9a-f-]+)$/;

function notificationURL(payload) {
  if (typeof payload.url === "string") {
    const person = personPath.exec(payload.url);
    if (person) return `/members/${person[1]}`;
    if (allowedPath.test(payload.url)) return payload.url;
  }
  if (payload.kind === "reminder" && !payload.chat_id)
    return "/important?tab=reminders";
  return payload.chat_id ? `/chat/${payload.chat_id}` : "/chats";
}

self.addEventListener("push", (event) => {
  const payload = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(payload.title || "Coma", {
      body: payload.body || "New message",
      icon: "/notification-icon.png",
      badge: "/notification-badge.png",
      // The server names a tag for notifications that replace each other
      // (scheduled messages that failed); otherwise one per chat.
      tag:
        payload.tag || (payload.chat_id ? `chat:${payload.chat_id}` : "coma"),
      // "Without sound": shown as usual, no sound or vibration.
      silent: payload.silent === true,
      data: { url: notificationURL(payload) },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) => {
        const url = event.notification.data?.url || "/chats";
        for (const client of windows) {
          if ("focus" in client) {
            client.navigate(url);
            return client.focus();
          }
        }
        return clients.openWindow(url);
      }),
  );
});
