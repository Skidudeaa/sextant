import Foundation

// Collides with frontend/src/auth.ts (TypeScript Auth interface).
// mixed-005 expects both this and the TS file in top 5.
// mixed-006-swift-bias expects THIS to rank #1 when query is "Auth swift".
protocol Auth {
  func authenticate() async throws
  var userId: String { get }
}
