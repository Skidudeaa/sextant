// TS-side Auth interface. Intentional collision with Sources/Swift/Auth.swift.
// mixed-005 (no bias) expects both this and the Swift file in top 5.
export interface Auth {
  authenticate(): Promise<void>;
  readonly userId: string;
}
