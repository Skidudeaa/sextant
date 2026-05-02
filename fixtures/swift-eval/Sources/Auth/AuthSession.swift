import Foundation

/// Session actor with two designated initializers.
actor AuthSession {
  let userId: String

  init(user: String) {
    self.userId = user
  }

  init(token: String, refresh: Bool) {
    self.userId = token
  }

  func refresh() async {}
}
