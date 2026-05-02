import SwiftUI
import Foundation

// Swift-side PatientStore. Intentionally collides with the TS PatientStore
// in frontend/src/PatientStore.ts so mixed-001 can verify cross-language
// ranking doesn't unfairly favor either language.
class PatientStore: ObservableObject {
  @Published var patients: [Patient] = []

  func update(id: UUID) {}
  func update(patient: Patient) {}
}
