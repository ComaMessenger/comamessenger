self.addEventListener("push", (event) => {
  const payload = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(payload.title || "Coma", {
      body: payload.body || "New message",
      icon: "/coma-logo.svg",
      badge: "/coma-logo.svg",
      tag: payload.chat_id ? `chat:${payload.chat_id}` : "coma",
      data: {
        url:
          payload.url ||
          (payload.chat_id ? `/chat/${payload.chat_id}` : "/chats"),
      },
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
