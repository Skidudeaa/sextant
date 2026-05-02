import Foundation

/// Severity levels emitted by the logger.
enum LogLevel {
  case debug
  case info
  case warning
  case error(String)

  var prefix: String {
    switch self {
    case .debug: return "[DEBUG]"
    case .info: return "[INFO]"
    case .warning: return "[WARN]"
    case .error: return "[ERROR]"
    }
  }
}
