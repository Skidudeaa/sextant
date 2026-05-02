import SwiftUI

// Collides with frontend/src/views/View.tsx — mixed-003 expects this Swift
// protocol definition to rank #1 for "View protocol" (multi-token query
// disambiguates from React's View component).
protocol View {
  associatedtype Body
  var body: Body { get }
}

extension View {
  func toolbar() -> some View {
    return self
  }
}
