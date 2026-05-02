import Foundation

// Collides with services/python/logger.py — mixed-002 expects this Swift
// definition to rank above the Python one when the query has a .swift bias.
enum Logger {
  case debug, info, warning
  case error(String)

  func log(_ message: String) {}
}
