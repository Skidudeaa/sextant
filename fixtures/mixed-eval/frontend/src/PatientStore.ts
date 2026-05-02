import { Patient } from "./Patient";

// TS-side PatientStore. Intentional collision with Sources/Swift/PatientStore.swift.
// mixed-001 expects both to surface; neither should dominate by >2 ranks.
export class PatientStore {
  private patients: Patient[] = [];

  update(patient: Patient): void {
    this.patients.push(patient);
  }
}
