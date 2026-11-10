import CryptoKit
import Foundation
import Security
import UserNotifications

/// Replaces the relay's neutral text with the content the instance encrypted
/// for this device (docs/decisions/0012-mobile-push-relay.md). When the key
/// is missing or decryption fails, the fallback text is shown unchanged.
class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var bestAttempt: UNMutableNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    let content = (request.content.mutableCopy() as? UNMutableNotificationContent)
      ?? UNMutableNotificationContent()
    bestAttempt = content
    if let sealed = request.content.userInfo["c"] as? String,
       let payload = Self.open(sealed) {
      if let title = payload["title"] as? String { content.title = title }
      if let body = payload["body"] as? String { content.body = body }
      if let url = payload["url"] as? String, url.hasPrefix("/chat/") {
        content.userInfo["url"] = url
      }
      if let chatID = payload["chat_id"] as? String { content.threadIdentifier = chatID }
      if let badge = payload["badge"] as? Int, badge >= 0 { content.badge = NSNumber(value: badge) }
    }
    content.userInfo.removeValue(forKey: "c")
    contentHandler(content)
  }

  override func serviceExtensionTimeWillExpire() {
    if let handler = contentHandler, let content = bestAttempt { handler(content) }
  }

  /// Same keychain item the app writes with expo-secure-store.
  private static func notificationKey() -> SymmetricKey? {
    guard let bundleID = Bundle.main.bundleIdentifier else { return nil }
    let appBundleID = bundleID.replacingOccurrences(of: ".notification-service", with: "")
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "coma.push",
      kSecAttrAccount as String: "notification_key",
      kSecAttrAccessGroup as String: "group.\(appBundleID)",
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data,
          let encoded = String(data: data, encoding: .utf8),
          let raw = Data(base64Encoded: encoded), raw.count == 32
    else { return nil }
    return SymmetricKey(data: raw)
  }

  /// Opens base64(nonce ‖ ciphertext ‖ tag), AES-256-GCM.
  private static func open(_ sealed: String) -> [String: Any]? {
    guard let key = notificationKey(),
          let combined = Data(base64Encoded: sealed),
          let box = try? AES.GCM.SealedBox(combined: combined),
          let plaintext = try? AES.GCM.open(box, using: key),
          let payload = try? JSONSerialization.jsonObject(with: plaintext) as? [String: Any],
          payload["v"] as? Int == 1
    else { return nil }
    return payload
  }
}
