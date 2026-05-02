import Foundation

struct Patient: Identifiable, Codable {
  let id: UUID
  var name: String
  var dateOfBirth: Date
}
