import Foundation
import SwiftUI

/// In-memory patient store with multiple update overloads.
class PatientStore: ObservableObject {
  // numberOfPatients PatientStore — derived count, no manual sync.
  @Published var patients: [Patient] = []

  var numberOfPatients: Int { patients.count }

  func update(id: UUID) {
    patients.removeAll { $0.id == id }
  }

  func update(patient: Patient) {
    if let i = patients.firstIndex(where: { $0.id == patient.id }) {
      patients[i] = patient
    } else {
      patients.append(patient)
    }
  }

  func update(notes: String, for id: UUID) {
    if let i = patients.firstIndex(where: { $0.id == id }) {
      patients[i].notes = notes
    }
  }
}
