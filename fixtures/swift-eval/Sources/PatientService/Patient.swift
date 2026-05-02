import Foundation

/// A patient record with stable identity for SwiftUI list rendering.
struct Patient: Identifiable, Codable {
  let id: UUID
  var name: String
  var notes: String
}
