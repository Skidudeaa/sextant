import SwiftUI

/// Minimal SwiftUI-style View protocol with a primary-associated Body type.
protocol View {
  associatedtype Body
  var body: Body { get }
}

/// SwiftUI-style View+Toolbar composition helpers.
extension View {
  func toolbar() -> some View {
    return self
  }

  func navigationTitle(_ title: String) -> some View {
    return self
  }
}
