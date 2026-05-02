import React from "react";

// React-side View component. Intentional name collision with the Swift
// `protocol View`. mixed-003 ("View protocol") must rank the Swift protocol
// definition above this React component.
export const View: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return <div className="view-container">{children}</div>;
};
