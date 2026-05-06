// WHY: Defines the canonical User schema for the fixture. Imported via the
// NodeNext convention `import { User } from "./schemas.js"` — file is .ts on
// disk, the .js in the specifier refers to the compiled output.
export interface User {
  id: string;
  email: string;
  createdAt: Date;
}

export interface Session {
  userId: string;
  token: string;
  expiresAt: Date;
}

export function isExpired(session: Session): boolean {
  return session.expiresAt.getTime() < Date.now();
}
