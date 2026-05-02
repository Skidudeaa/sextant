import Foundation

/// Networking service protocol with associated request/response types.
protocol Service {
  associatedtype Request
  associatedtype Response

  func perform(_ request: Request) async throws -> Response
}

/// HTTP-specific Service conformer.
class HTTPService: Service {
  typealias Request = URLRequest
  typealias Response = Data

  func perform(_ request: URLRequest) async throws -> Data {
    return Data()
  }
}
